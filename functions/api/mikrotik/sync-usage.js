// functions/api/mikrotik/sync-usage.js
// Receives session data from MikroTik every 5 mins
// Supports both GET (query string) and POST (JSON body)
// Updates D1 vouchers table with MB used, uptime, MAC

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ── Shared processing logic ───────────────────────────────────────
async function processSessions(sessions, env) {
  if (!sessions || sessions.length === 0) {
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
    console.log(`[USAGE] ${code} | mac=${mac} | mb=${mbUsed} | uptime=${uptime}`);
  }

  return new Response(JSON.stringify({ success: true, updated }), {
    status: 200, headers: jsonHeaders
  });
}

// ── GET handler — MikroTik sends data as ?body={"sessions":[...]} ─
export async function onRequestGet({ request, env }) {
  try {
    const url       = new URL(request.url);
    const bodyParam = url.searchParams.get('body');

    if (!bodyParam) {
      return new Response(JSON.stringify({ success: false, error: 'Missing body param' }), {
        status: 400, headers: jsonHeaders
      });
    }

    const parsed  = JSON.parse(bodyParam);
    const sessions = parsed.sessions || [];
    console.log(`[USAGE-GET] Received ${sessions.length} session(s)`);
    return await processSessions(sessions, env);

  } catch (err) {
    console.error('[USAGE-GET] Error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: jsonHeaders
    });
  }
}

// ── POST handler — direct JSON POST (admin dashboard, future use) ─
export async function onRequestPost({ request, env }) {
  try {
    const body     = await request.json();
    const sessions = body.sessions || [];
    console.log(`[USAGE-POST] Received ${sessions.length} session(s)`);
    return await processSessions(sessions, env);

  } catch (err) {
    console.error('[USAGE-POST] Error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: jsonHeaders
    });
  }
}

// ── CORS preflight ────────────────────────────────────────────────
export function onRequestOptions() {
  return new Response(null, { status: 204, headers: jsonHeaders });
}
