// functions/api/payment/ipn.js
// Production-ready Pesapal IPN handler for mobilehubuganda hotspot billing

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
      return new Response('OK', { status: 200 }); 
    }

    console.log('[IPN] Received:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    // 2️⃣ Idempotency check
    const existingTx = await env.DB.prepare(
      `SELECT id, status FROM transactions 
       WHERE pesapal_transaction_id = ? AND status = 'COMPLETED'
       LIMIT 1`
    ).bind(OrderTrackingId).first();

    if (existingTx) {
      console.log(`[IPN] Already processed: ${OrderTrackingId}`);
      return new Response('OK', { status: 200 });
    }

    // 3️⃣ Token Management
    const token = await getPesapalToken(env);

    // 4️⃣ Fetch payment status
    const pStatus = await fetchPesapalStatus(OrderTrackingId, token);
    const successStatuses = ['COMPLETED', 'SUCCESS', 'COMPLETE'];

    if (!successStatuses.includes(pStatus)) {
      console.log(`[IPN] Payment status: ${pStatus}`);
      return new Response('OK', { status: 200 });
    }

    // 5️⃣ Find your transaction
    const tx = await env.DB.prepare(
      `SELECT id, package_type, email, phone_number FROM transactions
       WHERE tracking_id = ? LIMIT 1`
    ).bind(OrderMerchantReference).first();

    if (!tx) {
      console.warn(`[IPN] Transaction not found: ${OrderMerchantReference}`);
      return new Response('OK', { status: 200 });
    }

    // 6️⃣ REPAIRED VOUCHER ASSIGNMENT (Surgical Fix)
    const voucher = await retryVoucherAssignment(env, OrderMerchantReference, tx.package_type, 6);

    if (!voucher) {
      console.error(`[IPN] ⚠️ VOUCHER DEPLETED for package: ${tx.package_type}`);
      await sendAlert(env, {
        type: 'VOUCHER_DEPLETED',
        package: tx.package_type,
        transaction: OrderMerchantReference,
        timestamp: new Date().toISOString()
      });
      return new Response('OK', { status: 200 });
    }

    // 7️⃣ Update transaction with voucher
    await env.DB.prepare(
      `UPDATE transactions
       SET status = 'COMPLETED',
           pesapal_transaction_id = ?,
           voucher_id = ?,
           completed_at = CURRENT_TIMESTAMP
       WHERE tracking_id = ?`
    ).bind(OrderTrackingId, voucher.id, OrderMerchantReference).run();

    console.log(`[IPN SUCCESS] ✅ ${voucher.code} assigned to ${OrderMerchantReference}`);

    // 8️⃣ RESTORED: Your Notification Logic
    notifyCustomer(env, tx.email, tx.phone_number, voucher.code, tx.package_type)
      .catch(err => console.error('[NOTIFY ERROR]', err));

    return new Response(JSON.stringify({
      status: 200,
      orderTrackingId: OrderTrackingId,
      voucherAssigned: true
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error('[IPN ERROR] ❌:', err);
    // RESTORED: Your Error Logging
    try {
      await logError(env, { error: err.message, stack: err.stack, timestamp: new Date().toISOString() });
    } catch (logErr) { console.error('[LOGGING ERROR]', logErr); }
    return new Response('OK', { status: 200 });
  }
}

// ---------- HELPER FUNCTIONS (ALL RESTORED) ----------

async function getPesapalToken(env) {
  if (env.KV) {
    try {
      const cached = await env.KV.get('pesapal_token', 'json');
      if (cached && cached.expiry > Date.now()) return cached.token;
    } catch (err) { console.warn('[TOKEN] KV fail:', err); }
  }

  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ consumer_key: env.PESAPAL_KEY, consumer_secret: env.PESAPAL_SECRET })
  });

  const data = await res.json();
  if (env.KV && data.token) {
    const expiry = Date.now() + (50 * 60 * 1000);
    await env.KV.put('pesapal_token', JSON.stringify({ token: data.token, expiry }), { expirationTtl: 3600 });
  }
  return data.token;
}

async function fetchPesapalStatus(orderTrackingId, token) {
  const res = await fetch(`https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  const data = await res.json();
  return data.payment_status_description?.toUpperCase() || 'PENDING';
}

async function notifyCustomer(env, email, phone, voucherCode, packageType) {
  if (email && env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'noreply@mobilehubuganda.pages.dev',
        to: email,
        subject: 'Your Hotspot Voucher Code',
        html: `<p>Success! Your ${packageType} code is: <b>${voucherCode}</b></p>`
      })
    });
  }
}

async function sendAlert(env, alertData) {
  if (env.SLACK_WEBHOOK_URL) {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 *${alertData.type}*` })
    });
  }
}

async function logError(env, errorData) {
  if (env.LOG_API_URL) {
    await fetch(env.LOG_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(errorData)
    });
  }
}

async function retryVoucherAssignment(env, OrderMerchantReference, packageType, maxRetries = 6) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const available = await env.DB.prepare(
        `SELECT id FROM vouchers WHERE package_type = ? AND status = 'unused' LIMIT 1`
      ).bind(packageType).first();

      if (!available) return null; 

      const voucher = await env.DB.prepare(
        `UPDATE vouchers 
         SET status = 'assigned', transaction_id = ?, used_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND status = 'unused'
         RETURNING id, code`
      ).bind(OrderMerchantReference, available.id).first();

      if (voucher) return voucher;
    } catch (dbErr) {
      console.warn(`[VOUCHER DB BUSY] ${dbErr.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}
