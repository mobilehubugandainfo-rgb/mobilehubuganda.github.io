// functions/api/mikrotik/sync-usage.js
// Receives session data posted from MikroTik every 5 mins
// Updates D1 vouchers table with MB used, uptime, MAC

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const body = await request.json();
    const sessions = body.sessions || [];

    if (sessions.length === 0) {
      return new Response(JSON.stringify({ success: true, updated: 0 }), {
        status: 200, headers: jsonHeaders
      });
    }

    let updated = 0;

    for (const session of sessions) {
      const code     = session.code     || '';
      const mac      = session.mac      || '';
      const uptime   = session.uptime   || '';
      const bytesIn  = session.bytes_in  || 0;
      const bytesOut = session.bytes_out || 0;
      const mbUsed   = Math.round((bytesIn + bytesOut) / 1024 / 1024 * 100) / 100;

      if (!code) continue;

      await env.DB.prepare(`
        UPDATE vouchers SET
          mac_address = COALESCE(NULLIF(?, ''), mac_address),
          device_id   = COALESCE(NULLIF(?, ''), device_id),
          mb_used     = ?,
          uptime      = ?,
          updated_at  = datetime('now')
        WHERE code = ?
      `).bind(mac, mac, mbUsed, uptime, code).run();

      updated++;
      console.log(`[USAGE] Updated ${code} | mac=${mac} | mb=${mbUsed} | uptime=${uptime}`);
    }

    return new Response(JSON.stringify({ success: true, updated }), {
      status: 200, headers: jsonHeaders
    });

  } catch (err) {
    console.error('[USAGE] Error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: jsonHeaders
    });
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
