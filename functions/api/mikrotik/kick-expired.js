// functions/api/mikrotik/kick-expired.js
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
    // Set MIKROTIK_SECRET in Cloudflare env vars for security
    // MikroTik passes it as ?secret=xxx
    if (env.MIKROTIK_SECRET) {
      const url    = new URL(request.url);
      const secret = url.searchParams.get('secret');
      if (secret !== env.MIKROTIK_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: jsonHeaders
        });
      }
    }

    const now = new Date().toISOString().replace('T', ' ').split('.')[0];

    // ── Find all expired used vouchers ─────────────────────────
    const expired = await env.DB.prepare(`
      SELECT id, code
      FROM vouchers
      WHERE status = 'used'
        AND expires_at IS NOT NULL
        AND expires_at < ?
    `).bind(now).all();

    if (!expired.results || expired.results.length === 0) {
      return new Response(JSON.stringify({ codes: [] }), {
        status: 200, headers: jsonHeaders
      });
    }

    const codes = expired.results.map(r => r.code);
    const ids   = expired.results.map(r => r.id);

    // ── Mark them expired in D1 ────────────────────────────────
    for (const id of ids) {
      await env.DB.prepare(
        `UPDATE vouchers SET status = 'expired' WHERE id = ?`
      ).bind(id).run();
    }

    console.log('[KICK-EXPIRED] Returning', codes.length, 'expired codes:', codes.join(', '));

    // Return codes as both JSON and plain text
    // MikroTik /tool fetch works best with simple responses
    return new Response(JSON.stringify({ codes }), {
      status: 200, headers: jsonHeaders
    });

  } catch (err) {
    console.error('[KICK-EXPIRED] Error:', err.message);
    return new Response(JSON.stringify({ codes: [], error: err.message }), {
      status: 500, headers: jsonHeaders
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
