// functions/api/voucher/free-trial.js
// functions/api/voucher/free-trial.js
export async function onRequestPost({ request, env }) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    // 1️⃣ Identify the user (Security: IP fallback if deviceId is missing)
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    
    // Safety: try/catch the JSON parsing in case body is empty
    let payload = {};
    try {
      payload = await request.json();
    } catch (e) {
      payload = {};
    }

    const deviceId = payload.deviceId || ip; 

    if (deviceId === 'unknown') {
      throw new Error('Unable to identify client');
    }

    // 2️⃣ Check 24-hour limit (Security: Prevents multiple uses per device)
    const recentTrial = await env.DB.prepare(
      `SELECT 1 FROM vouchers
       WHERE device_id = ? 
       AND package_type = 'free-trial'
       AND created_at > datetime('now','-1 day')
       LIMIT 1`
    ).bind(deviceId).first();

    if (recentTrial) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Free trial already claimed today. Try again in 24 hours.'
      }), { status: 403, headers });
    }

    // 3️⃣ Assign voucher atomically
    // We update the timestamp to 'now' so the 24-hr lockout starts from this exact moment
    const voucher = await env.DB.prepare(
      `UPDATE vouchers
       SET status = 'assigned',
           device_id = ?,
           used_at = datetime('now'),
           created_at = datetime('now')
       WHERE id = (
         SELECT id FROM vouchers
         WHERE package_type = 'free-trial'
         AND status = 'unused'
         LIMIT 1
       )
       RETURNING code`
    ).bind(deviceId).first();

    if (!voucher) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Free trial vouchers are out of stock. Please try later or purchase a bundle.'
      }), { status: 404, headers });
    }

    // 4️⃣ Return the voucher code
    return new Response(JSON.stringify({
      success: true,
      code: voucher.code
    }), { status: 200, headers });

  } catch (error) {
    console.error('[Free Trial Error]', error);
    return new Response(JSON.stringify({
      success: false,
      message: 'Unable to process request. Please ensure you are connected to HotSpotCentral.'
    }), { status: 500, headers });
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
