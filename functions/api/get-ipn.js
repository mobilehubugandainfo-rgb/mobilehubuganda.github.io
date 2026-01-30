// functions/api/get-ipn.js
export async function onRequestGet({ env }) {
  if (env.ALLOW_IPN_REGISTER !== 'true') {
    return new Response(
      JSON.stringify({
        disabled: true,
        message: 'IPN registration is disabled in production'
      }),
      { status: 403 }
    );
  }

  // 🔽 registration code lives below
}

    // 1️⃣ Authenticate with Pesapal
    const authRes = await fetch(
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

    const authData = await authRes.json();

    if (!authData.token) {
      return new Response(
        JSON.stringify({
          error: 'Pesapal auth failed',
          response: authData
        }),
        { status: 500 }
      );
    }

    const token = authData.token;

    // 2️⃣ Register IPN URL
    const ipnUrl = 'https://mobilehubuganda.pages.dev/api/payment/ipn';

    const regRes = await fetch(
      'https://pay.pesapal.com/v3/api/URLSetup/RegisterIPN',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          url: ipnUrl,
          ipn_notification_type: 'POST'
        })
      }
    );

    const regData = await regRes.json();

    // 3️⃣ Return clean, readable response
    return new Response(
      JSON.stringify(
        {
          success: true,
          ipn_url: ipnUrl,
          pesapal_response: regData
        },
        null,
        2
      ),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Unexpected error',
        message: err.message
      }),
      { status: 500 }
    );
  }
}
