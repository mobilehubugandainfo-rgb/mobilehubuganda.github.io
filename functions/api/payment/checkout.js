// functions/api/payment/checkout.js
// ✅ Saves Pesapal's order_tracking_id to DB immediately at checkout
// ✅ Token fetch failure rolls back voucher + transaction
// ✅ Pesapal submit failure rolls back voucher + transaction
// ✅ Guards against HTML error responses from Pesapal
// ✅ KV write is non-fatal — never crashes checkout

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
       ──────────────────────────────────────────
       Transaction row must exist before voucher
       reservation so IPN/status.js can always
       find it when they query by tracking_id.
       ============================================ */
    await env.DB.prepare(
      `INSERT INTO transactions
         (tracking_id, package_type, amount, phone_number, email, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', datetime('now'))`
    ).bind(tracking_id, package_type, amount, normalizedPhone, email || null).run();

    console.log(`[CHECKOUT] Transaction saved: ${tracking_id}`);

    /* ============================================
       6. RESERVE VOUCHER ATOMICALLY
       ──────────────────────────────────────────
       Single atomic UPDATE prevents two concurrent
       checkouts grabbing the same voucher row.
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
       ──────────────────────────────────────────
       If token fetch fails, roll back immediately.
       A stale cached token gets a 401 — we clear
       it and retry with a fresh one automatically.
       ============================================ */
    let token;
    try {
      token = await getPesapalToken(env);
    } catch (tokenErr) {
      await env.DB.prepare(`UPDATE vouchers SET status='unused', transaction_id=NULL WHERE id=?`)
        .bind(voucher.id).run();
      await env.DB.prepare(`DELETE FROM transactions WHERE tracking_id=?`)
        .bind(tracking_id).run();
      console.error('[CHECKOUT] Token fetch failed, rolled back:', tokenErr.message);
      return new Response(
        JSON.stringify({ success: false, error: 'Payment gateway authentication failed. Please try again.' }),
        { status: 500, headers: jsonHeader }
      );
    }

    /* ============================================
       8. SUBMIT TO PESAPAL
       ──────────────────────────────────────────
       If Pesapal returns HTML (error page) instead
       of JSON, we catch it before .json() explodes
       and roll back cleanly.
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

    let pesapalResponse, result;
    try {
      pesapalResponse = await fetch(
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

      // Guard: Pesapal sometimes returns an HTML error page instead of JSON.
      // Parsing HTML as JSON causes the cryptic "Unexpected token '<'" crash.
      // Check content-type first and log the raw response before failing.
      const contentType = pesapalResponse.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const rawText = await pesapalResponse.text();
        console.error('[CHECKOUT] Pesapal returned non-JSON:', pesapalResponse.status, rawText.slice(0, 300));
        throw new Error(`Pesapal returned unexpected response (HTTP ${pesapalResponse.status})`);
      }

      result = await pesapalResponse.json();
      console.log('[CHECKOUT] Pesapal status:', pesapalResponse.status);
      console.log('[CHECKOUT] Pesapal response:', JSON.stringify(result));

    } catch (submitErr) {
      // Roll back on any Pesapal submit failure
      await env.DB.prepare(`UPDATE vouchers SET status='unused', transaction_id=NULL WHERE id=?`)
        .bind(voucher.id).run();
      await env.DB.prepare(`DELETE FROM transactions WHERE tracking_id=?`)
        .bind(tracking_id).run();
      console.error('[CHECKOUT] Pesapal submit failed, rolled back:', submitErr.message);
      return new Response(
        JSON.stringify({ success: false, error: 'Payment gateway unavailable. Please try again in a moment.' }),
        { status: 500, headers: jsonHeader }
      );
    }

    /* ============================================
       9. HANDLE PESAPAL SUCCESS
       ============================================ */
    if (pesapalResponse.ok && result.redirect_url) {

      // CRITICAL: Save Pesapal's order_tracking_id to DB immediately.
      // This is what status.js uses to query Pesapal directly on every
      // poll, completely bypassing the IPN dependency.
      const pesapalTrackingId = result.order_tracking_id;

      if (pesapalTrackingId) {
        await env.DB.prepare(
          `UPDATE transactions SET pesapal_transaction_id = ? WHERE tracking_id = ?`
        ).bind(pesapalTrackingId, tracking_id).run();
        console.log(`[CHECKOUT] Saved pesapal_transaction_id: ${pesapalTrackingId}`);
      } else {
        console.warn('[CHECKOUT] Pesapal did not return order_tracking_id — status.js fallback will rely on URL param');
      }

      // Save to KV (non-fatal convenience cache for validate.js)
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
       10. PESAPAL REJECTED ORDER — ROLLBACK
       ============================================ */
    await env.DB.prepare(
      `UPDATE vouchers SET status = 'unused', transaction_id = NULL WHERE id = ?`
    ).bind(voucher.id).run();

    await env.DB.prepare(
      `DELETE FROM transactions WHERE tracking_id = ?`
    ).bind(tracking_id).run();

    console.warn('[CHECKOUT] Pesapal rejected order — rolled back voucher and transaction');

    const errorMsg = result?.error?.message || result?.message || result?.error_description || 'Payment gateway rejected the order.';
    console.error('[CHECKOUT] Pesapal rejection reason:', errorMsg);
    throw new Error(errorMsg);

  } catch (error) {
    console.error('[CHECKOUT] Error:', error.message);
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Unexpected error during checkout.' }),
      { status: 500, headers: jsonHeader }
    );
  }
}

/* ============================================
   PESAPAL TOKEN HELPER
   ──────────────────────────────────────────
   Caches token in KV for 50 min.
   On 401, the caller (status.js) clears the
   cache and calls this again for a fresh token.
   ============================================ */
async function getPesapalToken(env) {
  // Try KV cache first
  if (env.KV) {
    try {
      const cached = await env.KV.get('pesapal_token', 'json');
      if (cached && cached.expiry > Date.now()) {
        return cached.token;
      }
    } catch {}
  }

  // Fetch fresh token from Pesapal
  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ consumer_key: env.PESAPAL_KEY, consumer_secret: env.PESAPAL_SECRET })
  });

  // Guard against HTML error response here too
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const raw = await res.text();
    console.error('[TOKEN] Pesapal auth returned non-JSON:', res.status, raw.slice(0, 200));
    throw new Error(`Pesapal auth failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  console.log('[TOKEN] Auth response status:', res.status);

  if (!data.token) {
    console.error('[TOKEN] No token in response:', JSON.stringify(data));
    throw new Error('Failed to authenticate with payment gateway.');
  }

  // Cache for 50 minutes
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
