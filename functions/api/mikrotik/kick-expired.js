// Called by MikroTik every minute via /tool fetch
// Returns list of voucher codes that have expired so MikroTik can kick them
// Also marks them as expired in D1

export async function onRequestGet({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    // ── Optional secret key check ──────────────────────────────
    if (env.MIKROTIK_SECRET) {
      const url = new URL(request.url);
      const secret = url.searchParams.get('secret');
      if (secret !== env.MIKROTIK_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: jsonHeaders
        });
      }
    }

    // Generate current UTC time
    const now = new Date().toISOString();

    // ── Find all expired used vouchers ─────────────────────────
    // Using datetime() ensures SQLite compares the times correctly regardless of formatting
    const expired = await env.DB.prepare(`
      SELECT id, code
      FROM vouchers
      WHERE status = 'used'
        AND expires_at IS NOT NULL
        AND datetime(expires_at) < datetime(?)
    `).bind(now).all();

    if (!expired.results || expired.results.length === 0) {
      return new Response(JSON.stringify({ codes: [] }), {
        status: 200,
        headers: jsonHeaders
      });
    }

    const codes = expired.results.map(r => r.code);
    const ids = expired.results.map(r => r.id);

    // ── Mark them expired in D1 ────────────────────────────────
    // We update them so they aren't returned in the next minute's check
    for (const id of ids) {
      await env.DB.prepare(
        `UPDATE vouchers SET status = 'expired' WHERE id = ?`
      ).bind(id).run();
    }

    console.log('[KICK-EXPIRED] Returning', codes.length, 'expired codes:', codes.join(', '));

    // Return codes as JSON for the MikroTik script to parse
    return new Response(JSON.stringify({ codes }), {
      status: 200,
      headers: jsonHeaders
    });

  } catch (err) {
    console.error('[KICK-EXPIRED] Error:', err.message);
    return new Response(JSON.stringify({ codes: [], error: err.message }), {
      status: 500,
      headers: jsonHeaders
    });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
