// functions/api/voucher/validate.js
// Fixed version with correct response fields and package mapping
// ✅ CORRECTED: Profile names match MikroTik exactly (p1, p2, p3, p4)

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
        success: false,
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
        success: false,
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
        success: false,
        error: 'Voucher was already processed by another request.'
      }), { 
        status: 409, 
        headers: jsonHeaders 
      });
    }

    // 3️⃣ Map package to duration and rate limits
    // ✅ CORRECTED: Updated to match MikroTik profile names exactly
    const packageMap = {
      // Shorthand package types (from database)
      'p1': { minutes: 35, rate_limit: '2M/2M', name: 'Basic Package', profile: 'p1' },
      'p2': { minutes: 120, rate_limit: '4M/4M', name: 'Standard Package', profile: 'p2' },
      'p3': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium 24hr', profile: 'p3' },
      'p4': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium Plus 24hr', profile: 'p4' },
      
      // Full package type names (for backward compatibility)
      'free-trial-5min': { minutes: 5, rate_limit: '2M/2M', name: 'Free Trial', profile: 'p1' },
      '250ugx-35min': { minutes: 35, rate_limit: '2M/2M', name: 'Basic Package', profile: 'p1' },
      '500ugx-2hrs': { minutes: 120, rate_limit: '4M/4M', name: 'Standard Package', profile: 'p2' },
      '1000ugx-24hrs': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium 24hr', profile: 'p3' },
      '1500ugx-24hrs': { minutes: 1440, rate_limit: '10M/10M', name: 'Premium Plus 24hr', profile: 'p4' }
    };

    // ✅ CORRECTED: Default fallback uses 'p2' instead of 'p2-profile'
    const pkg = packageMap[voucher.package_type.toLowerCase()] || { 
      minutes: 5, 
      rate_limit: '2M/2M',
      name: 'Default Package',
      profile: 'p2'
    };

    console.log('[VALIDATE] 📦 Package mapping:', {
      input: voucher.package_type,
      mapped: pkg
    });

    // 4️⃣ OPTIONAL: Create user in MikroTik dynamically
    // Set ENABLE_DYNAMIC_MIKROTIK=true in environment variables to enable
    if (env.ENABLE_DYNAMIC_MIKROTIK === 'true') {
      try {
        console.log('[VALIDATE] 🔄 Creating MikroTik user...');
        
        const mikrotikResponse = await fetch(`${new URL(request.url).origin}/api/mikrotik/create-user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: voucherCode,
            password: 'hub123',
            package_type: voucher.package_type
          })
        });

        const mikrotikResult = await mikrotikResponse.json();
        console.log('[VALIDATE] MikroTik creation result:', mikrotikResult);
        
        if (!mikrotikResult.success) {
          console.warn('[VALIDATE] ⚠️ MikroTik creation failed, but continuing...');
          // Don't fail the whole validation - user might already exist in MikroTik
        }
      } catch (mikrotikError) {
        console.error('[VALIDATE] ⚠️ MikroTik API error:', mikrotikError.message);
        // Don't fail - continue anyway (user might be pre-created)
      }
    } else {
      console.log('[VALIDATE] ℹ️ Dynamic MikroTik creation disabled (users should be pre-created)');
    }

    // 5️⃣ Response for router/login
    const response = {
      success: true,
      code: voucherCode,
      package: voucher.package_type,
      package_name: pkg.name,
      minutes: pkg.minutes,
      rate_limit: pkg.rate_limit,
      password: 'hub123'
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
      success: false,
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
