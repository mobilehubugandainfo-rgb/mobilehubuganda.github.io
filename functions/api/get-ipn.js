export async function onRequest(context) {
  const { env } = context;
  
  // 1. Get Token from Pesapal
  const authRes = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      "consumer_key": "+DMC5eXi+KTFjHYg4BYuZgZwb1FHdg4F",
      "consumer_secret": "dKmEMLREiNXV/FfSIwHnubjDBPQ="
    })
  });
  
  const authData = await authRes.json();
  const token = authData.token;

  if (!token) return new Response("Auth Failed: " + JSON.stringify(authData));

  // 2. Register the IPN URL
  const regRes = await fetch('https://pay.pesapal.com/v3/api/URLSetup/RegisterIPN', {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json', 
      'Accept': 'application/json' 
    },
    body: JSON.stringify({
      "url": "https://mobilehubuganda.pages.dev/api/payment/ipn",
      "ipn_notification_type": "POST"
    })
  });

  const regData = await regRes.json();
  
  // Return the result to your screen
  return new Response(JSON.stringify(regData, null, 2), {
    headers: { "content-type": "application/json" }
  });
}
