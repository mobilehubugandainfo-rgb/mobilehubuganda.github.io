export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    
    // Attempt to get IDs from URL first, then fall back to Body
    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');
    let OrderNotificationType = url.searchParams.get('OrderNotificationType');

    if (!OrderTrackingId) {
        const raw = await request.text();
        const params = new URLSearchParams(raw);
        OrderTrackingId = params.get('OrderTrackingId');
        OrderMerchantReference = params.get('OrderMerchantReference');
        OrderNotificationType = params.get('OrderNotificationType');
    }

    // 1. If we still don't have IDs, we can't proceed
    if (!OrderTrackingId || !OrderMerchantReference) {
        return new Response('Missing Data', { status: 200 }); // Still 200 so they stop retrying
    }

    // 2. GET STATUS FROM PESAPAL (To verify they actually paid)
    const token = await getPesapalToken(env);
    const statusRes = await fetch(
      `https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    const statusData = await statusRes.json();
    const pStatus = statusData.payment_status_description?.toUpperCase();

    if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {
        // 3. Find Transaction & Voucher
        const tx = await env.DB.prepare("SELECT package_type, status FROM transactions WHERE tracking_id = ?").bind(OrderMerchantReference).first();
        
        if (tx && tx.status !== 'COMPLETED') {
            const voucher = await env.DB.prepare("SELECT id FROM vouchers WHERE package_type = ? AND status = 'unused' LIMIT 1").bind(tx.package_type).first();

            if (voucher) {
                // 4. ATOMIC UPDATE
                await env.DB.batch([
                    env.DB.prepare("UPDATE vouchers SET status = 'assigned', used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(voucher.id),
                    env.DB.prepare("UPDATE transactions SET status = 'COMPLETED', pesapal_transaction_id = ?, voucher_id = ?, completed_at = CURRENT_TIMESTAMP WHERE tracking_id = ?")
                        .bind(OrderTrackingId, voucher.id, OrderMerchantReference)
                ]);
            }
        }
    }

    // 5. Always ACKNOWLEDGE to PesaPal
    return new Response(JSON.stringify({ status: 200, orderTrackingId: OrderTrackingId }), { 
        status: 200, 
        headers: { "Content-Type": "application/json" } 
    });

  } catch (err) {
    console.error('IPN Critical Error:', err);
    return new Response('Error', { status: 500 });
  }
}

async function getPesapalToken(env) {
    const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ consumer_key: env.PESAPAL_KEY, consumer_secret: env.PESAPAL_SECRET })
    });
    const data = await res.json();
    return data.token;
}
