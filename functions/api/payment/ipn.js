// functions/api/payment/ipn.js
export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);

    // 1️⃣ Try query parameters first (Matches the URL format seen in your logs)
    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');
    let OrderNotificationType = url.searchParams.get('OrderNotificationType');

    // 2️⃣ Fallback to POST body if parameters weren't in the URL
    if (!OrderTrackingId || !OrderMerchantReference) {
      const raw = await request.text();
      const params = new URLSearchParams(raw);
      OrderTrackingId ||= params.get('OrderTrackingId');
      OrderMerchantReference ||= params.get('OrderMerchantReference');
      OrderNotificationType ||= params.get('OrderNotificationType');
    }

    // 3️⃣ Verify we have the minimum required IDs to proceed
    if (!OrderTrackingId || !OrderMerchantReference) {
      console.warn('[IPN] Missing required fields. IDs not found.');
      return new Response('OK', { status: 200 });
    }

    console.log('[IPN] Received Data:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    // 4️⃣ Authenticate with Pesapal
    const token = await getPesapalToken(env);

    // 5️⃣ Verify payment status directly from Pesapal (The source of truth)
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

    // If payment isn't successful yet, stop here but tell Pesapal 'OK' so they retry later
    if (pStatus !== 'COMPLETED' && pStatus !== 'SUCCESS') {
      console.log(`[IPN] Payment status: ${pStatus}. Waiting for completion.`);
      return new Response('OK', { status: 200 });
    }

    // 6️⃣ Fetch the original transaction from your D1 database
    const tx = await env.DB.prepare(
      "SELECT id, package_type, status FROM transactions WHERE tracking_id = ? LIMIT 1"
    ).bind(OrderMerchantReference).first();

    if (!tx) {
      console.warn(`[IPN] Transaction ${OrderMerchantReference} not found in DB.`);
      return new Response('OK', { status: 200 });
    }

    // If it's already marked completed, don't issue another voucher
    if (tx.status === 'COMPLETED') {
      console.log(`[IPN] Transaction ${OrderMerchantReference} already processed.`);
      return new Response('OK', { status: 200 });
    }

    // 7️⃣ Fetch one unused voucher for this specific package (p1, p2, etc.)
    const voucher = await env.DB.prepare(
      "SELECT id, code FROM vouchers WHERE package_type = ? AND status = 'unused' LIMIT 1"
    ).bind(tx.package_type).first();

    if (!voucher) {
      console.error(`[CRITICAL] Out of stock for package: ${tx.package_type}`);
      return new Response('OK', { status: 200 });
    }

    // 8️⃣ Atomic update: mark voucher as used AND transaction as completed
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE vouchers SET status = 'assigned', used_at = datetime('now') WHERE id = ?"
      ).bind(voucher.id),

      env.DB.prepare(
        "UPDATE transactions SET status = 'COMPLETED', pesapal_transaction_id = ?, voucher_id = ?, completed_at = datetime('now') WHERE tracking_id = ?"
      ).bind(OrderTrackingId, voucher.id, OrderMerchantReference)
    ]);

    console.log(`[IPN SUCCESS] Issued voucher ${voucher.code} for ${OrderMerchantReference}`);

    // 9️⃣ Final ACK to Pesapal so they stop sending this specific notification
    return new Response(JSON.stringify({
      status: 200,
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error('[IPN ERROR] Critical failure:', err);
    return new Response('Internal Error', { status: 500 });
  }
}

// Helper function to get the Pesapal Access Token
async function getPesapalToken(env) {
  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ 
      consumer_key: env.PESAPAL_KEY, 
      consumer_secret: env.PESAPAL_SECRET 
    })
  });
  const data = await res.json();
  if (!data.token) throw new Error('Pesapal auth failed');
  return data.token;
}
