// functions/api/payment/ipn.js
// Production-ready Pesapal IPN handler for hotspot billing system
// ✅ btoa polyfill — safe in all CF Worker versions
// ✅ KV voucher TTL — configurable expiry (default 7 days)
// ✅ Notification queue via CF Queue (with direct fallback)
// ✅ Low-stock pre-warning alert at configurable threshold
// ✅ Atomic DB voucher assignment — no race conditions
// ✅ MikroTik comment-based sold marking
// ✅ Full idempotency + structured logging

// ─────────────────────────────────────────────────────────────
// btoa POLYFILL
// Cloudflare Workers support btoa() natively, but this polyfill
// ensures compatibility if this code ever runs in another runtime
// (e.g. Node.js edge functions, local test environments).
// ─────────────────────────────────────────────────────────────
const safeBase64Encode = (str) => {
  if (typeof btoa === 'function') return btoa(str);
  return Buffer.from(str, 'binary').toString('base64'); // Node.js fallback
};

export async function onRequestGet(context) {
  return onRequestPost(context);
}

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    const contentType = request.headers.get('content-type') || '';

    // 1️⃣ Initialize from URL parameters
    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');
    let OrderNotificationType = url.searchParams.get('OrderNotificationType');

    console.log('[IPN] URL params:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    // 2️⃣ Parse POST body
    if (contentType.includes('application/json')) {
      try {
        const body = await request.json();
        OrderTrackingId ||= body.OrderTrackingId || body.orderTrackingId || body.order_tracking_id;
        OrderMerchantReference ||= body.OrderMerchantReference || body.orderMerchantReference || body.order_merchant_reference;
        OrderNotificationType ||= body.OrderNotificationType || body.orderNotificationType || body.order_notification_type;
        console.log('[IPN DEBUG] Parsed JSON:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });
      } catch (e) {
        console.error('[IPN ERROR] JSON parse failed:', e.message);
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      try {
        const formData = await request.formData();
        OrderTrackingId ||= formData.get('OrderTrackingId');
        OrderMerchantReference ||= formData.get('OrderMerchantReference');
        OrderNotificationType ||= formData.get('OrderNotificationType');
        console.log('[IPN DEBUG] Parsed form:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });
      } catch (e) {
        console.error('[IPN ERROR] Form parse failed:', e.message);
      }
    } else {
      console.warn('[IPN] Unexpected content-type:', contentType);
    }

    // 3️⃣ Validate required fields
    if (!OrderTrackingId || !OrderMerchantReference) {
      console.warn('[IPN] Missing required fields:', { OrderTrackingId, OrderMerchantReference });
      return new Response('OK', { status: 200 });
    }

    console.log('[IPN] Valid notification:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    // 4️⃣ Idempotency check
    const existingTx = await env.DB.prepare(
      `SELECT id, status, voucher_id 
       FROM transactions 
       WHERE pesapal_transaction_id = ? AND status = 'COMPLETED'
       LIMIT 1`
    ).bind(OrderTrackingId).first();

    if (existingTx) {
      console.log(`[IPN] Already processed: ${OrderTrackingId}`);
      return new Response('OK', { status: 200 });
    }

    // 5️⃣ Get Pesapal token
    const token = await getPesapalToken(env);

    // 6️⃣ Fetch payment status
    const pStatus = await fetchPesapalStatus(OrderTrackingId, token);
    if (!['COMPLETED', 'SUCCESS', 'COMPLETE'].includes(pStatus)) {
      console.log(`[IPN] Payment not completed: ${pStatus}`);
      return new Response('OK', { status: 200 });
    }

    // 7️⃣ Fetch transaction
    const tx = await env.DB.prepare(
      `SELECT id, tracking_id, package_type, status, email, phone_number
       FROM transactions
       WHERE tracking_id = ?
       LIMIT 1`
    ).bind(OrderMerchantReference).first();

    if (!tx) {
      console.warn(`[IPN] Transaction not found: ${OrderMerchantReference}`);
      return new Response('OK', { status: 200 });
    }
    if (tx.status === 'COMPLETED') {
      console.log(`[IPN] Transaction already completed: ${OrderMerchantReference}`);
      return new Response('OK', { status: 200 });
    }

    // 8️⃣ Assign voucher — reserved first, then atomic fallback
    let voucher = await env.DB.prepare(
      `SELECT id, code FROM vouchers 
       WHERE transaction_id = ? AND status = 'reserved'
       LIMIT 1`
    ).bind(OrderMerchantReference).first();

    if (voucher) {
      await env.DB.prepare(`UPDATE vouchers SET status = 'assigned' WHERE id = ?`)
        .bind(voucher.id).run();
      console.log(`[IPN] Reserved voucher activated: ${voucher.code}`);
    } else {
      console.warn(`[IPN] No reserved voucher, attempting atomic assignment...`);
      voucher = await retryVoucherAssignment(env, OrderMerchantReference, tx.package_type);

      if (!voucher) {
        console.error(`[IPN] VOUCHER_DEPLETED for package ${tx.package_type}`);
        await sendAlert(env, {
          type: 'VOUCHER_DEPLETED',
          package: tx.package_type,
          transaction: OrderMerchantReference,
          timestamp: new Date().toISOString()
        });
        return new Response('OK', { status: 200 });
      }
    }

    // 9️⃣ Update transaction in DB
    await env.DB.prepare(
      `UPDATE transactions
       SET status = 'COMPLETED',
           pesapal_transaction_id = ?,
           voucher_id = ?,
           completed_at = CURRENT_TIMESTAMP
       WHERE tracking_id = ?`
    ).bind(OrderTrackingId, voucher.id, OrderMerchantReference).run();

    // 🔟 Save voucher to KV with configurable TTL
    // ─────────────────────────────────────────────────────────
    // VOUCHER_KV_TTL_SECONDS (env var):
    //   How long the voucher entry lives in KV before auto-expiry.
    //   Default: 604800 (7 days). Set to 0 to disable TTL (permanent).
    //   Tip: match your longest package duration + a grace buffer.
    //   e.g. 1-day package → VOUCHER_KV_TTL_SECONDS=90000 (25hrs)
    // ─────────────────────────────────────────────────────────
    try {
      const kvTtl = parseInt(env.VOUCHER_KV_TTL_SECONDS || '604800', 10);
      const kvOptions = kvTtl > 0 ? { expirationTtl: kvTtl } : {};

      await env.KV.put(voucher.code, JSON.stringify({
        package: tx.package_type,
        paid: true,
        used: false,
        paidAt: new Date().toISOString(),
        transaction: OrderMerchantReference,
        email: tx.email,
        phone: tx.phone_number
      }), kvOptions);

      console.log(`[IPN] Voucher ${voucher.code} saved to KV (TTL: ${kvTtl > 0 ? kvTtl + 's' : 'permanent'})`);
    } catch (kvError) {
      console.error('[IPN] KV save failed:', kvError.message);
      // Non-fatal: voucher is still safely in DB
    }

    // 1️⃣1️⃣ Mark voucher as sold on MikroTik
    // Updates comment: unused → sold-<ISO timestamp>
    // Non-fatal if router is unreachable — DB lock already prevents double-assign
    try {
      await markVoucherSoldOnMikroTik(env, voucher.code);
    } catch (mkErr) {
      console.error('[MIKROTIK] Failed to mark sold:', mkErr.message);
    }

    // 1️⃣2️⃣ Check remaining voucher stock — send pre-warning if running low
    // ─────────────────────────────────────────────────────────
    // VOUCHER_LOW_STOCK_THRESHOLD (env var):
    //   Alert when unused stock drops to or below this number.
    //   Default: 5. Alerts are suppressed for 1hr after firing
    //   to prevent spam (via KV flag).
    // ─────────────────────────────────────────────────────────
    checkVoucherStock(env, tx.package_type).catch(e =>
      console.error('[STOCK CHECK]', e.message)
    );

    console.log(`[IPN SUCCESS] Voucher ${voucher.code} → ${OrderMerchantReference}`);

    // 1️⃣3️⃣ Notify customer
    // ─────────────────────────────────────────────────────────
    // If NOTIFY_QUEUE (CF Queue binding) is configured, notifications
    // are enqueued and processed by the onQueue() consumer below.
    // This decouples notifications from the payment request lifecycle,
    // prevents email/SMS spikes under concurrent load, and allows
    // automatic retries on failure (up to 3 attempts per message).
    //
    // If no queue is configured, notifications are sent directly
    // (async, non-blocking) as a simpler fallback.
    //
    // To enable queueing, add to wrangler.toml:
    //   [[queues.producers]]
    //   binding = "NOTIFY_QUEUE"
    //   queue = "notify-queue"
    // ─────────────────────────────────────────────────────────
    const notifyPayload = {
      email: tx.email,
      phone: tx.phone_number,
      voucherCode: voucher.code,
      packageType: tx.package_type
    };

    if (env.NOTIFY_QUEUE) {
      try {
        await env.NOTIFY_QUEUE.send(notifyPayload);
        console.log('[NOTIFY] Notification enqueued');
      } catch (qErr) {
        console.warn('[NOTIFY] Queue failed, falling back to direct send:', qErr.message);
        notifyCustomer(env, notifyPayload).catch(e => console.error('[NOTIFY ERROR]', e));
      }
    } else {
      notifyCustomer(env, notifyPayload).catch(e => console.error('[NOTIFY ERROR]', e));
    }

    // 1️⃣4️⃣ ACK to Pesapal
    return new Response(JSON.stringify({
      status: 200,
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      notificationType: OrderNotificationType,
      paymentStatus: pStatus,
      voucherAssigned: true
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[IPN ERROR] Critical:', err.message, err.stack);
    try {
      await logError(env, { error: err.message, stack: err.stack, timestamp: new Date().toISOString() });
    } catch (_) {}
    return new Response('OK', { status: 200 });
  }
}

// ─────────────────────────────────────────────────────────────
// QUEUE CONSUMER
// Export this to handle queued notifications.
// Add to wrangler.toml:
//   [[queues.consumers]]
//   queue = "notify-queue"
//   max_batch_size = 10
//   max_retries = 3
// ─────────────────────────────────────────────────────────────
export async function onQueue(batch, env) {
  for (const msg of batch.messages) {
    try {
      await notifyCustomer(env, msg.body);
      msg.ack();
    } catch (err) {
      console.error('[QUEUE CONSUMER] Notification failed, retrying:', err.message);
      msg.retry();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// MIKROTIK HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Mark a hotspot voucher as sold on MikroTik via REST API.
 *
 * Uses safeBase64Encode() instead of raw btoa() for runtime portability.
 * Required env vars: MIKROTIK_API_URL, MIKROTIK_USER, MIKROTIK_PASS
 * Example MIKROTIK_API_URL: https://192.168.88.1/rest
 */
async function markVoucherSoldOnMikroTik(env, voucherCode) {
  if (!env.MIKROTIK_API_URL || !env.MIKROTIK_USER || !env.MIKROTIK_PASS) {
    console.warn('[MIKROTIK] Credentials not configured, skipping router update');
    return;
  }

  const authHeader = 'Basic ' + safeBase64Encode(`${env.MIKROTIK_USER}:${env.MIKROTIK_PASS}`);

  // Step 1: Find voucher's internal .id by name
  const searchRes = await fetch(
    `${env.MIKROTIK_API_URL}/ip/hotspot/user?name=${encodeURIComponent(voucherCode)}`,
    { headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' } }
  );
  if (!searchRes.ok) {
    throw new Error(`MikroTik search failed (${searchRes.status}): ${await searchRes.text()}`);
  }
  const users = await searchRes.json();
  if (!users || users.length === 0) {
    throw new Error(`Voucher ${voucherCode} not found on MikroTik`);
  }

  // Step 2: Update comment to sold-<timestamp>
  const mikrotikId = users[0]['.id'];
  const updateRes = await fetch(
    `${env.MIKROTIK_API_URL}/ip/hotspot/user/${mikrotikId}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: `sold-${new Date().toISOString()}` })
    }
  );
  if (!updateRes.ok) {
    throw new Error(`MikroTik update failed (${updateRes.status}): ${await updateRes.text()}`);
  }

  console.log(`[MIKROTIK] Voucher ${voucherCode} marked as sold`);
}

// ─────────────────────────────────────────────────────────────
// PESAPAL HELPERS
// ─────────────────────────────────────────────────────────────

async function getPesapalToken(env) {
  if (env.KV) {
    try {
      const cached = await env.KV.get('pesapal_token', 'json');
      if (cached && cached.expiry > Date.now()) {
        console.log('[TOKEN] Using cached token');
        return cached.token;
      }
    } catch {}
  }

  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ consumer_key: env.PESAPAL_KEY, consumer_secret: env.PESAPAL_SECRET })
  });
  if (!res.ok) throw new Error(`Pesapal auth failed: ${res.status}`);

  const data = await res.json();
  if (!data.token) throw new Error('Pesapal token missing');

  if (env.KV) {
    try {
      await env.KV.put('pesapal_token', JSON.stringify({
        token: data.token,
        expiry: Date.now() + 50 * 60 * 1000
      }), { expirationTtl: 3600 });
    } catch {}
  }

  return data.token;
}

async function fetchPesapalStatus(orderTrackingId, token, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(
        `https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: controller.signal
        }
      );
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`Pesapal returned ${res.status}`);
      const data = await res.json();
      const status = (data.payment_status_description || 'PENDING').toUpperCase();
      console.log(`[Pesapal] Status: ${status} (attempt ${attempt})`);
      return status;
    } catch (err) {
      console.warn(`[Pesapal Retry ${attempt}/${retries}] ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, attempt * 500));
    }
  }

  console.error('[Pesapal] All retries exhausted → PENDING');
  return 'PENDING';
}

// ─────────────────────────────────────────────────────────────
// VOUCHER HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Atomically grab an unused voucher using UPDATE...WHERE id=(SELECT...)...RETURNING.
 * This single-statement approach eliminates the SELECT-then-UPDATE race condition.
 */
async function retryVoucherAssignment(env, OrderMerchantReference, packageType, maxRetries = 6) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const voucher = await env.DB.prepare(
        `UPDATE vouchers
         SET status = 'assigned',
             transaction_id = ?,
             used_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM vouchers
           WHERE package_type = ? AND status = 'unused'
           ORDER BY id
           LIMIT 1
         )
         RETURNING id, code`
      ).bind(OrderMerchantReference, packageType).first();

      if (voucher) {
        console.log(`[VOUCHER] Assigned on attempt ${attempt}: ${voucher.code}`);
        return voucher;
      }
    } catch (dbErr) {
      console.warn(`[VOUCHER DB BUSY] Attempt ${attempt}/${maxRetries}: ${dbErr.message}`);
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

/**
 * Count remaining unused vouchers for a package and fire a low-stock alert
 * if at or below VOUCHER_LOW_STOCK_THRESHOLD. A KV flag suppresses repeat
 * alerts for 1 hour so you don't get spammed on every purchase.
 */
async function checkVoucherStock(env, packageType) {
  const threshold = parseInt(env.VOUCHER_LOW_STOCK_THRESHOLD || '5', 10);
  const result = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM vouchers WHERE package_type = ? AND status = 'unused'`
  ).bind(packageType).first();

  const remaining = result?.count ?? 0;
  console.log(`[STOCK] ${packageType}: ${remaining} unused vouchers`);

  if (remaining <= threshold) {
    const alertKey = `low_stock_alerted:${packageType}`;
    try {
      const alreadyAlerted = await env.KV.get(alertKey);
      if (!alreadyAlerted) {
        await sendAlert(env, {
          type: 'VOUCHER_LOW_STOCK',
          package: packageType,
          remaining,
          threshold,
          timestamp: new Date().toISOString()
        });
        await env.KV.put(alertKey, '1', { expirationTtl: 3600 }); // suppress for 1hr
      }
    } catch {
      // KV flag unavailable — send alert anyway
      await sendAlert(env, {
        type: 'VOUCHER_LOW_STOCK',
        package: packageType,
        remaining,
        threshold,
        timestamp: new Date().toISOString()
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// NOTIFICATION HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Send voucher to customer via email (Resend) and/or SMS (Africa's Talking).
 * Accepts a single payload object — compatible with both direct calls and
 * the Queue consumer (onQueue).
 * Throws on failure so the Queue consumer can retry.
 */
async function notifyCustomer(env, { email, phone, voucherCode, packageType }) {
  if (!email && !phone) {
    console.warn('[NOTIFY] No contact info, skipping');
    return;
  }

  try {
    if (email && env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'noreply@yourdomain.com',
          to: email,
          subject: 'Your Hotspot Voucher Code',
          html: `
            <h2>Payment Successful!</h2>
            <p>Your hotspot voucher code:</p>
            <h3 style="background:#f4f4f4;padding:10px;font-family:monospace;">${voucherCode}</h3>
            <p><strong>Package:</strong> ${packageType}</p>
            <p>Connect to the hotspot and enter this code to activate your access.</p>
          `
        })
      });
      res.ok
        ? console.log('[NOTIFY] Email sent')
        : console.error('[NOTIFY] Email failed:', res.status, await res.text());
    }

    if (phone && env.SMS_API_KEY) {
      const res = await fetch(env.SMS_API_URL || 'https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: { 'apiKey': env.SMS_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: env.SMS_USERNAME || 'sandbox',
          to: phone,
          message: `Your hotspot voucher: ${voucherCode}. Package: ${packageType}. Enter this code to connect.`
        })
      });
      res.ok
        ? console.log('[NOTIFY] SMS sent')
        : console.error('[NOTIFY] SMS failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[NOTIFY] Failed:', err.message);
    throw err; // Allow Queue consumer to retry
  }
}

// ─────────────────────────────────────────────────────────────
// ALERT & LOGGING HELPERS
// ─────────────────────────────────────────────────────────────

async function sendAlert(env, alertData) {
  try {
    console.error('[ALERT]', JSON.stringify(alertData));

    if (env.SLACK_WEBHOOK_URL) {
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *${alertData.type}*`,
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: Object.entries(alertData).map(([k, v]) => `*${k}:* ${v}`).join('\n')
            }
          }]
        })
      });
    }

    if (env.ALERT_EMAIL && env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'alerts@yourdomain.com',
          to: env.ALERT_EMAIL,
          subject: `ALERT: ${alertData.type}`,
          text: JSON.stringify(alertData, null, 2)
        })
      });
    }
  } catch (err) {
    console.error('[ALERT] Failed:', err.message);
  }
}

async function logError(env, errorData) {
  if (env.LOG_API_URL && env.LOG_API_KEY) {
    await fetch(env.LOG_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.LOG_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'error', service: 'ipn-handler', ...errorData })
    });
  }
}
