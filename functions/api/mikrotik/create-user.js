// functions/api/mikrotik/create-user.js
// Production-ready MikroTik user creation with D1 Sync for MobileHub Uganda
// Supports packages: p1 (5m), p2 (24h), p3 (7d), p4 (30d)

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const body = await request.json();
    const { username, password, package_type } = body;
    
    if (!username || !password || !package_type) {
      return new Response(JSON.stringify({ success: false, error: 'Missing fields' }), { status: 400, headers: jsonHeaders });
    }

    // 1️⃣ Map package type to MikroTik profile
    const profileMap = { 'p1': 'p1', 'p2': 'p2', 'p3': 'p3', 'p4': 'p4' };
    const profile = profileMap[package_type.toLowerCase()] || 'p2';

    // 2️⃣ 🕒 Calculate Precise Expiry (5m, 24h, 7d, 30d)
    const nowMs = Date.now();
    let expiryMs = nowMs;
    const pkg = package_type.toLowerCase();

    if (pkg === 'p1') {
      expiryMs += (5 * 60 * 1000);           // 5 Minutes
    } else if (pkg === 'p2') {
      expiryMs += (24 * 60 * 60 * 1000);     // 24 Hours
    } else if (pkg === 'p3') {
      expiryMs += (7 * 24 * 60 * 60 * 1000); // 7 Days
    } else if (pkg === 'p4') {
      expiryMs += (30 * 24 * 60 * 60 * 1000);// 30 Days
    } else {
      expiryMs += (60 * 60 * 1000);          // 1 Hour Default
    }

    const expiresAt = new Date(expiryMs).toISOString();

    // 3️⃣ MikroTik Configuration
    const MIKROTIK_IP = 'hka0apw4nbj.sn.mynetname.net';
    const API_PORT = '8728';
    const API_USER = env.MIKROTIK_API_USER || 'api-user';
    const API_PASS = env.MIKROTIK_API_PASSWORD;
    const auth = btoa(`${API_USER}:${API_PASS}`);

    // 4️⃣ Create User in MikroTik
    const createResponse = await fetch(`http://${MIKROTIK_IP}:${API_PORT}/rest/ip/hotspot/user/add`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: username,
        password: password,
        profile: profile,
        disabled: 'no',
        comment: `Pkg: ${package_type} | Exp: ${expiresAt}`
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      // If user already exists, we still want to sync the DB status
      if (!errorText.includes('already have')) {
         throw new Error(`MikroTik API Error: ${errorText}`);
      }
    }

    // 5️⃣ 🚀 SAFE D1 Sync (Only updates necessary columns, preserves others)
    await env.DB.prepare(`
      INSERT INTO vouchers (code, status, expires_at, package_type)
      VALUES (?, 'used', ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        status = 'used',
        expires_at = EXCLUDED.expires_at,
        package_type = EXCLUDED.package_type
    `).bind(username, expiresAt, package_type).run();

    console.log(`[MobileHub] Success: ${username} active until ${expiresAt}`);

    return new Response(JSON.stringify({ 
      success: true, 
      username, 
      expires_at: expiresAt 
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[MikroTik Create] Error:', error.message);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: jsonHeaders });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
