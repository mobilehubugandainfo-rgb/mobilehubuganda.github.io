// functions/api/payment/status.js
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
      return new Response(JSON.stringify({ status: 'ERROR', error: 'Missing tracking_id' }), {
        status: 400,
        headers: jsonHeaders
      });
    }

    // We check BOTH tracking_id (TRK-...) AND pesapal_transaction_id (GUID)
    const data = await env.DB.prepare(`
      SELECT t.status, v.code as voucherCode 
      FROM transactions t 
      LEFT JOIN vouchers v ON t.voucher_id = v.id 
      WHERE t.tracking_id = ? OR t.pesapal_transaction_id = ?
    `).bind(tracking_id, tracking_id).first();

    if (!data) { // Use 'data' here to match the variable above
      return new Response(JSON.stringify({ status: 'NOT_FOUND', message: 'Transaction not found' }), {
        status: 404,
        headers: jsonHeaders
      });
    }

    // Improved: Sends the actual DB status and the Wi-Fi code to the HTML
    return new Response(JSON.stringify({ 
      status: data.status, 
      voucherCode: data.voucherCode 
    }), {
      status: 200,
      headers: jsonHeaders
    });

  } catch (error) {
    console.error('[Payment Status Error]:', error);
    return new Response(JSON.stringify({ status: 'ERROR', error: 'Failed to retrieve transaction status' }), {
      status: 500,
      headers: jsonHeaders
    });
  }
}

// Optional CORS preflight support
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

