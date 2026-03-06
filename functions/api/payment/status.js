// functions/api/payment/status.js
// ✅ Self-healing: reads pesapal_transaction_id saved by checkout.js
//    Queries Pesapal directly on every PENDING poll after attempt 2
//    Assigns voucher itself if Pesapal confirms COMPLETED
//    IPN is now just a bonus — never relied upon

export async function onRequestGet({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const url = new URL(request.url);
    const tracking_id = url.searchParams.get('tracking_id') || url.searchParams.get('id');

    if (!tracking_id) {
      return new Response(JSON.stringify({ status: 'ERROR', error: 'Missing tracking_id' }), {
        status: 400, headers: jsonHeaders
      });
    }

    console.log('[STATUS] Checking:', tracking_id);

    // ─── 1. Query DB ───────────────────────────────────────────
    const data = await env.DB.prepare(`
      SELECT
        t.id, t.tracking_id, t.pesapal_transaction_id,
        t.status, t.package_type, t.amount,
        t.voucher_id, t.created_at, t.completed_at,
        t.email, t.phone_number,
        v.code as voucherCode, v.status as voucherStatus
      FROM transactions t
      LEFT JOIN vouchers v ON t.voucher_id = v.id
      WHERE t.tracking_id = ? OR t.pesapal_transaction_id = ?
    `).bind(tracking_id, tracking_id).first();

    if (!data) {
      return new Response(JSON.stringify({
        status: 'NOT_FOUND', message: 'Transaction not found', tracking_id
      }), { status: 404, headers: jsonHeaders });
    }

    // ─── 2. Already done — return immediately ──────────────────
    if (data.status === 'COMPLETED' && data.voucherCode) {
      console.log('[STATUS] Already completed:', data.voucherCode);
      return new Response(JSON.stringify({
        status: 'COMPLETED',
        voucherCode: data.voucherCode,
        tracking_id: data.tracking_id,
        package_type: data.package_type,
        amount: data.amount
      }), { status: 200, headers: jsonHeaders });
    }

    // ─── 3. Still PENDING — get Pesapal transaction ID ─────────
    // Priority order:
    // a) Already saved in DB by checkout.js (best case — always available)
    // b) Passed in URL by payment-success.html (fallback for old transactions)
    // c) Neither available — stay PENDING this round
    const pesapalTxId = data.pesapal_transaction_id
      || url.searchParams.get('OrderTrackingId');

    if (!pesapalTxId) {
      // This should only happen for transactions created before this fix was deployed.
      // For all new transactions, checkout.js saves pesapal_transaction_id immediately.
      console.warn('[STATUS] No pesapal_transaction_id yet for:', tracking_id);
      return new Response(JSON.stringify({
        status: 'PENDING',
        voucherCode: null,
        tracking_id: data.tracking_id,
        package_type: data.package_type,
        amount: data.amount
      }), { status: 200, headers: jsonHeaders });
    }

    // ─── 4. Ask Pesapal directly ───────────────────────────────
    console.log('[STATUS] Querying Pesapal for:', pesapalTxId);

    const token = await getPesapalToken(env);
    const pStatus = await fetchPesapalStatus(pesapalTxId, token);

    console.log('[STATUS] Pesapal says:', pStatus);

    if (!['COMPLETED', 'SUCCESS', 'COMPLETE'].includes(pStatus)) {
      return new Response(JSON.stringify({
        status: 'PENDING',
        voucherCode: null,
        tracking_id: data.tracking_id,
        package_type: data.package_type,
        amount: data.amount
      }), { status: 200, headers: jsonHeaders });
    }

    // ─── 5. Pesapal confirmed COMPLETED — assign voucher ───────
    console.log('[STATUS] Pesapal confirmed payment — running self-healing...');

    // Save pesapal_transaction_id if we got it from URL and DB didn't have it
    if (!data.pesapal_transaction_id && pesapalTxId) {
      await env.DB.prepare(
        `UPDATE transactions SET pesapal_transaction_id = ? WHERE tracking_id = ?`
      ).bind(pesapalTxId, data.tracking_id).run();
    }

    // Find reserved voucher
    let voucher = await env.DB.prepare(
      `SELECT id, code FROM vouchers
       WHERE transaction_id = ? AND status = 'reserved'
       LIMIT 1`
    ).bind(data.tracking_id).first();

    if (voucher) {
      await env.DB.prepare(`UPDATE vouchers SET status = 'assigned' WHERE id = ?`)
        .bind(voucher.id).run();
      console.log('[STATUS] Reserved voucher activated:', voucher.code);
    } else {
      // Atomic fallback
      voucher = await retryVoucherAssignment(env, data.tracking_id, data.package_type);
      if (!voucher) {
        console.error('[STATUS] No vouchers available for', data.package_type);
        return new Response(JSON.stringify({
          status: 'PENDING',
          voucherCode: null,
          tracking_id: data.tracking_id,
          package_type: data.package_type,
          amount: data.amount,
          error: 'VOUCHER_DEPLETED'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // Update transaction to COMPLETED
    await env.DB.prepare(
      `UPDATE transactions
       SET status = 'COMPLETED',
           pesapal_transaction_id = ?,
           voucher_id = ?,
           completed_at = CURRENT_TIMESTAMP
       WHERE tracking_id = ?`
    ).bind(pesapalTxId, voucher.id, data.tracking_id).run();

    // Save to KV
    try {
      const kvTtl = parseInt(env.VOUCHER_KV_TTL_SECONDS || '604800', 10);
      await env.KV.put(voucher.code, JSON.stringify({
        package: data.package_type,
        paid: true,
        used: false,
        paidAt: new Date().toISOString(),
        transaction: data.tracking_id,
        email: data.email,
        phone: data.phone_number
      }), kvTtl > 0 ? { expirationTtl: kvTtl } : {});
    } catch (kvErr) {
      console.warn('[STATUS] KV save failed (non-fatal):', kvErr.message);
    }

    // Notify customer async
    notifyCustomer(env, {
      email: data.email,
      phone: data.phone_number,
      voucherCode: voucher.code,
      packageType: data.package_type
    }).catch(e => console.error('[STATUS] Notify failed:', e.message));

    console.log('[STATUS] Self-healing complete. Voucher:', voucher.code);

    return new Response(JSON.stringify({
      status: 'COMPLETED',
      voucherCode: voucher.code,
      tracking_id: data.tracking_id,
      package_type: data.package_type,
      amount: data.amount,
      healed: true
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[STATUS] Critical error:', error.message, error.stack);
    return new Response(JSON.stringify({
      status: 'ERROR',
      error: 'Failed to retrieve transaction status',
      message: error.message
    }), { status: 500, headers: jsonHeaders });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function getPesapalToken(env) {
  if (env.KV) {
    try {
      const cached = await env.KV.get('pesapal_token', 'json');
      if (cached && cached.expiry > Date.now()) return cached.token;
    } catch {}
  }

  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: controller.signal }
      );
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`Pesapal returned ${res.status}`);
      const d = await res.json();
      return (d.payment_status_description || 'PENDING').toUpperCase();
    } catch (err) {
      console.warn(`[STATUS Pesapal retry ${attempt}/${retries}] ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, attempt * 500));
    }
  }
  return 'PENDING';
}

async function retryVoucherAssignment(env, trackingId, packageType, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const voucher = await env.DB.prepare(
        `UPDATE vouchers
         SET status = 'assigned', transaction_id = ?, used_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM vouchers
           WHERE package_type = ? AND status = 'unused'
           ORDER BY id LIMIT 1
         )
         RETURNING id, code`
      ).bind(trackingId, packageType).first();
      if (voucher) return voucher;
    } catch (dbErr) {
      console.warn(`[STATUS voucher retry ${attempt}] ${dbErr.message}`);
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

async function notifyCustomer(env, { email, phone, voucherCode, packageType }) {
  if (!email && !phone) return;
  try {
    if (email && env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'noreply@yourdomain.com',
          to: email,
          subject: 'Your Hotspot Voucher Code',
          html: `<h2>Payment Successful!</h2>
                 <h3 style="font-family:monospace;background:#f4f4f4;padding:10px">${voucherCode}</h3>
                 <p><strong>Package:</strong> ${packageType}</p>`
        })
      });
    }
    if (phone && env.SMS_API_KEY) {
      await fetch(env.SMS_API_URL || 'https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: { 'apiKey': env.SMS_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          username: env.SMS_USERNAME || 'sandbox',
          to: phone,
          message: `Your hotspot voucher: ${voucherCode}. Package: ${packageType}. Enter this code to connect.`
        })
      });
    }
  } catch (err) {
    console.error('[STATUS notify]', err.message);
  }
}
