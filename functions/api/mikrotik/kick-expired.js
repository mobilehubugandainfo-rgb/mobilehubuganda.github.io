// functions/api/mikrotik/kick-expired.js
export async function onRequestGet({ request, env }) {
  const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    // Get current UTC time in same format: YYYY-MM-DD HH:MM:SS
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Find all 'used' vouchers where the expiry string is smaller than the current time string
    const { results } = await env.DB.prepare(`
      SELECT code FROM vouchers 
      WHERE status = 'used' 
      AND expires_at IS NOT NULL 
      AND expires_at <= ?
    `).bind(now).all();

    if (!results || results.length === 0) {
      return new Response(JSON.stringify({ codes: [] }), { status: 200, headers: jsonHeaders });
    }

    const codes = results.map(r => r.code);

    // Mark as expired so we don't kick them twice
    const placeholders = codes.map(() => '?').join(',');
    await env.DB.prepare(`
      UPDATE vouchers SET status = 'expired' WHERE code IN (${placeholders})
    `).bind(...codes).run();

    console.log(`[MobileHub] Automatic Kick triggered for: ${codes.join(', ')}`);

    return new Response(JSON.stringify({ codes }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ codes: [], error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
