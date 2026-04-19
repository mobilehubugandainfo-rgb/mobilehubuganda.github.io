// functions/api/mikrotik/kick-expired.js
// ============================================================
// MobileHub — Kick Expired Vouchers
//
// Called every 5 minutes by the MikroTik RouterOS scheduler.
// Returns JSON list of expired voucher codes.
// MikroTik script then removes those users + active sessions.
//
// ENDPOINT: GET /api/mikrotik/kick-expired
// NO AUTH NEEDED — response only contains codes, no sensitive data
// ============================================================

export async function onRequestGet({ request, env }) {
  const jsonHeaders = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];

    // ── Find all vouchers that have passed their expiry ───────────
    // Catches both 'used' (active) and 'assigned' (paid but never logged in)
    const { results } = await env.DB.prepare(`
      SELECT code, package_type, mac_address, expires_at
      FROM vouchers
      WHERE status IN ('used', 'assigned')
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).bind(now).all();

    if (!results || results.length === 0) {
      return new Response(JSON.stringify({ codes: [], expired_count: 0 }), {
        status: 200, headers: jsonHeaders
      });
    }

    const codes = results.map(r => r.code);

    // ── Mark as expired in bulk ───────────────────────────────────
    const placeholders = codes.map(() => '?').join(',');
    await env.DB.prepare(`
      UPDATE vouchers
      SET status     = 'expired',
          updated_at = datetime('now')
      WHERE code IN (${placeholders})
    `).bind(...codes).run();

    console.log(`[KICK] ✅ Marked ${codes.length} voucher(s) expired: ${codes.join(', ')}`);

    // ── Log expired session data for admin visibility ─────────────
    for (const row of results) {
      console.log(
        `[KICK] Expired → code:${row.code} | pkg:${row.package_type} | mac:${row.mac_address} | was_due:${row.expires_at}`
      );
    }

    return new Response(JSON.stringify({
      codes,
      expired_count: codes.length,
      checked_at:    now
    }), { status: 200, headers: jsonHeaders });

  } catch (err) {
    console.error('[KICK] ❌ Error:', err.message);
    return new Response(JSON.stringify({
      codes:  [],
      error:  err.message
    }), { status: 500, headers: jsonHeaders });
  }
}
