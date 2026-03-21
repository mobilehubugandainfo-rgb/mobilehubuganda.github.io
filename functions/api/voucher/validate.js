// functions/api/voucher/validate.js
// ✅ Expiry check on every login attempt
// ✅ Sets expires_at on first use only
// ✅ Blocks expired vouchers with clear message
// ✅ Allows reconnection within expiry window
// ✅ Race condition protected

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const { code } = await request.json();

    console.log('[VALIDATE] 📥 Checking voucher:', code);

    if (!code) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Voucher code is required'
      }), {
        status: 400,
        headers: jsonHeaders
      });
    }

    const voucherCode = code.trim().toUpperCase();

    // 1️⃣ Check voucher in D1 database
    const voucher = await env.DB.prepare(`
      SELECT 
        v.id, 
        v.code,
        v.package_type, 
        v.status,
        v.transaction_id,
        v.used_at,
        v.expires_at
      FROM vouchers v
      WHERE v.code = ? 
      AND v.status IN ('assigned', 'unused', 'used')
    `).bind(voucherCode).first();

    console.log('[VALIDATE] Database result:', voucher);

    // 1a. Voucher not found
    if (!voucher) {
      console.warn('[VALIDATE] ❌ Voucher not found:', voucherCode);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid voucher code'
      }), {
        status: 200,
        headers: jsonHeaders
      });
    }

    // 1b. Check if voucher has expired
    if (voucher.expires_at) {
      const now = new Date();
      const expiry = new Date(voucher.expires_at);
      if (now > expiry) {
        console.warn('[VALIDATE] ❌ Voucher expired:', voucherCode, 'expired at', voucher.expires_at);
        await env.DB.prepare(`
          UPDATE vouchers SET status = 'expired' WHERE id = ?
        `).bind(voucher.id).run();
        return new Response(JSON.stringify({
          success: false,
          error: 'This voucher has expired. Please purchase a new one.'
        }), {
          status: 200,
          headers: jsonHeaders
        });
      }
    }

    // 2️⃣ Calculate expiry on first use
    const durations = {
      'p1': 3 * 60 * 60 * 1000,           // 3 hours
      'p2': 24 * 60 * 60 * 1000,          // 1 day
      'p3': 7 * 24 * 60 * 60 * 1000,      // 1 week
      'p4': 30 * 24 * 60 * 60 * 1000      // 30 days
    };

    const duration = durations[voucher.package_type.toLowerCase()] || durations['p2'];
    const expiryDate = new Date(Date.now() + duration);
    const expiresAt = expiryDate.toISOString().replace('T', ' ').split('.')[0];

    // 3️⃣ Update voucher — set used_at and expires_at on first use only
    const updateResult = await env.DB.prepare(`
      UPDATE vouchers 
      SET status = 'used',
          used_at = CASE WHEN used_at IS NULL THEN datetime('now') ELSE used_at END,
          expires_at = CASE WHEN expires_at IS NULL THEN ? ELSE expires_at END
      WHERE id = ? 
      AND status IN ('assigned', 'unused', 'used')
    `).bind(expiresAt, voucher.id).run();

    if (updateResult.meta.changes === 0) {
      console.warn('[VALIDATE] ⚠️ Race condition - voucher already used');
      return new Response(JSON.stringify({
        success: false,
        error: 'Voucher was just used by another request'
      }), {
        status: 409,
        headers: jsonHeaders
      });
    }

    // 4️⃣ Map package to profile
    const profileMap = {
      'free-trial': 'free-trial',
      'p1': 'p1',
      'p2': 'p2',
      'p3': 'p3',
      'p4': 'p4'
    };

    const profile = profileMap[voucher.package_type.toLowerCase()] || 'p2';

    console.log('[VALIDATE] ✅ Voucher validated successfully:', voucherCode, 'expires at:', expiresAt);

    // 5️⃣ Return success
    return new Response(JSON.stringify({
      success: true,
      code: voucherCode,
      password: voucherCode,
      package: voucher.package_type,
      profile: profile,
      expires_at: expiresAt
    }), {
      status: 200,
      headers: jsonHeaders
    });

  } catch (error) {
    console.error('[VALIDATE] ❌ Error:', error.message);
    console.error('[VALIDATE] Stack:', error.stack);

    return new Response(JSON.stringify({
      success: false,
      error: 'System error - please contact support'
    }), {
      status: 500,
      headers: jsonHeaders
    });
  }
}

// CORS preflight
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
