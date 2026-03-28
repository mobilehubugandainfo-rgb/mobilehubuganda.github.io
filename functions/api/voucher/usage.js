// functions/api/voucher/usage.js
// Called by MikroTik scheduler every 60s to push live bandwidth data.
// Updates bytes_in / bytes_out for the matching voucher in D1.

const USAGE_SECRET = 'YOUR_SECRET_KEY'; // ← change this to anything secret

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestPost({ request, env }) {
  try {
    const body       = await request.json();
    const code       = (body.code || '').trim().toUpperCase();
    const bytes_in   = parseInt(body.bytes_in)  || 0;
    const bytes_out  = parseInt(body.bytes_out) || 0;
    const secret     = (body.secret || '').trim();

    // ── Auth check ────────────────────────────────────────────
    if (secret !== USAGE_SECRET) {
      return new Response(JSON.stringify({
        success: false, error: 'Forbidden'
      }), { status: 403, headers: jsonHeaders });
    }

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    // ── Update D1 ─────────────────────────────────────────────
    const result = await env.DB.prepare(`
      UPDATE vouchers SET bytes_in = ?, bytes_out = ? WHERE code = ?
    `).bind(bytes_in, bytes_out, code).run();

    console.log('[USAGE] ✅ Updated:', code, '| ↓', bytes_in, '↑', bytes_out);

    return new Response(JSON.stringify({
      success: true, code, bytes_in, bytes_out
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[USAGE] ❌ Error:', error.message);
    return new Response(JSON.stringify({
      success: false, error: 'System error'
    }), { status: 500, headers: jsonHeaders });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
