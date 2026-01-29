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

    const transaction = await env.DB.prepare(
      "SELECT status FROM transactions WHERE tracking_id = ?"
    ).bind(tracking_id).first();

    if (!transaction) {
      return new Response(JSON.stringify({ status: 'NOT_FOUND', message: 'Transaction not found' }), {
        status: 404,
        headers: jsonHeaders
      });
    }

    // Normalize status for frontend
    const statusMap = {
      'PENDING': 'PENDING',
      'COMPLETED': 'SUCCESS',
      'FAILED': 'FAILED'
    };

    const frontendStatus = statusMap[transaction.status.toUpperCase()] || 'PENDING';

    return new Response(JSON.stringify({ status: frontendStatus }), {
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