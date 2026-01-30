// functions/api/payment/ipn.js
export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);

    // 1️⃣ Try query parameters first
    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');
    let OrderNotificationType = url.searchParams.get('OrderNotificationType');

    // 2️⃣ Fallback to POST body if missing
    if (!OrderTrackingId || !OrderMerchantReference || !OrderNotificationType) {
      const raw = await request.text();
      const params = new URLSearchParams(raw);
      OrderTrackingId ||= params.get('OrderTrackingId');
      OrderMerchantReference ||= params.get('OrderMerchantReference');
      OrderNotificationType ||= params.get('OrderNotificationType');
    }

    // 3️⃣ Still missing required fields? ACK & exit
    if (!OrderTrackingId || !OrderMerchantReference) {
      console.warn('[IPN] Missing required fields', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });
      return new Response('OK', { status: 200 });
    }

    console.log('[IPN] Received:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    // 4️⃣ Authenticate with Pesapal
    const token = await getPesapalToken(env);

    // 5️⃣ Verify payment status
    const statusRes = await fetch(
      `https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    const statusData = await statusRes.json();
    const pStatus = statusData.payment_status_description?.toUpperCase();

    // If not completed, log & exit
    if (pStatus !== 'COMPLETED' && pStatus !== 'SUCCESS') {
      console.log(`[IPN] Payment not completed: ${pStatus} (NotificationType: ${OrderNotificationType})`);
      return new Response('OK', { status: 200 });
    }

    // 6️⃣ Fetch transaction
    const tx = await env.DB.prepare(
      `SELECT id, package_type, status
       FROM transactions
       WHERE tracking_id = ?
       LIMIT 1`
    ).bind(OrderMerchantReference).first();

    if (!tx) {
      console.warn(`[IPN] Transaction not found: ${OrderMerchantReference}`);
      return new Response('OK', { status: 200 });
    }

    if (tx.status === 'COMPLETED') {
      console.log(`[IPN] Transaction already completed: ${OrderMerchantReference}`);
      return new Response('OK', { status: 200 });
    }

    // 7️⃣ Fetch an unused voucher
    const voucher = await env.DB.prepare(
      `SELECT id, code
       FROM vouchers
       WHERE package_type = ?
         AND status = 'unused'
       LIMIT 1`
    ).bind(tx.package_type).first();

    if (!voucher) {
      console.error(`[IPN] No vouchers left for package: ${tx.package_type}`);
      return new Response('OK', { status: 200 });
    }

    // 8️⃣ Atomic update: assign voucher + mark transaction completed
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE vouchers
         SET status = 'assigned',
             transaction_id = ?,
             used_at = datetime('now')
         WHERE id = ?`
      ).bind(tx.id, voucher.id),

      env.DB.prepare(
        `UPDATE transactions
         SET status = 'COMPLETED',
             pesapal_transaction_id = ?,
             voucher_id = ?,
             completed_at = datetime('now')
         WHERE tracking_id = ?`
      ).bind(OrderTrackingId, voucher.id, OrderMerchantReference)
    ]);

    console.log(`[IPN SUCCESS] Voucher ${voucher.code} assigned to transaction ${OrderMerchantReference}`);

    // 9️⃣ Return ACK
    return new Response(JSON.stringify({
      status: 200,
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      notificationType: OrderNotificationType,
      paymentStatus: pStatus
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error('[IPN ERROR] Critical:', err);
    return new Response('Internal Error', { status: 500 });
  }
}

// Helper function to get Pesapal token
async function getPesapalToken(env) {
  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ consumer_key: env.PESAPAL_KEY, consumer_secret: env.PESAPAL_SECRET })
  });
  const data = await res.json();
  if (!data.token) throw new Error('Pesapal auth failed');
  return data.token;
}
