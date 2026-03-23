export default {
  async fetch(request, env) {
    const now = new Date();
    // Uganda Time (EAT is UTC+3)
    const ugandaTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const currentTimeStr = ugandaTime.toISOString().replace('T', ' ').substring(0, 19);

    // 1. Find vouchers that are 'used' and past their expiry time
    const { results } = await env.DB.prepare(`
      SELECT code FROM vouchers 
      WHERE status = 'used' 
      AND expires_at <= ?
    `).bind(currentTimeStr).all();

    // 2. If we found any, mark them 'expired' in the DB immediately
    if (results && results.length > 0) {
      for (let v of results) {
        await env.DB.prepare("UPDATE vouchers SET status = 'expired' WHERE code = ?")
          .bind(v.code)
          .run();
      }
    }

    // 3. ONLY return the codes as a plain string, or an empty string if none
    const kickList = results.map(v => v.code).join(",");
    
    return new Response(kickList, {
      headers: { 
        "Content-Type": "text/plain",
        "Cache-Control": "no-store" 
      }
    });
  }
};
