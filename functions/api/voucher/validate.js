export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const { code } = await request.json();

    if (!code) {
      return new Response(JSON.stringify({ valid: false, error: 'Voucher code is required.' }), {
        status: 400,
        headers: jsonHeaders
      });
    }

    const voucherCode = code.trim().toUpperCase();

    // 1️⃣ Check voucher validity
    const voucher = await env.DB.prepare(`
      SELECT id, package_type, status 
      FROM vouchers 
      WHERE code = ? AND status IN ('assigned', 'unused')
    `).bind(voucherCode).first();

    if (!voucher) {
      console.warn(`[Voucher Validation] Invalid or already used voucher: ${voucherCode}`);
      return new Response(JSON.stringify({
        valid: false,
        error: 'Invalid, expired, or already active voucher code.'
      }), { status: 200, headers: jsonHeaders });
    }

    // 2️⃣ Atomic update to mark as 'used'
    const updateResult = await env.DB.prepare(`
      UPDATE vouchers 
      SET status = 'used', used_at = datetime('now') 
      WHERE id = ? AND status IN ('assigned', 'unused')
    `).bind(voucher.id).run();

    if (updateResult.meta.changes === 0) {
      console.warn(`[Voucher Validation] Race condition detected for ${voucherCode}`);
      return new Response(JSON.stringify({
        valid: false,
        error: 'Voucher was already processed by another request.'
      }), { status: 409, headers: jsonHeaders });
    }

    // 3️⃣ Map package to duration and rate limits
    const packageMap = {
      'free-trial-5min': { minutes: 5, rate_limit: '2M/2M' },
      '250ugx-35min': { minutes: 35, rate_limit: '2M/2M' },
      '500ugx-2hrs': { minutes: 120, rate_limit: '4M/4M' },
      '1000ugx-24hrs': { minutes: 1440, rate_limit: '10M/10M' },
      '1500ugx-24hrs': { minutes: 1440, rate_limit: '10M/10M' }
    };

    const pkg = packageMap[voucher.package_type] || { minutes: 5, rate_limit: '2M/2M' };

    // 4️⃣ Response for router/login
    return new Response(JSON.stringify({
      valid: true,
      code: voucherCode,
      package: voucher.package_type,
      minutes: pkg.minutes,
      rate_limit: pkg.rate_limit
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[Voucher Validation Error]:', error);
    return new Response(JSON.stringify({
      valid: false,
      error: 'Validation system error. Please contact support.'
    }), { status: 500, headers: jsonHeaders });
  }
}

// Optional: CORS preflight handler
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