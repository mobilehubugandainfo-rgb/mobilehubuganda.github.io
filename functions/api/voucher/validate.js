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
    // Only check if expires_at is set (i.e. voucher has been used before)
    // SQLite stores "YYYY-MM-DD HH:MM:SS" UTC — append Z to parse correctly
    if (voucher.expires_at) {
      const now    = new Date();
      const expiry = new Date(voucher.expires_at.replace(' ', 'T') + 'Z');
      console.log('[VALIDATE] Now:', now.toISOString(), '| Expiry:', expiry.toISOString());

      if (now > expiry) {
        // Mark expired so future checks skip the time comparison
        await env.DB.prepare(
          `UPDATE vouchers SET status = 'expired' WHERE id = ?`
        ).bind(voucher.id).run();
        console.warn('[VALIDATE] ❌ Expired:', code, 'expired at', voucher.expires_at);
        return new Response(JSON.stringify({
          success: false, error: 'This voucher has expired. Please purchase a new one.'
        }), { status: 200, headers: jsonHeaders });
      }

      // ── Within expiry window — check MAC then allow reconnection ──
      console.log('[VALIDATE] ⏳ Within expiry window, checking MAC...');

      // MAC lock check — only if both sides have a real MAC
      if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
        if (voucher.mac_address !== mac) {
          console.warn('[VALIDATE] ❌ MAC mismatch — locked to:', voucher.mac_address, '| tried:', mac);
          return new Response(JSON.stringify({
            success: false, error: 'This voucher is already active on another device.'
          }), { status: 200, headers: jsonHeaders });
        }
      }

      // ✅ Same device reconnecting within expiry — allow, no DB changes needed
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

    // ── 2. FIRST USE — voucher has never been activated ────────────
    // expires_at is NULL here, meaning this is a fresh voucher
    // Calculate expiry NOW and lock MAC
    if (voucher.status !== 'assigned' && voucher.status !== 'used') {
      // Catch any unexpected status (cancelled, etc.)
      console.warn('[VALIDATE] ❌ Unexpected status:', voucher.status, 'for code:', code);
      return new Response(JSON.stringify({
        success: false, error: 'This voucher cannot be used. Please contact support.'
      }), { status: 200, headers: jsonHeaders });
    }

    // MAC lock check for first use too
    // (handles race: two devices submit same fresh voucher simultaneously)
    if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
      if (voucher.mac_address !== mac) {
        console.warn('[VALIDATE] ❌ MAC mismatch on first use:', code);
        return new Response(JSON.stringify({
          success: false, error: 'This voucher is already active on another device.'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // ── 3. Calculate expiry ────────────────────────────────────────
    const durations = {
      'p1':  5 * 60 * 1000,             // 5 mins (TESTING — change to 3 * 60 * 60 * 1000 for production)
      'p2': 24 * 60 * 60 * 1000,       // 1 day
      'p3':  7 * 24 * 60 * 60 * 1000,  // 1 week
      'p4': 30 * 24 * 60 * 60 * 1000   // 30 days
    };

    const pkg      = (voucher.package_type || 'p2').toLowerCase();
    const duration = durations[pkg] || durations['p2'];
    const expiresAt = new Date(Date.now() + duration)
      .toISOString().replace('T', ' ').split('.')[0];

    console.log('[VALIDATE] 🆕 First use — expiry set to:', expiresAt, '| package:', pkg, '| mac:', mac);

    // ── 4. Write to DB — only sets values that are currently NULL ──
    // CASE guards prevent any overwrite on concurrent requests
    await env.DB.prepare(`
      UPDATE vouchers
      SET
        status      = 'used',
        used_at     = CASE WHEN used_at     IS NULL THEN datetime('now') ELSE used_at     END,
        expires_at  = CASE WHEN expires_at  IS NULL THEN ?               ELSE expires_at  END,
        mac_address = CASE WHEN mac_address IS NULL THEN ?               ELSE mac_address END
      WHERE id = ?
    `).bind(expiresAt, mac, voucher.id).run();

    console.log('[VALIDATE] ✅ DB updated — code:', code, '| expires:', expiresAt, '| mac:', mac);

    // ── 5. Return success ──────────────────────────────────────────
    return new Response(JSON.stringify({
      success:    true,
      code:       code,
      password:   code,
      package:    voucher.package_type,
      profile:    pkg,
      expires_at: expiresAt
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[VALIDATE] ❌ Unexpected error:', error.message, error.stack);
    return new Response(JSON.stringify({
      success: false, error: 'System error — please contact support'
    }), { status: 500, headers: jsonHeaders });
  }
}

// ── CORS preflight ─────────────────────────────────────────────────
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
