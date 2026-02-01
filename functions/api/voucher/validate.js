// functions/api/voucher/validate.js
// Works with D1 database (your actual system)

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
        v.transaction_id
      FROM vouchers v
      WHERE v.code = ? 
      AND v.status IN ('assigned', 'unused')
    `).bind(voucherCode).first();

    console.log('[VALIDATE] Database result:', voucher);

    if (!voucher) {
      console.warn('[VALIDATE] ❌ Voucher not found or already used:', voucherCode);
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid, expired, or already used voucher code'
      }), { 
        status: 200, 
        headers: jsonHeaders 
      });
    }

    console.log('[VALIDATE] ✅ Voucher found:', voucher.code);

    // 2️⃣ Mark as used (prevents re-use)
    const updateResult = await env.DB.prepare(`
      UPDATE vouchers 
      SET status = 'used', 
          used_at = datetime('now') 
      WHERE id = ? 
      AND status IN ('assigned', 'unused')
    `).bind(voucher.id).run();

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

    // 3️⃣ Map package to profile
    const profileMap = {
      'free-trial': 'free-trial',
      'p1': 'p1',
      'p2': 'p2',
      'p3': 'p3',
      'p4': 'p4'
    };
    
    const profile = profileMap[voucher.package_type.toLowerCase()] || 'p2';

    console.log('[VALIDATE] ✅ Voucher validated successfully');

    // 4️⃣ Return success
    return new Response(JSON.stringify({
      success: true,
      code: voucherCode,
      password: 'hub123',
      package: voucher.package_type,
      profile: profile
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
