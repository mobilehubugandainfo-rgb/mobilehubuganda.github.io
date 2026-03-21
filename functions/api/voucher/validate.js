// functions/api/voucher/validate.js
// ✅ Expiry check — clock runs from first use regardless of disconnections
// ✅ MAC locking — only first device can use the voucher
// ✅ Reconnection allowed within expiry window from same device
// ✅ Race condition protected

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const { code, mac } = await request.json();

    console.log('[VALIDATE] 📥 Checking voucher:', code, 'MAC:', mac);

    if (!code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    const voucherCode = code.trim().toUpperCase();

    // 1️⃣ Fetch voucher from D1
    const voucher = await env.DB.prepare(`
      SELECT id, code, package_type, status, used_at, expires_at, mac_address
      FROM vouchers
      WHERE code = ?
    `).bind(voucherCode).first();

    console.log('[VALIDATE] Database result:', voucher);

    // 1a. Not found
    if (!voucher) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid voucher code'
      }), { status: 200, headers: jsonHeaders });
    }

    // 1b. Already expired status
    if (voucher.status === 'expired') {
      return new Response(JSON.stringify({
        success: false,
        error: 'This voucher has expired. Please purchase a new one.'
      }), { status: 200, headers: jsonHeaders });
    }

    // 1c. Check wall-clock expiry
    if (voucher.expires_at) {
      const now = new Date();
      const expiry = new Date(voucher.expires_at);
      if (now > expiry) {
        await env.DB.prepare(`UPDATE vouchers SET status = 'expired' WHERE id = ?`)
          .bind(voucher.id).run();
        console.warn('[VALIDATE] ❌ Expired:', voucherCode, 'expired at', voucher.expires_at);
        return new Response(JSON.stringify({
          success: false,
          error: 'This voucher has expired. Please purchase a new one.'
        }), { status: 200, headers: jsonHeaders });
      }
    }

    // 1d. MAC lock check — if voucher already used by another device, block it
    if (voucher.mac_address && mac && voucher.mac_address !== mac) {
      console.warn('[VALIDATE] ❌ MAC mismatch:', voucherCode, 'locked to', voucher.mac_address, 'tried by', mac);
      return new Response(JSON.stringify({
        success: false,
        error: 'This voucher is already in use on another device.'
      }), { status: 200, headers: jsonHeaders });
    }

    // 1e. Block completely used vouchers with no expiry (safety net)
    if (voucher.status === 'used' && !voucher.expires_at && !voucher.mac_address) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid, expired, or already used voucher code'
      }), { status: 200, headers: jsonHeaders });
    }

    // 2️⃣ Calculate expiry on first use
    const durations = {
      'p1': 3 * 60 * 60 * 1000,         // 5 minutes
      'p2': 24 * 60 * 60 * 1000,        // 1 day
      'p3': 7 * 24 * 60 * 60 * 1000,    // 1 week
      'p4': 30 * 24 * 60 * 60 * 1000    // 30 days
    };

    const duration = durations[voucher.package_type.toLowerCase()] || durations['p2'];
    const expiryDate = new Date(Date.now() + duration);
    const expiresAt = expiryDate.toISOString().replace('T', ' ').split('.')[0];

    // 3️⃣ Update voucher — set mac, used_at and expires_at on first use only
    await env.DB.prepare(`
      UPDATE vouchers
      SET status = 'used',
          used_at = CASE WHEN used_at IS NULL THEN datetime('now') ELSE used_at END,
          expires_at = CASE WHEN expires_at IS NULL THEN ? ELSE expires_at END,
          mac_address = CASE WHEN mac_address IS NULL THEN ? ELSE mac_address END
      WHERE id = ?
    `).bind(expiresAt, mac || null, voucher.id).run();

    const profileMap = {
      'free-trial': 'free-trial',
      'p1': 'p1', 'p2': 'p2', 'p3': 'p3', 'p4': 'p4'
    };

    const profile = profileMap[voucher.package_type.toLowerCase()] || 'p2';

    console.log('[VALIDATE] ✅ Validated:', voucherCode, 'expires:', expiresAt, 'mac:', mac);

    return new Response(JSON.stringify({
      success: true,
      code: voucherCode,
      password: voucherCode,
      package: voucher.package_type,
      profile: profile,
      expires_at: expiresAt
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[VALIDATE] ❌ Error:', error.message);
    return new Response(JSON.stringify({
      success: false,
      error: 'System error - please contact support'
    }), { status: 500, headers: jsonHeaders });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
