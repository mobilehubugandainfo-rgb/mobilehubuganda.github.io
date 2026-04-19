// functions/api/mikrotik/sync-users.js
// ============================================================
// MobileHub — MikroTik → D1 User Data Sync Worker
//
// Called by MikroTik on a schedule (or on-login event).
// Pulls live hotspot user data from MikroTik and upserts
// phone number, MAC address, package, and session info into D1.
//
// ENDPOINT: POST /api/mikrotik/sync-users
// AUTH:     Bearer token via env.SYNC_SECRET
// ============================================================

const MIKROTIK_HOST = 'hka0apw4nbj.sn.mynetname.net';
const MIKROTIK_PORT = '8728';

const jsonHeaders = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export async function onRequestPost({ request, env }) {
  try {
    // ── Auth check — simple bearer token ─────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const token      = authHeader.replace('Bearer ', '').trim();
    if (env.SYNC_SECRET && token !== env.SYNC_SECRET) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401, headers: jsonHeaders
      });
    }

    // ── 1. Fetch all active hotspot sessions from MikroTik ────────
    const auth = btoa(`${env.MIKROTIK_API_USER || 'api-user'}:${env.MIKROTIK_API_PASSWORD}`);

    const [activeRes, userRes] = await Promise.all([
      fetch(`http://${MIKROTIK_HOST}:${MIKROTIK_PORT}/rest/ip/hotspot/active`, {
        headers: { 'Authorization': `Basic ${auth}` },
        signal: AbortSignal.timeout(10000)
      }),
      fetch(`http://${MIKROTIK_HOST}:${MIKROTIK_PORT}/rest/ip/hotspot/user`, {
        headers: { 'Authorization': `Basic ${auth}` },
        signal: AbortSignal.timeout(10000)
      })
    ]);

    if (!activeRes.ok || !userRes.ok) {
      throw new Error(`MikroTik API error: active=${activeRes.status} users=${userRes.status}`);
    }

    const activeSessions = await activeRes.json(); // live sessions with MAC + IP
    const hotspotUsers   = await userRes.json();   // all users with profile/comment

    // ── 2. Build a MAC lookup from active sessions ─────────────────
    // activeSessions: [{ user, address, mac-address, uptime, ... }]
    const macByUser = {};
    for (const session of activeSessions) {
      if (session.user && session['mac-address']) {
        macByUser[session.user] = session['mac-address'].toUpperCase();
      }
    }

    // ── 3. Sync each hotspot user into D1 ─────────────────────────
    let synced  = 0;
    let skipped = 0;
    const errors = [];

    for (const user of hotspotUsers) {
      const code    = user.name;
      const profile = user.profile || 'unknown'; // p1, p2, p3, p4, free-trial
      const comment = user.comment || '';         // "Exp: 2025-04-20 12:00:00 UTC"
      const mac     = macByUser[code] || null;

      // Extract expiry from comment field if present
      // Comment format set by create-user.js: "Exp: YYYY-MM-DD HH:MM:SS UTC"
      let expiresAt = null;
      const expMatch = comment.match(/Exp:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (expMatch) expiresAt = expMatch[1];

      // Skip users with no meaningful data
      if (!code) { skipped++; continue; }

      try {
        // ── Upsert into vouchers table ─────────────────────────
        // Only updates fields we have — never overwrites phone (stored in transactions)
        await env.DB.prepare(`
          UPDATE vouchers SET
            device_id    = COALESCE(NULLIF(?, ''), device_id),
            mac_address  = COALESCE(NULLIF(?, ''), mac_address),
            package_type = COALESCE(NULLIF(?, ''), package_type),
            expires_at   = COALESCE(NULLIF(?, ''), expires_at),
            updated_at   = datetime('now')
          WHERE code = ?
        `).bind(
          mac,           // device_id (same as mac for hotspot)
          mac,           // mac_address
          profile,       // package_type
          expiresAt,     // expires_at (from comment)
          code           // WHERE code = ?
        ).run();

        synced++;
        console.log(`[SYNC] ✅ Updated ${code} | mac=${mac} | profile=${profile} | expires=${expiresAt}`);

      } catch (rowErr) {
        errors.push({ code, error: rowErr.message });
        console.error(`[SYNC] ❌ Failed to sync ${code}:`, rowErr.message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      synced,
      skipped,
      errors: errors.length ? errors : undefined
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[SYNC] ❌ Fatal error:', error.message);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: jsonHeaders
    });
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: jsonHeaders });
}
