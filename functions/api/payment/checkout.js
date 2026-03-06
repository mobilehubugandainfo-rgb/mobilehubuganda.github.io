// functions/api/payment/checkout.js
// ✅ FIX: Saves Pesapal's order_tracking_id to DB immediately at checkout
//         so status.js can query Pesapal directly without waiting for IPN

export async function onRequestPost({ request, env }) {
  const jsonHeader = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const { package_id, phone, email } = await request.json();

    /* ============================================
       1. PACKAGE VALIDATION
       ============================================ */
    const packages = {
      'p1': 250,
      'p2': 500,
      'p3': 1000,
      'p4': 1500
    };

    const amount = packages[package_id];
    const package_type = package_id;

    if (!amount) {
      return new Response(
        JSON.stringify({ error: `Invalid package (${package_id}) selected. Please refresh and try again.` }),
        { status: 400, headers: jsonHeader }
      );
    }

    /* ============================================
       2. GENERATE TRACKING ID
       ============================================ */
    const tracking_id = `TRK-${crypto.randomUUID().split('-')[0].toUpperCase()}`;

    /* ============================================
       3. PHONE VALIDATION
       ============================================ */
    const normalizedPhone = (phone || '').replace(/\D/g, '');
    if (!/^((256|0)\d{9})$/.test(normalizedPhone)) {
      return new Response(
        JSON.stringify({ error: 'Please enter a valid Ugandan phone number (e.g., 0771999302).' }),
        { status: 400, headers: jsonHeader }
      );
    }

    /* ============================================
       4. VOUCHER STOCK CHECK
       ============================================ */
    const stockCheck = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM vouchers WHERE package_type = ? AND status = 'unused'`
    ).bind(package_type).first();

    if (!stockCheck || stockCheck.count === 0) {
      return new Response(
        JSON.stringify({ error: 'Sorry, vouchers for this package are currently out of stock. Try another package or contact support.' }),
        { status: 400, headers: jsonHeader }
      );
    }

    /* ============================================
       5. SAVE TRANSACTION FIRST
       ============================================ */
    await env.DB.prepare(
      `INSERT INTO transactions
         (tracking_id, package_type, amount, phone_number, email, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', datetime('now'))`
    ).bind(tracking_id, package_type, amount, normalizedPhone, email || null).run();

    console.log(`[CHECKOUT] Transaction saved: ${tracking_id}`);

    /* ============================================
       6. RESERVE VOUCHER ATOMICALLY
       ============================================ */
    const voucher = await env.DB.prepare(
      `UPDATE vouchers
       SET status = 'reserved', transaction_id = ?
       WHERE id = (
         SELECT id FROM vouchers
         WHERE package_type = ? AND status = 'unused'
         ORDER BY id
         LIMIT 1
       )
       RETURNING id, code`
    ).bind(tracking_id, package_type).first();

    if (!voucher) {
      // Roll back transaction row
      await env.DB.prepare(`DELETE FROM transactions WHERE tracking_id = ?`)
        .bind(tracking_id).run();
      return new Response(
        JSON.stringify({ error: 'Unable to reserve voucher. Please try again.' }),
        { status: 500, headers: jsonHeader }
      );
    }

    console.log(`[CHECKOUT] Voucher reserved: ${voucher.code} → ${tracking_id}`);

    /* ============================================
       7. GET PESAPAL TOKEN
       ============================================ */
    const token = await getPesapalToken(env);

    /* ============================================
       8. SUBMIT TO PESAPAL
       ============================================ */
    const orderRequest = {
      id: tracking_id,
      currency: 'UGX',
      amount,
      description: `HotSpotCentral - ${package_type}`,
      callback_url: `https://mobilehubuganda-github-io.pages.dev/payment-success.html?id=${tracking_id}`,
      notification_id: env.PESAPAL_IPN_ID,
      billing_address: {
        phone_number: normalizedPhone,
        email_address: email || `customer-${tracking_id}@hotspotcentral.com`
      }
    };

    const pesapalResponse = await fetch(
      'https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(orderRequest)
      }
    );

    const result = await pesapalResponse.json();
    console.log('[CHECKOUT] Pesapal status:', pesapalResponse.status);
    console.log('[CHECKOUT] Pesapal response:', JSON.stringify(result));

    if (pesapalResponse.ok && result.redirect_url) {

      /* ============================================
         9. SAVE PESAPAL ORDER_TRACKING_ID TO DB
         ────────────────────────────────────────────
         This is the critical fix. Pesapal returns
         order_tracking_id in the submit response.
         We save it immediately so status.js can
         query Pesapal directly on every poll —
         completely removing the IPN dependency.
         Without this, pesapal_transaction_id stays
         NULL and self-healing can never run.
         ============================================ */
      const pesapalTrackingId = result.order_tracking_id;

      if (pesapalTrackingId) {
        await env.DB.prepare(
          `UPDATE transactions SET pesapal_transaction_id = ? WHERE tracking_id = ?`
        ).bind(pesapalTrackingId, tracking_id).run();
        console.log(`[CHECKOUT] Saved pesapal_transaction_id: ${pesapalTrackingId}`);
      } else {
        console.warn('[CHECKOUT] Pesapal did not return order_tracking_id in submit response');
      }

      /* ============================================
         10. SAVE RESERVATION TO KV (NON-FATAL)
         ============================================ */
      try {
        await env.KV.put(tracking_id, JSON.stringify({
          voucher: voucher.code,
          package: package_type,
          status: 'reserved',
          pesapalTrackingId: pesapalTrackingId || null,
          reservedAt: new Date().toISOString()
        }));
      } catch (kvErr) {
        console.warn('[CHECKOUT] KV save failed (non-fatal):', kvErr.message);
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Redirecting to payment gateway...',
          redirect_url: result.redirect_url,
          tracking_id
        }),
        { headers: jsonHeader }
      );
    }

    /* ============================================
       11. PESAPAL REJECTED — ROLLBACK
       ============================================ */
    await env.DB.prepare(
      `UPDATE vouchers SET status = 'unused', transaction_id = NULL WHERE id = ?`
    ).bind(voucher.id).run();

    await env.DB.prepare(
      `DELETE FROM transactions WHERE tracking_id = ?`
    ).bind(tracking_id).run();

    console.warn('[CHECKOUT] Pesapal rejected — rolled back voucher and transaction');

    const errorMsg = result.error?.message || result.message || result.error_description || 'Payment gateway did not respond correctly.';
    throw new Error(errorMsg);

  } catch (error) {
    console.error('[CHECKOUT] Error:', error.message);
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Unexpected error during checkout.' }),
      { status: 500, headers: jsonHeader }
    );
  }
}

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

  const data = await res.json();
  if (!data.token) throw new Error('Failed to authenticate with payment gateway.');

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
