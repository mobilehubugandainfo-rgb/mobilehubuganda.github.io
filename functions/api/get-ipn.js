// functions/api/payment/ipn.js
export async function onRequestPost({ request, env }) {
  try {
    // 1. Read Pesapal IPN payload (Pesapal sends FORM data, not JSON)
const raw = await request.text();
const params = new URLSearchParams(raw);

const OrderTrackingId = params.get('OrderTrackingId');
const OrderMerchantReference = params.get('OrderMerchantReference');
const OrderNotificationType = params.get('OrderNotificationType');

    // Check if any required field is missing
if (!OrderTrackingId || !OrderMerchantReference || !OrderNotificationType) {
    console.warn('[IPN] Missing required fields', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });
    // Still respond OK so Pesapal can retry later
    return new Response('OK', { status: 200 });
}

// Optional: log all parameters for debugging
console.log('[IPN RAW PARAMS]', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    console.log(`[IPN] Received: ${OrderMerchantReference}`);

    // Pesapal mainly sends IPNCHANGE — acknowledge others
    if (OrderNotificationType !== 'IPNCHANGE') {
      return new Response('OK', { status: 200 });
    }

    // 2. Authenticate with Pesapal
    const token = await getPesapalToken(env);

    // 3. Verify transaction status directly from Pesapal
    const statusRes = await fetch(
      `https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
    );

    const statusData = await statusRes.json();

    const pStatus = statusData.payment_status_description?.toUpperCase();
if (pStatus !== 'COMPLETED' && pStatus !== 'SUCCESS') {
    console.log(`[IPN] Payment not ready: ${pStatus}`);
    return new Response('OK', { status: 200 });
}

    // 4. Ensure transaction exists and is not already completed
    const tx = await env.DB.prepare(
      `SELECT status, package_type
       FROM transactions
       WHERE tracking_id = ?
       LIMIT 1`
    ).bind(OrderMerchantReference).first();

    if (!tx) return new Response('Transaction Not Found', { status: 404 });
    if (tx.status === 'COMPLETED') return new Response('OK', { status: 200 });

    // 5. Get an unused voucher for the purchased package
    const voucher = await env.DB.prepare(
      `SELECT id, code
       FROM vouchers
       WHERE package_type = ?
       AND status = 'unused'
       LIMIT 1`
    ).bind(tx.package_type).first();

    if (!voucher) {
      console.error(`[CRITICAL] No vouchers left for ${tx.package_type}`);
      return new Response('OK', { status: 200 });
    }

    // 6. Atomic DB update (voucher + transaction)
if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {
  try {
    // 5a. Get an unused voucher for the purchased package
    const voucher = await env.DB.prepare(
      `SELECT id, code
       FROM vouchers
       WHERE package_type = ?
       AND status = 'unused'
       LIMIT 1`
    ).bind(tx.package_type).first();

    if (!voucher) {
      console.error(`[CRITICAL] No vouchers left for ${tx.package_type}`);
      return new Response('OK', { status: 200 });
    }

    // 6a. Assign voucher + mark transaction completed in one batch
    await env.DB.batch([
      // 1. Assign voucher
      env.DB.prepare(
        `UPDATE vouchers 
         SET status = 'assigned', transaction_id = ?, used_at = datetime('now') 
         WHERE id = ?`
      ).bind(OrderMerchantReference, voucher.id),

      // 2. Finalize transaction
      env.DB.prepare(
        `UPDATE transactions
         SET status = 'COMPLETED',
             pesapal_transaction_id = ?, 
             voucher_id = ?,
             completed_at = datetime('now')
         WHERE tracking_id = ?`
      ).bind(OrderTrackingId, voucher.id, OrderMerchantReference)
    ]);

    console.log(`[SUCCESS] Voucher ${voucher.code} issued for ${OrderMerchantReference}`);
  } catch (err) {
    console.error('[IPN ERROR] DB update failed', err);
    return new Response('Internal Error', { status: 500 });
  }
}
    
    // 7. Required Pesapal ACK response
    // Simplified response for Pesapal
return new Response(JSON.stringify({
    "orderNotificationType": OrderNotificationType,
    "orderTrackingId": OrderTrackingId,
    "orderMerchantReference": OrderMerchantReference,
    "status": 200
}), { 
    status: 200, 
    headers: { "Content-Type": "application/json" } 
});

  } catch (err) {
    console.error('[IPN ERROR]', err);
    return new Response('Internal Error', { status: 500 });
  }
}

async function getPesapalToken(env) {
  const res = await fetch(
    'https://pay.pesapal.com/v3/api/Auth/RequestToken',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        consumer_key: env.PESAPAL_KEY,
        consumer_secret: env.PESAPAL_SECRET
      })
    }
  );

  const data = await res.json();
  if (!data.token) throw new Error('Pesapal auth failed');
  return data.token;

}
