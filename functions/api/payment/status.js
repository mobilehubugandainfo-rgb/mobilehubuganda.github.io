// functions/api/payment/status.js
// Improved version with enhanced logging for debugging

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
    
    console.log('[STATUS] 📥 Request received:', { 
      tracking_id, 
      url: request.url,
      timestamp: new Date().toISOString()
    });

    if (!tracking_id) {
      console.warn('[STATUS] ⚠️ Missing tracking_id parameter');
      return new Response(JSON.stringify({ 
        status: 'ERROR', 
        error: 'Missing tracking_id' 
      }), {
        status: 400,
        headers: jsonHeaders
      });
    }

    // Query database - checking both tracking_id and pesapal_transaction_id
    console.log('[STATUS] 🔍 Querying database for:', tracking_id);
    
    const data = await env.DB.prepare(`
      SELECT 
        t.id,
        t.tracking_id,
        t.pesapal_transaction_id,
        t.status, 
        t.package_type,
        t.amount,
        t.voucher_id,
        t.created_at,
        t.completed_at,
        v.code as voucherCode,
        v.status as voucherStatus
      FROM transactions t 
      LEFT JOIN vouchers v ON t.voucher_id = v.id 
      WHERE t.tracking_id = ? OR t.pesapal_transaction_id = ?
    `).bind(tracking_id, tracking_id).first();

    if (!data) {
      console.warn('[STATUS] ⚠️ Transaction not found:', tracking_id);
      return new Response(JSON.stringify({ 
        status: 'NOT_FOUND', 
        message: 'Transaction not found',
        tracking_id 
      }), {
        status: 404,
        headers: jsonHeaders
      });
    }

    // Log what we found
    console.log('[STATUS] ✅ Transaction found:', {
      tracking_id: data.tracking_id,
      status: data.status,
      voucher_id: data.voucher_id,
      voucherCode: data.voucherCode,
      voucherStatus: data.voucherStatus,
      package_type: data.package_type,
      amount: data.amount
    });

    // Build response
    const response = { 
      status: data.status, 
      voucherCode: data.voucherCode || null,
      tracking_id: data.tracking_id,
      package_type: data.package_type,
      amount: data.amount
    };

    // Add debug info if voucher should exist but doesn't
    if (data.status === 'COMPLETED' && !data.voucherCode) {
      console.error('[STATUS] ❌ CRITICAL: Transaction is COMPLETED but no voucher assigned!', {
        transaction_id: data.id,
        tracking_id: data.tracking_id,
        voucher_id: data.voucher_id,
        completed_at: data.completed_at
      });
      
      response.debug = {
        issue: 'Transaction completed but voucher missing',
        voucher_id: data.voucher_id,
        suggestion: 'Check IPN logs or manually assign voucher'
      };
    }

    console.log('[STATUS] 📤 Sending response:', response);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: jsonHeaders
    });

  } catch (error) {
    console.error('[STATUS] ❌ Error:', error.message);
    console.error('[STATUS] Stack:', error.stack);
    
    return new Response(JSON.stringify({ 
      status: 'ERROR', 
      error: 'Failed to retrieve transaction status',
      message: error.message 
    }), {
      status: 500,
      headers: jsonHeaders
    });
  }
}

// CORS preflight support
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
