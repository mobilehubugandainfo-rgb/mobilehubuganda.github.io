// functions/api/mikrotik/sync-usage.js
// ============================================================
// MobileHub — MikroTik → D1 Usage Sync Worker
//
// Supports two call modes:
//   GET  ?data=code|mac|uptime|bytes_in|bytes_out,...  ← MikroTik
//   POST {"sessions":[...]}                            ← Admin/dashboard
// ============================================================

const jsonHeaders = {
  'Content-Type':                'application/json',
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
    const code     = (session.code     || '').trim();
    const mac      = (session.mac      || '').trim();
    const uptime   = (session.uptime   || '').trim();
    const bytesIn  =  session.bytes_in  || 0;
    const bytesOut =  session.bytes_out || 0;
    const mbUsed   = Math.round((bytesIn + bytesOut) / 1024 / 1024 * 100) / 100;

    if (!code) continue;

    try {
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
      console.log(`[USAGE] ✅ ${code} | mac=${mac} | mb=${mbUsed} | uptime=${uptime}`);

    } catch (rowErr) {
      console.error(`[USAGE] ❌ Failed for ${code}:`, rowErr.message);
    }
  }

  return new Response(JSON.stringify({ success: true, updated }), {
    status: 200, headers: jsonHeaders
  });
}

// ── GET handler — MikroTik sends pipe-delimited string ────────────
// Format: ?data=code|mac|uptime|bytes_in|bytes_out,code|mac|...
export async function onRequestGet({ request, env }) {
  try {
    const url  = new URL(request.url);
    const data = url.searchParams.get('data');

    if (!data || data.trim() === '') {
      console.log('[USAGE-GET] No data param — no active sessions');
      return new Response(JSON.stringify({ success: true, updated: 0, note: 'no sessions' }), {
        status: 200, headers: jsonHeaders
      });
    }

    // Parse: "ABC123|EE:7B:26:9E:A3:A8|00:08:24|1363028|15914422"
    const sessions = data.split(',').map(entry => {
      const parts = entry.split('|');
      return {
        code:      parts[0] || '',
        mac:       parts[1] || '',
        uptime:    parts[2] || '',
        bytes_in:  parseInt(parts[3]) || 0,
        bytes_out: parseInt(parts[4]) || 0
      };
    }).filter(s => s.code.trim() !== '');

    console.log(`[USAGE-GET] Parsed ${sessions.length} session(s)`);
    return await processSessions(sessions, env);

  } catch (err) {
    console.error('[USAGE-GET] ❌ Error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: jsonHeaders
    });
  }
}

// ── POST handler — JSON body (admin dashboard, manual calls) ──────
export async function onRequestPost({ request, env }) {
  try {
    const body     = await request.json();
    const sessions = body.sessions || [];

    console.log(`[USAGE-POST] Received ${sessions.length} session(s)`);
    return await processSessions(sessions, env);

  } catch (err) {
    console.error('[USAGE-POST] ❌ Error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: jsonHeaders
    });
  }
}

// ── CORS preflight ────────────────────────────────────────────────
export function onRequestOptions() {
  return new Response(null, { status: 204, headers: jsonHeaders });
}
