// functions/api/voucher/activate.js
// ✅ Free roaming — MAC updates on every activation
// ✅ Simultaneous use blocked — different MAC within 90s
// ✅ Expiry clock starts on FIRST activation only
// ✅ Reconnection allowed within expiry window
// ✅ tracking_id is optional (audit only)

const PLAN_DURATIONS = {
  p1:           3  * 60 * 60 * 1000,       // 3 hours
  p2:           24 * 60 * 60 * 1000,       // 24 hours
  p3:           7  * 24 * 60 * 60 * 1000,  // 7 days
  p4:           30 * 24 * 60 * 60 * 1000,  // 30 days
  'free-trial':  5 * 60 * 1000,            // 5 minutes
};

const SIMULTANEOUS_BLOCK_SECONDS = 90; // block different MAC within 90s

const jsonHeaders = {
  'Content-Type':                 'application/json',
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestPost({ request, env }) {
  try {
    const body       = await request.json();
    const code       = (body.code  || '').trim().toUpperCase();
    const mac        = (body.mac   || 'unknown').trim();
    const trackingId = body.tracking_id || null;
    const ip         = request.headers.get('CF-Connecting-IP') || 'unknown';

    console.log('[ACTIVATE] 📥 Request — code:', code, '| mac:', mac, '| tracking_id:', trackingId || '(none)');

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    // ── Fetch voucher ──────────────────────────────────────────────
    const voucher = await env.DB.prepare(`
      SELECT id, code, package_type, status, expires_at, mac_address, transaction_id, last_seen
      FROM vouchers WHERE code = ?
    `).bind(code).first();

    if (!voucher) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher not found'
      }), { status: 200, headers: jsonHeaders });
    }

    if (voucher.transaction_id && !trackingId) {
      console.warn('[ACTIVATE] ⚠️ Missing tracking_id for paid voucher (non-blocking) — code:', code);
    }

    const now = new Date();

    // ── Already activated — check expiry ──────────────────────────
    if (voucher.expires_at) {
      const expiry = new Date(voucher.expires_at.replace(' ', 'T') + 'Z');

      if (now > expiry) {
        await env.DB.prepare(
          `UPDATE vouchers SET status = 'expired' WHERE id = ?`
        ).bind(voucher.id).run();

        console.warn('[ACTIVATE] ❌ Already expired — code:', code);
        return new Response(JSON.stringify({
          success: false, error: 'This voucher has already expired. Please purchase a new one.'
        }), { status: 200, headers: jsonHeaders });
      }

      // ── Anti-simultaneous check ──────────────────────────────────
      if (
        voucher.mac_address &&
        voucher.mac_address !== 'unknown' &&
        mac !== 'unknown' &&
        voucher.mac_address !== mac
      ) {
        const lastSeen = voucher.last_seen ? new Date(voucher.last_seen) : null;
        const secondsSince = lastSeen
          ? (now - lastSeen) / 1000
          : SIMULTANEOUS_BLOCK_SECONDS + 1;

        if (secondsSince < SIMULTANEOUS_BLOCK_SECONDS) {
          console.warn('[ACTIVATE] ❌ Simultaneous use blocked — code:', code,
            '| locked MAC:', voucher.mac_address, '| tried:', mac,
            '| last seen:', secondsSince.toFixed(0), 's ago');

          return new Response(JSON.stringify({
            success: false,
            error: 'This voucher is currently active on another device. Please wait a moment and try again.'
          }), { status: 200, headers: jsonHeaders });
        }

        console.log('[ACTIVATE] 🔄 Roaming — MAC update:', voucher.mac_address, '→', mac);
      }

      // ── Allow reconnection — update MAC and last_seen ────────────
      await env.DB.prepare(`
        UPDATE vouchers SET mac_address = ?, last_seen = ?, last_ip = ? WHERE id = ?
      `).bind(mac, now.toISOString(), ip, voucher.id).run();

      // Update customer record
      try {
        const txRow = await env.DB.prepare(`
          SELECT t.phone_number FROM transactions t
          JOIN vouchers v ON v.transaction_id = t.tracking_id
          WHERE v.code = ? LIMIT 1
        `).bind(code).first();

        if (txRow?.phone_number) {
          await env.DB.prepare(`
            UPDATE customers SET
              connect_count = connect_count + 1,
              last_seen     = datetime('now'),
              updated_at    = datetime('now')
            WHERE phone = ?
          `).bind(txRow.phone_number).run();
        }
      } catch (custErr) {
        console.error('[CUSTOMER] Reconnect update failed (non-fatal):', custErr.message);
      }

      console.log('[ACTIVATE] ✅ Reconnection allowed — code:', code, '| mac:', mac, '| expires:', voucher.expires_at);

      return new Response(JSON.stringify({
        success:      true,
        expires_at:   voucher.expires_at,
        reconnection: true
      }), { status: 200, headers: jsonHeaders });
    }

    // ── FIRST ACTIVATION — stamp expiry clock ─────────────────────
    const plan     = (voucher.package_type || 'p1').toLowerCase();
    const duration = PLAN_DURATIONS[plan] ?? PLAN_DURATIONS['p1'];

    const expiresAt = new Date(now.getTime() + duration)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');

    const activatedAt = now
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');

    await env.DB.prepare(`
      UPDATE vouchers
      SET status = 'used', expires_at = ?, used_at = ?, mac_address = ?, last_seen = ?, last_ip = ?
      WHERE id = ?
    `).bind(expiresAt, activatedAt, mac, now.toISOString(), ip, voucher.id).run();

    console.log('[ACTIVATE] ✅ First activation — code:', code, '| expires:', expiresAt, '| mac:', mac);

    // Update customer record
    try {
      const txRow = await env.DB.prepare(`
        SELECT t.phone_number FROM transactions t
        JOIN vouchers v ON v.transaction_id = t.tracking_id
        WHERE v.code = ? LIMIT 1
      `).bind(code).first();

      if (txRow?.phone_number) {
        await env.DB.prepare(`
          UPDATE customers SET
            mac_address   = COALESCE(NULLIF(mac_address, 'unknown'), NULLIF(?, 'unknown'), mac_address),
            connect_count = connect_count + 1,
            last_seen     = datetime('now'),
            updated_at    = datetime('now')
          WHERE phone = ?
        `).bind(mac, txRow.phone_number).run();
      }
    } catch (custErr) {
      console.error('[CUSTOMER] First activation update failed (non-fatal):', custErr.message);
    }

    return new Response(JSON.stringify({
      success:      true,
      expires_at:   expiresAt,
      reconnection: false
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[ACTIVATE] ❌ Unexpected error:', error.message, error.stack);
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
