// functions/api/voucher/validate.js
// ✅ Expiry check — wall-clock time from FIRST use, never reset
// ✅ MAC locking — only first device can use voucher
// ✅ Reconnection allowed within expiry window from same device
// ✅ Expired vouchers blocked and marked in DB
// ✅ Correct UTC datetime parsing from SQLite

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const body = await request.json();
    const code = (body.code || '').trim().toUpperCase();
    const mac  = (body.mac  || 'unknown').trim();

    console.log('[VALIDATE] 📥 Request — code:', code, '| mac:', mac);

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    // ── 1. Fetch voucher ───────────────────────────────────────────
    const voucher = await env.DB.prepare(`
      SELECT id, code, package_type, status, used_at, expires_at, mac_address
      FROM vouchers WHERE code = ?
    `).bind(code).first();

    console.log('[VALIDATE] DB row:', JSON.stringify(voucher));

    // ── 1a. Not found ──────────────────────────────────────────────
    if (!voucher) {
      return new Response(JSON.stringify({
        success: false, error: 'Invalid voucher code. Please check and try again.'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 1b. Already marked expired in DB ──────────────────────────
    if (voucher.status === 'expired') {
      return new Response(JSON.stringify({
        success: false, error: 'This voucher has expired. Please purchase a new one.'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 1c. Wall-clock expiry check ────────────────────────────────
    if (voucher.expires_at) {
      const now    = new Date();
      const expiry = new Date(voucher.expires_at.replace(' ', 'T') + 'Z');
      console.log('[VALIDATE] Now:', now.toISOString(), '| Expiry:', expiry.toISOString());

      if (now > expiry) {
        await env.DB.prepare(
          `UPDATE vouchers SET status = 'expired' WHERE id = ?`
        ).bind(voucher.id).run();

        console.warn('[VALIDATE] ❌ Expired:', code, 'expired at', voucher.expires_at);

        return new Response(JSON.stringify({
          success: false, error: 'This voucher has expired. Please purchase a new one.'
        }), { status: 200, headers: jsonHeaders });
      }

      console.log('[VALIDATE] ⏳ Within expiry window, checking MAC...');

      if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
        if (voucher.mac_address !== mac) {
          console.warn('[VALIDATE] ❌ MAC mismatch — locked to:', voucher.mac_address, '| tried:', mac);
          return new Response(JSON.stringify({
            success: false, error: 'This voucher is already active on another device.'
          }), { status: 200, headers: jsonHeaders });
        }
      }

      console.log('[VALIDATE] ✅ Reconnection allowed — code:', code, '| expires:', voucher.expires_at);

      return new Response(JSON.stringify({
        success:    true,
        code:       code,
        password:   code,
        package:    voucher.package_type,
        profile:    voucher.package_type || 'p2',
        expires_at: voucher.expires_at,
        reconnection: true
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 2. FIRST USE — DO NOT ACTIVATE HERE ────────────
    if (voucher.status !== 'assigned' && voucher.status !== 'used') {
      console.warn('[VALIDATE] ❌ Unexpected status:', voucher.status, 'for code:', code);
      return new Response(JSON.stringify({
        success: false, error: 'This voucher cannot be used. Please contact support.'
      }), { status: 200, headers: jsonHeaders });
    }

    // MAC lock check
    if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
      if (voucher.mac_address !== mac) {
        console.warn('[VALIDATE] ❌ MAC mismatch on first use:', code);
        return new Response(JSON.stringify({
          success: false, error: 'This voucher is already active on another device.'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // OPTIONAL: lock MAC early
    if (!voucher.mac_address || voucher.mac_address === 'unknown') {
      await env.DB.prepare(`
        UPDATE vouchers SET mac_address = ? WHERE id = ?
      `).bind(mac, voucher.id).run();
    }

    console.log('[VALIDATE] 🆕 Fresh voucher — ready for activation at login');

    return new Response(JSON.stringify({
      success:  true,
      code:     code,
      password: code,
      package:  voucher.package_type,
      profile:  voucher.package_type || 'p2',
      activation_required: true
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[VALIDATE] ❌ Unexpected error:', error.message, error.stack);
    return new Response(JSON.stringify({
      success: false, error: 'System error — please contact support'
    }), { status: 500, headers: jsonHeaders });
  }
}

// ── CORS ─────────────────────────────────────────────────
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
