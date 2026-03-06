// functions/api/payment/checkout.js
// ✅ FIX: DB transaction INSERT happens BEFORE voucher reservation
// ✅ FIX: KV write is non-fatal — never blocks or crashes checkout
// ✅ FIX: Voucher reservation uses correct transaction tracking_id
// ✅ FIX: Orphaned reservation cleanup on Pesapal failure

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
       CRITICAL ORDER FIX: The transaction row MUST
       exist in the DB before we reserve a voucher.
       Previously KV.put() ran before this INSERT —
       if KV threw, the transaction was never saved,
       so IPN would find no transaction and silently
       exit, leaving the client on indefinite pending.
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
       Atomic UPDATE...WHERE id=(SELECT...)...RETURNING
       ensures two simultaneous checkouts for the same
       package can never grab the same voucher row.
       The transaction row already exists above so IPN
       will always find it when it fires.
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
      // Stock was available a moment ago but is now gone (race between stock check and reservation).
      // Roll back the transaction row so it doesn't litter the DB as a ghost PENDING entry.
      await env.DB.prepare(`DELETE FROM transactions WHERE tracking_id = ?`)
        .bind(tracking_id).run();

      return new Response(
        JSON.stringify({ error: 'Unable to reserve voucher. Please try again.' }),
        { status: 500, headers: jsonHeader }
      );
    }

    console.log(`[CHECKOUT] Voucher reserved: ${voucher.code} → ${tracking_id}`);

    /* ============================================
       7. SAVE RESERVATION TO KV (NON-FATAL)
       ──────────────────────────────────────────
       KV is a convenience cache for validate.js.
       It must NEVER block or crash checkout — if KV
       is down or throws, we log and move on. The DB
       is the source of truth; IPN will re-save to KV
       after payment is confirmed anyway.
       ============================================ */
    try {
      await env.KV.put(tracking_id, JSON.stringify({
        voucher: voucher.code,
        package: package_type,
        status: 'reserved',
        reservedAt: new Date().toISOString()
      }));
    } catch (kvErr) {
      // Non-fatal — log and continue
      console.warn('[CHECKOUT] KV reservation save failed (non-fatal):', kvErr.message);
    }

    /* ============================================
       8. GET PESAPAL TOKEN
       ============================================ */
    const token = await getPesapalToken(env);
    console.log('[CHECKOUT] Token obtained');

    /* ============================================
       9. PREPARE ORDER REQUEST
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

    console.log('[CHECKOUT] Order request:', JSON.stringify(orderRequest));

    /* ============================================
       10. SUBMIT TO PESAPAL
       ============================================ */
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
       11. PESAPAL REJECTED — RELEASE RESERVED VOUCHER
       ──────────────────────────────────────────
       If Pesapal rejects the order, the client never
       sees a payment page and will never pay. Release
       the reserved voucher back to 'unused' so it's
       available for the next client, and clean up the
       transaction row.
       ============================================ */
    await env.DB.prepare(
      `UPDATE vouchers SET status = 'unused', transaction_id = NULL WHERE id = ?`
    ).bind(voucher.id).run();

    await env.DB.prepare(
      `DELETE FROM transactions WHERE tracking_id = ?`
    ).bind(tracking_id).run();

    console.warn('[CHECKOUT] Pesapal rejected order — voucher and transaction rolled back');

    const errorMsg = result.error?.message || result.message || result.error_description || 'Payment gateway did not respond correctly.';
    console.error('[CHECKOUT] Pesapal error:', errorMsg, 'Full:', result);
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
   ============================================ */
async function getPesapalToken(env) {
  // Use cached token from KV if available (avoids extra auth call per checkout)
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
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ consumer_key: env.PESAPAL_KEY, consumer_secret: env.PESAPAL_SECRET })
  });

  const data = await res.json();
  console.log('[TOKEN] Request status:', res.status);
  console.log('[TOKEN] Response:', JSON.stringify(data));

  if (!data.token) {
    console.error('[TOKEN] Auth error:', data);
    throw new Error('Failed to authenticate with payment gateway.');
  }

  // Cache token for 50 minutes
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
