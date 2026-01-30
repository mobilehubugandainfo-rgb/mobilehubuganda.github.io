// functions/api/payment/ipn.js
// Production-ready Pesapal IPN handler for hotspot billing system

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);

    // 1️⃣ Parse query parameters first, fallback to body
    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');
    let OrderNotificationType = url.searchParams.get('OrderNotificationType');

    if (!OrderTrackingId || !OrderMerchantReference || !OrderNotificationType) {
      const raw = await request.text();
      const params = new URLSearchParams(raw);
      OrderTrackingId = OrderTrackingId || params.get('OrderTrackingId');
      OrderMerchantReference = OrderMerchantReference || params.get('OrderMerchantReference');
      OrderNotificationType = OrderNotificationType || params.get('OrderNotificationType');
    }

    if (!OrderTrackingId || !OrderMerchantReference) {
      console.warn('[IPN] Missing required fields', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });
      return new Response('OK', { status: 200 }); // ACK to Pesapal
    }

    console.log('[IPN] Received:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    // 2️⃣ Idempotency check - prevent duplicate processing
    const existingTx = await env.DB.prepare(
      `SELECT id, status, voucher_id 
       FROM transactions 
       WHERE pesapal_transaction_id = ? AND status = 'COMPLETED'
       LIMIT 1`
    ).bind(OrderTrackingId).first();

    if (existingTx) {
      console.log(`[IPN] Already processed Pesapal transaction: ${OrderTrackingId}`);
      return new Response('OK', { status: 200 });
    }

    // 3️⃣ Get Pesapal token from KV cache or fetch new
    const token = await getPesapalToken(env);

    // 4️⃣ Fetch payment status with retry and timeout
    const pStatus = await fetchPesapalStatus(OrderTrackingId, token);

    // Accept multiple success status variations (COMPLETED, SUCCESS, COMPLETE)
    const successStatuses = ['COMPLETED', 'SUCCESS', 'COMPLETE'];
    const isPaymentSuccessful = successStatuses.includes(pStatus);

    if (!isPaymentSuccessful) {
      console.log(`[IPN] Payment not completed: ${pStatus} (NotificationType: ${OrderNotificationType})`);
      return new Response('OK', { status: 200 });
    }

    // 5️⃣ Fetch transaction details
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

    // 6️⃣ Atomic voucher assignment with retry logic (6 attempts, 3s intervals)
    const voucher = await retryVoucherAssignment(env, OrderMerchantReference, tx.package_type, 6);

    if (!voucher) {
      console.error(`[IPN] ⚠️ CRITICAL: No unused vouchers after 6 retries for package: ${tx.package_type}`);
      
      // Alert for voucher depletion
      await sendAlert(env, {
        type: 'VOUCHER_DEPLETED',
        package: tx.package_type,
        transaction: OrderMerchantReference,
        timestamp: new Date().toISOString()
      });

      return new Response('OK', { status: 200 });
    }

    // 7️⃣ Update transaction with voucher info
    await env.DB.prepare(
      `UPDATE transactions
       SET status = 'COMPLETED',
           pesapal_transaction_id = ?,
           voucher_id = ?,
           completed_at = CURRENT_TIMESTAMP
       WHERE tracking_id = ?`
    ).bind(OrderTrackingId, voucher.id, OrderMerchantReference).run();

    console.log(`[IPN SUCCESS] ✅ Voucher ${voucher.code} assigned to transaction ${OrderMerchantReference}`);

    // 8️⃣ Send voucher to customer (async, non-blocking)
    notifyCustomer(env, tx.email, tx.phone_number, voucher.code, tx.package_type)
      .catch(err => console.error('[NOTIFY ERROR]', err));

    // 9️⃣ Always ACK to Pesapal
    return new Response(JSON.stringify({
      status: 200,
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      notificationType: OrderNotificationType,
      paymentStatus: pStatus,
      voucherAssigned: true
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error('[IPN ERROR] ❌ Critical:', err);
    
    // Log to monitoring service if available
    try {
      await logError(env, {
        error: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString()
      });
    } catch (logErr) {
      console.error('[LOGGING ERROR]', logErr);
    }

    // Always ACK to Pesapal to prevent infinite retries
    return new Response('OK', { status: 200 });
  }
}

// ---------- Helper Functions ----------

async function getPesapalToken(env) {
  if (env.KV) {
    try {
      const cached = await env.KV.get('pesapal_token', 'json');
      if (cached && cached.expiry > Date.now()) {
        console.log('[TOKEN] Using cached token');
        return cached.token;
      }
    } catch (err) {
      console.warn('[TOKEN] KV fetch failed, fetching new token:', err);
    }
  }

  console.log('[TOKEN] Fetching new token from Pesapal');
  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Accept': 'application/json' 
    },
    body: JSON.stringify({ 
      consumer_key: env.PESAPAL_KEY, 
      consumer_secret: env.PESAPAL_SECRET 
    })
  });

  if (!res.ok) {
    throw new Error(`Pesapal auth failed: ${res.status}`);
  }

  const data = await res.json();
  if (!data.token) {
    throw new Error('Pesapal auth response missing token');
  }

  if (env.KV) {
    try {
      const expiry = Date.now() + (50 * 60 * 1000);
      await env.KV.put('pesapal_token', JSON.stringify({ 
        token: data.token, 
        expiry 
      }), {
        expirationTtl: 3600
      });
      console.log('[TOKEN] Cached new token');
    } catch (err) {
      console.warn('[TOKEN] Failed to cache token:', err);
    }
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
          headers: { 
            Authorization: `Bearer ${token}`, 
            Accept: 'application/json' 
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Pesapal API returned ${res.status}`);
      }

      const data = await res.json();
      const status = data.payment_status_description?.toUpperCase() || 'PENDING';
      
      console.log(`[Pesapal] Status fetched: ${status} (attempt ${attempt})`);
      return status;

    } catch (err) {
      console.warn(`[Pesapal Retry ${attempt}/${retries}] Failed:`, err.message);
      
      if (attempt < retries) {
        const delay = attempt * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error('[Pesapal] ❌ All retries failed, defaulting to PENDING');
  return 'PENDING';
}

async function notifyCustomer(env, email, phone, voucherCode, packageType) {
  if (!email && !phone) {
    console.warn('[NOTIFY] No contact info available');
    return;
  }

  try {
    if (email && env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'noreply@yourdomain.com',
          to: email,
          subject: 'Your Hotspot Voucher Code',
          html: `<h2>Payment Successful!</h2><p>Voucher: ${voucherCode}</p>`
        })
      });
    }
  } catch (err) {
    console.error('[NOTIFY] Failed:', err);
  }
}

async function sendAlert(env, alertData) {
  try {
    console.error('[ALERT]', JSON.stringify(alertData));
    if (env.SLACK_WEBHOOK_URL) {
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `🚨 *${alertData.type}*` })
      });
    }
  } catch (err) {
    console.error('[ALERT] Failed:', err);
  }
}

async function logError(env, errorData) {
  if (env.LOG_API_URL && env.LOG_API_KEY) {
    await fetch(env.LOG_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.LOG_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        level: 'error',
        service: 'ipn-handler',
        ...errorData
      })
    });
  }
}

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
        console.log(`[VOUCHER] Retrieved on attempt ${attempt}`);
        return voucher;
      }
    } catch (dbErr) {
      console.warn(`[VOUCHER DB BUSY] Attempt ${attempt}: ${dbErr.message}`);
    }

    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return null;
}

