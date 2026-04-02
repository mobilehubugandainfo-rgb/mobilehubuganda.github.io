// functions/api/mikrotik/create-user.js
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

    const profileMap = { 'p1': 'p1', 'p2': 'p2', 'p3': 'p3', 'p4': 'p4' 'free-trial' : 'free-trial'};
    const profile = profileMap[package_type.toLowerCase()] || 'p2';

    // 🕒 Precise Expiry Calculation
    const now = new Date();
    let expiryDate = new Date(now.getTime());
    const pkg = package_type.toLowerCase();

    if (pkg === 'p1') expiryDate.setHours(now.getHours() + 3);
    else if (pkg === 'p2') expiryDate.setHours(now.getHours() + 24);
    else if (pkg === 'p3') expiryDate.setDate(now.getDate() + 7);
    else if (pkg === 'p4') expiryDate.setDate(now.getDate() + 30);
    else if (pkg === 'free-trial') expiryDate.setHours(now.getMinutes() + 5);
    else expiryDate.setHours(now.getHours() + 1);

    // Format for SQLite: YYYY-MM-DD HH:MM:SS
    const expiresAt = expiryDate.toISOString().replace('T', ' ').split('.')[0];

    // MikroTik API Call
    const MIKROTIK_IP = 'hka0apw4nbj.sn.mynetname.net';
    const auth = btoa(`${env.MIKROTIK_API_USER || 'api-user'}:${env.MIKROTIK_API_PASSWORD}`);
    
    await fetch(`http://${MIKROTIK_IP}:8728/rest/ip/hotspot/user/add`, {
      method: 'PUT',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: username, password: password, profile: profile,
        comment: `Exp: ${expiresAt} UTC`
      }),
      signal: AbortSignal.timeout(10000)
    });

    // 🚀 D1 Sync - Force 'used' status
    await env.DB.prepare(`
      INSERT INTO vouchers (code, status, expires_at, package_type)
      VALUES (?, 'used', ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        status = 'used',
        expires_at = EXCLUDED.expires_at,
        package_type = EXCLUDED.package_type
    `).bind(username, expiresAt, package_type).run();

    return new Response(JSON.stringify({ success: true, expires_at: expiresAt }), { status: 200, headers: jsonHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: jsonHeaders });
  }
}
