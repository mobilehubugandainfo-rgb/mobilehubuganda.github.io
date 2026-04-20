// functions/api/voucher/validate.js
// ✅ Expiry check — wall-clock time from FIRST use, never reset
// ✅ MAC locking — only first device can use voucher
// ✅ Roaming allowed — MAC updates if previous session expired (keepalive 30s)
// ✅ Anti-sharing — blocks simultaneous use from different devices
// ✅ Expired vouchers blocked and marked in DB
// ✅ Correct UTC datetime parsing from SQLite

// How long to wait before allowing MAC switch (match MikroTik keepalive-timeout)
const ROAMING_GRACE_SECONDS = 60; // 60s grace — slightly more than 30s keepalive

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
    const ip   = request.headers.get('CF-Connecting-IP') || 'unknown';

    console.log('[VALIDATE] 📥 Request — code:', code, '| mac:', mac, '| ip:', ip);

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    // ── 1. Fetch voucher ───────────────────────────────────────────
    const voucher = await env.DB.prepare(`
      SELECT id, code, package_type, status, used_at, expires_at, mac_address, last_seen, last_ip
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

    const now = new Date();

    // ── 1c. Wall-clock expiry check ────────────────────────────────
    if (voucher.expires_at) {
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

      // ── Anti-sharing + Roaming logic ───────────────────────────
      if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
        if (voucher.mac_address !== mac) {

          // Different MAC — check if previous session has gone idle
          const lastSeen = voucher.last_seen ? new Date(voucher.last_seen) : null;
          const secondsSinceLastSeen = lastSeen
            ? (now - lastSeen) / 1000
            : ROAMING_GRACE_SECONDS + 1; // no last_seen = treat as idle

          console.log('[VALIDATE] 🔍 MAC mismatch — seconds since last seen:', secondsSinceLastSeen);

          if (secondsSinceLastSeen < ROAMING_GRACE_SECONDS) {
            // ❌ Previous session still active — this is sharing, not roaming
            console.warn('[VALIDATE] ❌ SHARING DETECTED — locked to:', voucher.mac_address,
              '| tried:', mac, '| last seen:', secondsSinceLastSeen, 's ago');

            return new Response(JSON.stringify({
              success: false,
              error: 'This voucher is already active on another device. Please wait a moment and try again.'
            }), { status: 200, headers: jsonHeaders });

          } else {
            // ✅ Previous session idle — allow roaming, update MAC
            console.log('[VALIDATE] 🔄 Roaming detected — updating MAC:',
              voucher.mac_address, '→', mac);

            await env.DB.prepare(`
              UPDATE vouchers SET mac_address = ?, last_seen = ?, last_ip = ? WHERE id = ?
            `).bind(mac, now.toISOString(), ip, voucher.id).run();
          }

        } else {
          // ✅ Same MAC — update last_seen (heartbeat)
          await env.DB.prepare(`
            UPDATE vouchers SET last_seen = ?, last_ip = ? WHERE id = ?
          `).bind(now.toISOString(), ip, voucher.id).run();
        }
      } else {
        // No MAC on record yet — update last_seen
        await env.DB.prepare(`
          UPDATE vouchers SET last_seen = ?, last_ip = ? WHERE id = ?
        `).bind(now.toISOString(), ip, voucher.id).run();
      }

      console.log('[VALIDATE] ✅ Reconnection allowed — code:', code, '| expires:', voucher.expires_at);

      return new Response(JSON.stringify({
        success:      true,
        code:         code,
        password:     code,
        package:      voucher.package_type,
        profile:      voucher.package_type || 'p2',
        expires_at:   voucher.expires_at,
        reconnection: true
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 2. FIRST USE ────────────────────────────────────────────────
    if (voucher.status !== 'assigned' && voucher.status !== 'used') {
      console.warn('[VALIDATE] ❌ Unexpected status:', voucher.status, 'for code:', code);
      return new Response(JSON.stringify({
        success: false, error: 'This voucher cannot be used. Please contact support.'
      }), { status: 200, headers: jsonHeaders });
    }

    // MAC lock check on first use
    if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
      if (voucher.mac_address !== mac) {

        const lastSeen = voucher.last_seen ? new Date(voucher.last_seen) : null;
        const secondsSinceLastSeen = lastSeen
          ? (now - lastSeen) / 1000
          : ROAMING_GRACE_SECONDS + 1;

        if (secondsSinceLastSeen < ROAMING_GRACE_SECONDS) {
          // Still active on another device — block
          console.warn('[VALIDATE] ❌ SHARING BLOCKED on first use — code:', code);
          return new Response(JSON.stringify({
            success: false,
            error: 'This voucher is already active on another device. Please wait a moment and try again.'
          }), { status: 200, headers: jsonHeaders });
        } else {
          // Previous session idle — allow, update MAC
          console.log('[VALIDATE] 🔄 MAC update on first use (roaming):', voucher.mac_address, '→', mac);
          await env.DB.prepare(`
            UPDATE vouchers SET mac_address = ?, last_seen = ?, last_ip = ? WHERE id = ?
          `).bind(mac, now.toISOString(), ip, voucher.id).run();
        }
      }
    }

    // Lock MAC on very first use
    if (!voucher.mac_address || voucher.mac_address === 'unknown') {
      await env.DB.prepare(`
        UPDATE vouchers SET mac_address = ?, last_seen = ?, last_ip = ? WHERE id = ?
      `).bind(mac, now.toISOString(), ip, voucher.id).run();
    }

    console.log('[VALIDATE] 🆕 Fresh voucher — ready for activation at login');

    return new Response(JSON.stringify({
      success:              true,
      code:                 code,
      password:             code,
      package:              voucher.package_type,
      profile:              voucher.package_type || 'p2',
      activation_required:  true
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[VALIDATE] ❌ Unexpected error:', error.message, error.stack);
    return new Response(JSON.stringify({
      success: false, error: 'System error — please contact support'
    }), { status: 500, headers: jsonHeaders });
  }
}

// ── CORS ──────────────────────────────────────────────────────────
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
