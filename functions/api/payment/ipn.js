// functions/api/payment/ipn.js
export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);

    // 1️⃣ Grab IDs from URL (PesaPal's preferred method) or Body
    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');

    if (!OrderTrackingId || !OrderMerchantReference) {
      const raw = await request.text();
      const params = new URLSearchParams(raw);
      OrderTrackingId ||= params.get('OrderTrackingId');
      OrderMerchantReference ||= params.get('OrderMerchantReference');
    }

    if (!OrderTrackingId || !OrderMerchantReference) {
      return new Response('OK', { status: 200 });
    }

    // 2️⃣ Get PesaPal Token
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

    // 3️⃣ Verify Payment Status with PesaPal
    const statusRes = await fetch(`https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const statusData = await statusRes.json();
    const pStatus = statusData.payment_status_description?.toUpperCase();

    // 4️⃣ Process Completion
    if (pStatus === 'COMPLETED' || pStatus === 'SUCCESS') {
      
      // Get the transaction details
      const tx = await env.DB.prepare(
        "SELECT id, package_type FROM transactions WHERE tracking_id = ? AND status = 'PENDING'"
      ).bind(OrderMerchantReference).first();

      if (tx) {
        // Find an unused voucher
        const voucher = await env.DB.prepare(
          "SELECT id, code FROM vouchers WHERE package_type = ? AND status = 'unused' LIMIT 1"
        ).bind(tx.package_type).first();

        if (voucher) {
          // 5️⃣ ATOMIC BATCH UPDATE (Mapped exactly to your PRAGMA results)
          await env.DB.batch([
            // Update Voucher: Mark as assigned and link to the transaction row ID
            env.DB.prepare(`
              UPDATE vouchers 
              SET status = 'assigned', 
                  transaction_id = ?, 
                  used_at = CURRENT_TIMESTAMP 
              WHERE id = ?
            `).bind(OrderMerchantReference, voucher.id),
            
            // Update Transaction: Mark as completed and link the voucher ID
            env.DB.prepare(`
              UPDATE transactions 
              SET status = 'COMPLETED', 
                  pesapal_transaction_id = ?, 
                  voucher_id = ?, 
                  completed_at = CURRENT_TIMESTAMP 
              WHERE tracking_id = ?
            `).bind(OrderTrackingId, voucher.id, OrderMerchantReference)
          ]);
          
          console.log(`[IPN SUCCESS] Issued ${voucher.code} for Ref: ${OrderMerchantReference}`);
        } else {
          console.error(`[STOCK ALERT] No vouchers left for ${tx.package_type}`);
        }
      }
    }

    // Always respond 200 so PesaPal stops retrying
    return new Response(JSON.stringify({ status: 200 }), { 
      status: 200, 
      headers: { "Content-Type": "application/json" } 
    });

  } catch (err) {
    console.error('IPN Critical Error:', err.message);
    return new Response('Error', { status: 200 });
  }
}
