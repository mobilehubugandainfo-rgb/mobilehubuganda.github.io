// functions/api/voucher/activate.js
// Called from login.html JUST BEFORE submitting credentials to MikroTik.
// This is the moment the expiry clock starts — not at payment, not at validation.

const PLAN_DURATIONS = {
  p1: 3 * 60 * 60 * 1000,  // 3 hours
  p2: 24 * 60 * 60 * 1000,  // 24 hours
  p3: 24 * 7 * 60 * 60 * 1000,  // 7 days
  p4: 24 * 30 * 60 * 60 * 1000, // 30 days
  'free-trial': 5 * 60 * 1000, // 5 minutes
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const code = (body.code || '').trim().toUpperCase();
    const mac  = (body.mac  || 'unknown').trim();

    console.log('[ACTIVATE] 📥 Request — code:', code, '| mac:', mac);

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    // ── Fetch voucher ─────────────────────────────────────────────
    const voucher = await env.DB.prepare(`
      SELECT id, code, package_type, status, expires_at, mac_address
      FROM vouchers WHERE code = ?
    `).bind(code).first();

    if (!voucher) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher not found'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── MAC mismatch — locked to a different device ───────────────
    if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
      if (voucher.mac_address !== mac) {
        console.warn('[ACTIVATE] ❌ MAC mismatch — locked to:', voucher.mac_address, '| tried:', mac);
        return new Response(JSON.stringify({
          success: false, error: 'This voucher is already active on another device.'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // ── Already activated — check if still within window ─────────
    if (voucher.expires_at) {
      const now    = new Date();
      const expiry = new Date(voucher.expires_at.replace(' ', 'T') + 'Z');

      if (now > expiry) {
        await env.DB.prepare(
          `UPDATE vouchers SET status = 'expired' WHERE id = ?`
        ).bind(voucher.id).run();

        console.warn('[ACTIVATE] ❌ Already expired:', code);
        return new Response(JSON.stringify({
          success: false, error: 'This voucher has already expired. Please purchase a new one.'
        }), { status: 200, headers: jsonHeaders });
      }

      // Still live — idempotent, return existing expiry (don't reset the clock)
      console.log('[ACTIVATE] ✅ Already active, reconnecting — expires:', voucher.expires_at);

      // ── Update last seen + connect count on reconnect ────────────
      try {
        const txRow = await env.DB.prepare(`
          SELECT t.phone_number FROM transactions t
          JOIN vouchers v ON v.transaction_id = t.tracking_id
          WHERE v.code = ?
          LIMIT 1
        `).bind(code).first();

        if (txRow?.phone_number) {
          await env.DB.prepare(`
            UPDATE customers SET
              connect_count = connect_count + 1,
              last_seen     = datetime('now'),
              updated_at    = datetime('now')
            WHERE phone = ?
          `).bind(txRow.phone_number).run();
          console.log('[CUSTOMER] Reconnect recorded for:', txRow.phone_number);
        }
      } catch (custErr) {
        console.error('[CUSTOMER] Reconnect update failed (non-fatal):', custErr.message);
      }

      return new Response(JSON.stringify({
        success:      true,
        expires_at:   voucher.expires_at,
        reconnection: true
      }), { status: 200, headers: jsonHeaders });
    }

    // ── FIRST ACTIVATION — stamp the clock RIGHT NOW ──────────────
    const plan     = (voucher.package_type || 'p1').toLowerCase();
    const duration = PLAN_DURATIONS[plan] ?? PLAN_DURATIONS['p1'];
    const now      = Date.now();

    // Store as UTC string in SQLite-friendly format: "YYYY-MM-DD HH:MM:SS"
    const expiresAt = new Date(now + duration)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');

    const activatedAt = new Date(now)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');

    await env.DB.prepare(`
      UPDATE vouchers
      SET status = 'used', expires_at = ?, used_at = ?, mac_address = ?
      WHERE id = ?
    `).bind(expiresAt, activatedAt, mac, voucher.id).run();

    console.log('[ACTIVATE] ✅ First activation — code:', code, '| expires:', expiresAt, '| mac:', mac);

    // ── Update customer: MAC address, connect count, last seen ────
    try {
      const txRow = await env.DB.prepare(`
        SELECT t.phone_number FROM transactions t
        JOIN vouchers v ON v.transaction_id = t.tracking_id
        WHERE v.code = ?
        LIMIT 1
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
        console.log('[CUSTOMER] First activation recorded for:', txRow.phone_number, '| mac:', mac);
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

// ── CORS preflight ────────────────────────────────────────────
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
