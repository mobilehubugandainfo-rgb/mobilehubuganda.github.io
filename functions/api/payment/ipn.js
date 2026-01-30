// functions/api/payment/ipn.js
export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);

    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');

    if (!OrderTrackingId || !OrderMerchantReference) {
      const raw = await request.text();
      const params = new URLSearchParams(raw);
      OrderTrackingId = OrderTrackingId || params.get('OrderTrackingId');
      OrderMerchantReference = OrderMerchantReference || params.get('OrderMerchantReference');
    }

    if (!OrderTrackingId || !OrderMerchantReference) {
      return new Response('OK', { status: 200 });
    }

    const authRes = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ 
        consumer_key: env.PESAPAL_KEY, 
        consumer_secret: env.PESAPAL_SECRET 
      })
    });
    const authData = await authRes.json();
    const token = authData.token;

    const statusRes = await fetch(`https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const statusData = await statusRes.json();
    const pStatus = (statusData.payment_status_description || "").toUpperCase();

    if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {
      const tx = await env.DB.prepare(
        "SELECT id, package_type FROM transactions WHERE tracking_id = ? AND status = 'PENDING'"
      ).bind(OrderMerchantReference).first();

      if (tx) {
        const voucher = await env.DB.prepare(
          "SELECT id, code FROM vouchers WHERE package_type = ? AND status = 'unused' LIMIT 1"
        ).bind(tx.package_type).first();

        if (voucher) {
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE vouchers SET status = 'assigned', transaction_id = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).bind(OrderMerchantReference, voucher.id),
            
            env.DB.prepare(
              "UPDATE transactions SET status = 'COMPLETED', pesapal_transaction_id = ?, voucher_id = ?, completed_at = CURRENT_TIMESTAMP WHERE tracking_id = ?"
            ).bind(OrderTrackingId, voucher.id, OrderMerchantReference)
          ]);
        }
      }
    }

    return new Response(JSON.stringify({ status: 200 }), { 
      status: 200, 
      headers: { "Content-Type": "application/json" } 
    });

  } catch (err) {
    return new Response('Error', { status: 200 });
  }
}
