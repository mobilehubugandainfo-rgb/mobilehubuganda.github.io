export async function onRequestGet({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const url = new URL(request.url);
    const tracking_id = url.searchParams.get('tracking_id') || url.searchParams.get('id');

    if (!tracking_id) {
      return new Response(JSON.stringify({ 
        status: 'ERROR', 
        message: 'Missing tracking ID' 
      }), { status: 400, headers: jsonHeaders });
    }

    // 1️⃣ Fetch transaction + linked voucher in a single query
    const data = await env.DB.prepare(`
      SELECT 
        t.status AS paymentStatus, 
        t.package_type AS packageType,
        v.code AS voucherCode
      FROM transactions t
      LEFT JOIN vouchers v ON t.voucher_id = v.id
      WHERE t.tracking_id = ?
    `).bind(tracking_id).first();

    // 2️⃣ Transaction not found
    if (!data) {
      console.warn(`[Voucher Check] Unknown tracking ID: ${tracking_id}`);
      return new Response(JSON.stringify({ 
        status: 'NOT_FOUND', 
        message: 'Transaction reference not recognized.' 
      }), { status: 404, headers: jsonHeaders });
    }

    // 3️⃣ Payment pending or voucher not yet assigned
    if (data.paymentStatus !== 'COMPLETED' || !data.voucherCode) {
      return new Response(JSON.stringify({ 
        status: 'PENDING',
        message: 'Payment is being processed. Please wait...',
        retry_after: 3 // Frontend can poll every 3 seconds
      }), { status: 200, headers: jsonHeaders });
    }

    // 4️⃣ Success
    return new Response(JSON.stringify({
      status: 'SUCCESS',
      voucherCode: data.voucherCode,
      package: data.packageType,
      trackingId: tracking_id
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error(`[Get Voucher Error] Tracking ID: ${request.url}`, error);
    return new Response(JSON.stringify({ 
      status: 'ERROR', 
      message: 'Failed to retrieve voucher details.'
    }), { status: 500, headers: jsonHeaders });
  }
}

// Optional: Handle preflight requests
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}