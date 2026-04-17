// functions/api/mikrotik/create-user.js
// Called after payment confirmed and voucher assigned.
// Creates (or upserts) the hotspot user on MikroTik and syncs the voucher to D1.
//
// FIXES APPLIED:
//   1. MikroTik API response is now parsed and checked for errors.
//   2. A proper error is thrown if MikroTik rejects the request.
//   3. AbortSignal.timeout(10000) retained for network safety.

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const body = await request.json();
    const { username, password, package_type } = body;

    if (!username || !password || !package_type) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing required fields: username, password, package_type' }),
        { status: 400, headers: jsonHeaders }
      );
    }

    // ── Profile map — must match profiles configured on MikroTik ─────
    const profileMap = {
      'p1':         'p1',
      'p2':         'p2',
      'p3':         'p3',
      'p4':         'p4',
      'free-trial': 'free-trial'
    };
    const profile = profileMap[package_type.toLowerCase()] || 'p2';

    // ── Precise expiry calculation ─────────────────────────────────────
    const now     = new Date();
    const expDate = new Date(now.getTime());
    const pkg     = package_type.toLowerCase();

    if      (pkg === 'p1')         expDate.setHours(now.getHours() + 3);
    else if (pkg === 'p2')         expDate.setHours(now.getHours() + 24);
    else if (pkg === 'p3')         expDate.setDate(now.getDate() + 7);
    else if (pkg === 'p4')         expDate.setDate(now.getDate() + 30);
    else if (pkg === 'free-trial') expDate.setMinutes(now.getMinutes() + 5);
    else                           expDate.setHours(now.getHours() + 1); // safe fallback

    // Format for MikroTik comment + SQLite: "YYYY-MM-DD HH:MM:SS"
    const expiresAt = expDate.toISOString().replace('T', ' ').split('.')[0];

    // ── MikroTik REST API call ─────────────────────────────────────────
    const MIKROTIK_HOST = 'hka0apw4nbj.sn.mynetname.net';
    const auth          = btoa(`${env.MIKROTIK_API_USER || 'api-user'}:${env.MIKROTIK_API_PASSWORD}`);
    const mikrotikUrl   = `http://${MIKROTIK_HOST}:8728/rest/ip/hotspot/user/add`;

    console.log('[CREATE-USER] Calling MikroTik for user:', username, '| profile:', profile);

    // FIX: capture the MikroTik response and check for errors
    const mikrotikRes = await fetch(mikrotikUrl, {
      method:  'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        name:     username,
        password: password,
        profile:  profile,
        comment:  `Exp: ${expiresAt} UTC`
      }),
      signal: AbortSignal.timeout(10000) // 10 second hard timeout
    });

    // FIX: parse MikroTik response — it may return JSON with an error field
    let mikrotikData = null;
    try {
      mikrotikData = await mikrotikRes.json();
    } catch {
      // MikroTik sometimes returns an empty body on success (204-like) — that's OK
      console.log('[CREATE-USER] MikroTik returned no/non-JSON body (treating as success if status OK)');
    }

    // FIX: throw a descriptive error if MikroTik rejected the request
    if (!mikrotikRes.ok || mikrotikData?.error) {
      const errMsg = mikrotikData?.detail || mikrotikData?.error || `HTTP ${mikrotikRes.status}`;
      console.error('[CREATE-USER] ❌ MikroTik rejected request:', errMsg);
      throw new Error(`MikroTik user creation failed: ${errMsg}`);
    }

    console.log('[CREATE-USER] ✅ MikroTik user created:', username);

    // ── D1 sync — upsert voucher to 'used' with correct expiry ────────
    // Uses ON CONFLICT so it safely handles both new and pre-existing rows.
    await env.DB.prepare(`
      INSERT INTO vouchers (code, status, expires_at, package_type)
      VALUES (?, 'used', ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        status       = 'used',
        expires_at   = excluded.expires_at,
        package_type = excluded.package_type
    `).bind(username, expiresAt, package_type).run();

    console.log('[CREATE-USER] ✅ D1 synced — code:', username, '| expires:', expiresAt);

    return new Response(
      JSON.stringify({ success: true, expires_at: expiresAt }),
      { status: 200, headers: jsonHeaders }
    );

  } catch (error) {
    console.error('[CREATE-USER] ❌ Error:', error.message);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: jsonHeaders }
    );
  }
}

// ── CORS preflight ─────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
