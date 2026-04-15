// functions/api/voucher/session.js
// Called by status.html to display live session info.
// Returns expires_at, activated_at, package_type, and computed seconds remaining.
// This is READ-ONLY — it never modifies the voucher.

const PLAN_DURATIONS = {
  p1: 3 * 60 * 60,  // seconds
  p2: 24 * 60 * 60,
  p3: 7 * 24 * 60 * 60,
  p4: 30 * 24 * 60 * 60,
  "free-trial": 5 * 60,
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

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    const voucher = await env.DB.prepare(`
      SELECT code, package_type, status, expires_at, used_at, mac_address,
             bytes_in, bytes_out
      FROM vouchers WHERE code = ?
    `).bind(code).first();
    // ── Not found ─────────────────────────────────────────────
    if (!voucher) {
      return new Response(JSON.stringify({
        success: false, state: 'not_found', error: 'Voucher not found'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── Never activated (no expiry set yet) ───────────────────
    // Shouldn't land on status page in this state, but handle it gracefully
    if (!voucher.expires_at) {
      return new Response(JSON.stringify({
        success: false, state: 'not_activated', error: 'Voucher has not been activated yet'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── MAC mismatch ──────────────────────────────────────────
    if (voucher.mac_address && voucher.mac_address !== 'unknown' && mac !== 'unknown') {
      if (voucher.mac_address !== mac) {
        return new Response(JSON.stringify({
          success: false, state: 'mac_mismatch', error: 'This voucher is active on a different device'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // ── Compute time values ───────────────────────────────────
    const now          = Date.now();
    const expiryDate   = new Date(voucher.expires_at.replace(' ', 'T') + 'Z');
    const expiryMs     = expiryDate.getTime();
    const remainingSecs = Math.max(0, Math.floor((expiryMs - now) / 1000));

    const pkg          = (voucher.package_type || 'p1').toLowerCase();
    const totalSecs    = PLAN_DURATIONS[pkg] ?? PLAN_DURATIONS['p1'];
    const usedSecs     = Math.max(0, totalSecs - remainingSecs);

    // ── Expired ───────────────────────────────────────────────
    if (remainingSecs === 0) {
      // Mark expired in DB if not already
      if (voucher.status !== 'expired') {
        await env.DB.prepare(
          `UPDATE vouchers SET status = 'expired' WHERE code = ?`
        ).bind(code).run();
      }
      return new Response(JSON.stringify({
      success:  true,
      state:    'active',
      code:     code,
      package:  pkg,
      expires_at:     voucher.expires_at,
      activated_at:   voucher.used_at || null,
      remaining_secs: remainingSecs,
      total_secs:     totalSecs,
      used_secs:      usedSecs,
      bytes_in:       voucher.bytes_in  || null,
      bytes_out:      voucher.bytes_out || null
    }), { status: 200, headers: jsonHeaders });
    }

    // ── Active ────────────────────────────────────────────────
    return new Response(JSON.stringify({
      success:  true,
      state:    'active',
      code:     code,
      package:  pkg,
      expires_at:     voucher.expires_at,
      activated_at:   voucher.used_at || null,
      remaining_secs: remainingSecs,
      total_secs:     totalSecs,
      used_secs:      usedSecs,
      bytes_in:       voucher.bytes_in  || null,
      bytes_out:      voucher.bytes_out || null
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[SESSION] ❌ Error:', error.message, error.stack);
    return new Response(JSON.stringify({
      success: false, error: 'System error — please contact support'
    }), { status: 500, headers: jsonHeaders });
  }
}

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
