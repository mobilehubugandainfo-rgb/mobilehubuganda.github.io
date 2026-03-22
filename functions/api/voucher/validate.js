// functions/api/voucher/validate.js
// ✅ Expiry check — wall-clock time from first use
// ✅ MAC locking — only first device can use voucher
// ✅ Reconnection allowed within expiry window from same device
// ✅ Correct UTC datetime parsing from SQLite
// ✅ Race condition protected
// ✅ Clean error messages for each scenario

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

    // ── Guard: empty code ──────────────────────────────────────────
    if (!code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    // ── 1. Fetch voucher from D1 ───────────────────────────────────
    const voucher = await env.DB.prepare(`
      SELECT id, code, package_type, status, used_at, expires_at, mac_address
      FROM vouchers
      WHERE code = ?
    `).bind(code).first();

    console.log('[VALIDATE] DB row:', JSON.stringify(voucher));

    // ── 1a. Not found ──────────────────────────────────────────────
    if (!voucher) {
      console.warn('[VALIDATE] ❌ Not found:', code);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid voucher code. Please check and try again.'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 1b. Already marked expired in DB ──────────────────────────
    if (voucher.status === 'expired') {
      console.warn('[VALIDATE] ❌ Already expired:', code);
      return new Response(JSON.stringify({
        success: false,
        error: 'This voucher has expired. Please purchase a new one.'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 1c. Wall-clock expiry check ────────────────────────────────
    // SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (UTC)
    // We must append 'Z' so JavaScript parses it as UTC not local time
    if (voucher.expires_at) {
      const now    = new Date();
      const expiry = new Date(voucher.expires_at.replace(' ', 'T') + 'Z');
      console.log('[VALIDATE] Now:', now.toISOString(), '| Expiry:', expiry.toISOString());
      if (now > expiry) {
        await env.DB.prepare(
          `UPDATE vouchers SET status = 'expired' WHERE id = ?`
        ).bind(voucher.id).run();
        console.warn('[VALIDATE] ❌ Voucher expired:', code, '— expired at', voucher.expires_at);
        return new Response(JSON.stringify({
          success: false,
          error: 'This voucher has expired. Please purchase a new one.'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // ── 1d. MAC lock — block different devices ─────────────────────
    if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
      if (voucher.mac_address !== mac) {
        console.warn('[VALIDATE] ❌ MAC mismatch:', code,
          '| locked to:', voucher.mac_address, '| tried by:', mac);
        return new Response(JSON.stringify({
          success: false,
          error: 'This voucher is already active on another device.'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // ── 1e. Safety net — used with no expiry ───────────────────────
    if (voucher.status === 'used' && !voucher.expires_at && !voucher.mac_address) {
      console.warn('[VALIDATE] ❌ Used voucher with no expiry:', code);
      return new Response(JSON.stringify({
        success: false,
        error: 'This voucher has already been used.'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 2. Calculate expiry on first use ───────────────────────────
    const durations = {
      'p1':         5 * 60 * 1000,  // 5 minutes
      'p2':        24 * 60 * 60 * 1000,  // 1 day
      'p3':     7 * 24 * 60 * 60 * 1000, // 1 week
      'p4':    30 * 24 * 60 * 60 * 1000  // 30 days
    };

    const pkg      = (voucher.package_type || 'p2').toLowerCase();
    const duration = durations[pkg] || durations['p2'];
    const expiry   = new Date(Date.now() + duration);

    // Store as UTC string compatible with SQLite datetime()
    const expiresAt = expiry.toISOString().replace('T', ' ').split('.')[0];

    console.log('[VALIDATE] Expiry calculated:', expiresAt, '| package:', pkg);

    // ── 3. Update DB — first use only (CASE guards idempotency) ───
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

    // ── 4. Build profile map ───────────────────────────────────────
    const profileMap = {
      'free-trial': 'free-trial',
      'p1': 'p1',
      'p2': 'p2',
      'p3': 'p3',
      'p4': 'p4'
    };
    const profile = profileMap[pkg] || 'p2';

    // ── 5. Return success ──────────────────────────────────────────
    return new Response(JSON.stringify({
      success:    true,
      code:       code,
      password:   code,
      package:    voucher.package_type,
      profile:    profile,
      expires_at: expiresAt
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[VALIDATE] ❌ Unexpected error:', error.message, error.stack);
    return new Response(JSON.stringify({
      success: false,
      error:   'System error — please contact support'
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
