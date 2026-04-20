// functions/api/voucher/validate.js
// ✅ Free roaming — any MAC can use valid voucher
// ✅ MAC updated to latest device on every login
// ✅ Simultaneous use blocked — two devices at same time
// ✅ Expiry check — wall-clock time from FIRST use
// ✅ Expired vouchers blocked and marked in DB

const SIMULTANEOUS_BLOCK_SECONDS = 90; // block if same voucher used within 90s from different MAC

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

        console.warn('[VALIDATE] ❌ Expired:', code);

        return new Response(JSON.stringify({
          success: false, error: 'This voucher has expired. Please purchase a new one.'
        }), { status: 200, headers: jsonHeaders });
      }

      // ── Anti-simultaneous-use check ────────────────────────────
      // Only block if a DIFFERENT MAC was seen very recently
      if (
        voucher.mac_address &&
        voucher.mac_address !== 'unknown' &&
        mac !== 'unknown' &&
        voucher.mac_address !== mac
      ) {
        const lastSeen = voucher.last_seen ? new Date(voucher.last_seen) : null;
        const secondsSince = lastSeen ? (now - lastSeen) / 1000 : SIMULTANEOUS_BLOCK_SECONDS + 1;

        if (secondsSince < SIMULTANEOUS_BLOCK_SECONDS) {
          // Different MAC, active recently — block as simultaneous sharing
          console.warn('[VALIDATE] ❌ Simultaneous use detected — code:', code,
            '| locked MAC:', voucher.mac_address, '| new MAC:', mac,
            '| last seen:', secondsSince, 's ago');

          return new Response(JSON.stringify({
            success: false,
            error: 'This voucher is currently active on another device. Please wait a moment and try again.'
          }), { status: 200, headers: jsonHeaders });
        }
      }

      // ── Allow — update MAC and last_seen ──────────────────────
      await env.DB.prepare(`
        UPDATE vouchers SET mac_address = ?, last_seen = ?, last_ip = ? WHERE id = ?
      `).bind(mac, now.toISOString(), ip, voucher.id).run();

      console.log('[VALIDATE] ✅ Reconnection allowed — code:', code, '| mac:', mac);

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

    // ── 2. FIRST USE ───────────────────────────────────────────────
    if (voucher.status !== 'assigned' && voucher.status !== 'used') {
      console.warn('[VALIDATE] ❌ Unexpected status:', voucher.status, 'for code:', code);
      return new Response(JSON.stringify({
        success: false, error: 'This voucher cannot be used. Please contact support.'
      }), { status: 200, headers: jsonHeaders });
    }

    // Lock MAC and record first use
    await env.DB.prepare(`
      UPDATE vouchers SET mac_address = ?, last_seen = ?, last_ip = ? WHERE id = ?
    `).bind(mac, now.toISOString(), ip, voucher.id).run();

    console.log('[VALIDATE] 🆕 Fresh voucher — ready for activation | mac:', mac);

    return new Response(JSON.stringify({
      success:             true,
      code:                code,
      password:            code,
      package:             voucher.package_type,
      profile:             voucher.package_type || 'p2',
      activation_required: true
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
