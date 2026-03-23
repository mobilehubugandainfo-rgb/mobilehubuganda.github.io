export async function onRequestPost({ request, env }) {

  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const body = await request.json();
    const code = (body.code || '').trim().toUpperCase();
    const mac  = (body.mac  || 'unknown').trim();

    console.log('[ACTIVATE] 📥 Request — code:', code, '| mac:', mac);

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code required'
      }), { status: 400, headers: jsonHeaders });
    }

    const voucher = await env.DB.prepare(`
      SELECT id, package_type, expires_at, mac_address
      FROM vouchers WHERE code = ?
    `).bind(code).first();

    if (!voucher) {
      return new Response(JSON.stringify({
        success: false, error: 'Invalid voucher'
      }), { status: 200, headers: jsonHeaders });
    }

    // ✅ Already activated — do nothing
    if (voucher.expires_at) {
      console.log('[ACTIVATE] ⚠️ Already active:', code);
      return new Response(JSON.stringify({
        success: true,
        already_active: true
      }), { status: 200, headers: jsonHeaders });
    }

    // ── Duration (KEEP 5 MINUTES FOR NOW) ──
    const durations = {
      'p1':  5 * 60 * 1000,
      'p2': 24 * 60 * 60 * 1000,
      'p3':  7 * 24 * 60 * 60 * 1000,
      'p4': 30 * 24 * 60 * 60 * 1000
    };

    const pkg      = (voucher.package_type || 'p2').toLowerCase();
    const duration = durations[pkg] || durations['p2'];

    const expiresAt = new Date(Date.now() + duration)
      .toISOString().replace('T', ' ').split('.')[0];

    console.log('[ACTIVATE] 🚀 Activating — expires at:', expiresAt);

    await env.DB.prepare(`
      UPDATE vouchers
      SET
        status      = 'used',
        used_at     = datetime('now'),
        expires_at  = ?,
        mac_address = CASE WHEN mac_address IS NULL THEN ? ELSE mac_address END
      WHERE id = ?
    `).bind(expiresAt, mac, voucher.id).run();

    return new Response(JSON.stringify({
      success: true,
      expires_at: expiresAt
    }), { status: 200, headers: jsonHeaders });

  } catch (err) {
    console.error('[ACTIVATE] ❌ Error:', err);
    return new Response(JSON.stringify({
      success: false
    }), { status: 500, headers: jsonHeaders });
  }
}
