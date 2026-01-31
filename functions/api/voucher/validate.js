// functions/api/voucher/validate.js
// Fixed version with correct response fields and package mapping

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const { code } = await request.json();
    
    console.log('[VALIDATE] 📥 Request received:', { code });

    if (!code) {
      console.warn('[VALIDATE] ⚠️ Missing code');
      return new Response(JSON.stringify({ 
        success: false,  // ✅ Changed from "valid" to "success"
        error: 'Voucher code is required.' 
      }), {
        status: 400,
        headers: jsonHeaders
      });
    }

    const voucherCode = code.trim().toUpperCase();
    console.log('[VALIDATE] 🔍 Checking voucher:', voucherCode);

    // 1️⃣ Check voucher validity - WITH LOGGING
    const voucher = await env.DB.prepare(`
      SELECT 
        v.id, 
        v.code,
        v.package_type, 
        v.status,
        v.transaction_id,
        v.used_at
      FROM vouchers v
      WHERE v.code = ? 
      AND v.status IN ('assigned', 'unused')
    `).bind(voucherCode).first();

    console.log('[VALIDATE] Database result:', voucher);

    if (!voucher) {
      console.warn('[VALIDATE] ❌ Voucher not found or already used:', voucherCode);
      return new Response(JSON.stringify({
        success: false,  // ✅ Changed from "valid" to "success"
        error: 'Invalid, expired, or already active voucher code.'
      }), { 
        status: 200, 
        headers: jsonHeaders 
      });
    }

    console.log('[VALIDATE] ✅ Voucher found:', {
      id: voucher.id,
      package_type: voucher.package_type,
      status: voucher.status
    });

    // 2️⃣ Atomic update to mark as 'used'
    console.log('[VALIDATE] 🔄 Marking voucher as used...');
    const updateResult = await env.DB.prepare(`
      UPDATE vouchers 
      SET status = 'used', 
          used_at = datetime('now') 
      WHERE id = ? 
      AND status IN ('assigned', 'unused')
    `).bind(voucher.id).run();

    console.log('[VALIDATE] Update result:', updateResult.meta);

    if (updateResult.meta.changes === 0) {
      console.warn('[VALIDATE] ⚠️ Race condition detected for', voucherCode);
      return new Response(JSON.stringify({
        success: false,  // ✅ Changed from "valid" to "success"
        error: 'Voucher was already processed by another request.'
      }), { 
        status: 409, 
        headers: jsonHeaders 
      });
    }

    // 3️⃣ Map package to duration and rate limits
    // ✅ FIXED: Added support for shorthand package types
    const packageMap = {
      // Shorthand package types (from database)
      'p1': { minutes: 35, rate_limit: '2M/2M', name: 'Basic Package' },
      'p2': { minutes: 120, rate_limit: '4M/4M', name: 'Standard Package' },
      'p3': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium 24hr' },
      'p4': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium Plus 24hr' },
      
      // Full package type names (for backward compatibility)
      'free-trial-5min': { minutes: 5, rate_limit: '2M/2M', name: 'Free Trial' },
      '250ugx-35min': { minutes: 35, rate_limit: '2M/2M', name: 'Basic Package' },
      '500ugx-2hrs': { minutes: 120, rate_limit: '4M/4M', name: 'Standard Package' },
      '1000ugx-24hrs': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium 24hr' },
      '1500ugx-24hrs': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium Plus 24hr' }
    };

    const pkg = packageMap[voucher.package_type.toLowerCase()] || { 
      minutes: 5, 
      rate_limit: '2M/2M',
      name: 'Default Package'
    };

    console.log('[VALIDATE] 📦 Package mapping:', {
      input: voucher.package_type,
      mapped: pkg
    });

    // 4️⃣ Response for router/login
    const response = {
      success: true,  // ✅ Changed from "valid" to "success"
      code: voucherCode,
      package: voucher.package_type,
      package_name: pkg.name,
      minutes: pkg.minutes,
      rate_limit: pkg.rate_limit,
      password: 'hub123'  // ✅ Added password field (login.html expects this)
    };

    console.log('[VALIDATE] ✅ Validation successful:', response);

    return new Response(JSON.stringify(response), { 
      status: 200, 
      headers: jsonHeaders 
    });

  } catch (error) {
    console.error('[VALIDATE] ❌ Error:', error.message);
    console.error('[VALIDATE] Stack:', error.stack);
    
    return new Response(JSON.stringify({
      success: false,  // ✅ Changed from "valid" to "success"
      error: 'Validation system error. Please contact support.'
    }), { 
      status: 500, 
      headers: jsonHeaders 
    });
  }
}

// CORS preflight handler
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
