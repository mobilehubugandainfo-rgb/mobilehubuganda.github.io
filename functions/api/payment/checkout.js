// functions/api/payment/checkout.js
export async function onRequestPost({ request, env }) {
  const jsonHeader = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    // UPDATED: Extraction to match your index.html keys (package_id and phone)
    const { package_id, phone, email } = await request.json();

    /* ============================================
       1. PACKAGE VALIDATION (Mapped to index.html IDs)
       ============================================ */
    const packages = {
      'p1': 250,
      'p2': 500,
      'p3': 1000,
      'p4': 1500
    };

    const amount = packages[package_id];
    // We'll use package_type internally to keep your DB logic consistent
    const package_type = package_id; 

    if (!amount) {
      return new Response(
        JSON.stringify({ error: `Invalid package (${package_id}) selected. Please refresh and try again.` }),
        { status: 400, headers: jsonHeader }
      );
    }

    /* ============================================
       2. VOUCHER STOCK CHECK
       ============================================ */
    const stockCheck = await env.DB.prepare(
      `SELECT COUNT(*) as count 
       FROM vouchers 
       WHERE package_type = ? 
       AND status = 'unused'`
    ).bind(package_type).first();

    if (!stockCheck || stockCheck.count === 0) {
      return new Response(
        JSON.stringify({
          error: 'Sorry, vouchers for this package are currently out of stock. Try another package or contact support.'
        }),
        { status: 400, headers: jsonHeader }
      );
    }

    /* ============================================
       3. PHONE VALIDATION
       ============================================ */
    // Using 'phone' from the frontend
    const normalizedPhone = (phone || "").replace(/\D/g, '');
    if (!/^((256|0)\d{9})$/.test(normalizedPhone)) {
      return new Response(
        JSON.stringify({ error: 'Please enter a valid Ugandan phone number (e.g., 0771999302).' }),
        { status: 400, headers: jsonHeader }
      );
    }

    const tracking_id = `TRK-${crypto.randomUUID().split('-')[0].toUpperCase()}`;

    /* ============================================
       4. SAVE TRANSACTION
       ============================================ */
    await env.DB.prepare(
      `INSERT INTO transactions 
        (tracking_id, package_type, amount, phone_number, email, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', datetime('now'))`
    ).bind(tracking_id, package_type, amount, normalizedPhone, email || null).run();

    /* ============================================
       5. GET PESAPAL TOKEN
       ============================================ */
    const token = await getPesapalToken(env);

    /* ============================================
       6. PREPARE ORDER REQUEST
       ============================================ */
    const baseUrl = new URL(request.url).origin;
    const orderRequest = {
      id: tracking_id,
      currency: 'UGX',
      amount,
      description: `HotSpotCentral - ${package_type}`,
      callback_url: `${baseUrl}/payment-success.html?tracking_id=${tracking_id}`,
      notification_id: env.PESAPAL_IPN_ID,
      billing_address: {
        phone_number: normalizedPhone,
        email_address: email || `customer-${tracking_id}@hotspotcentral.com`
      }
    };

    /* ============================================
       7. SUBMIT TO PESAPAL
       ============================================ */
    const pesapalResponse = await fetch(
      'https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(orderRequest)
      }
    );

    const result = await pesapalResponse.json();

    if (pesapalResponse.ok && result.redirect_url) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Redirecting to payment gateway...',
          redirect_url: result.redirect_url,
          tracking_id
        }),
        { headers: jsonHeader }
      );
    }

    throw new Error(result.message || 'Payment gateway did not respond correctly.');

  } catch (error) {
    console.error('Checkout error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Unexpected error during checkout.'
      }),
      { status: 500, headers: jsonHeader }
    );
  }
}

async function getPesapalToken(env) {
  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      consumer_key: env.PESAPAL_KEY,
      consumer_secret: env.PESAPAL_SECRET
    })
  });

  const data = await res.json();
  if (!data.token) {
    console.error('Pesapal token error:', data);
    throw new Error('Failed to authenticate with payment gateway.');
  }
  return data.token;
}
