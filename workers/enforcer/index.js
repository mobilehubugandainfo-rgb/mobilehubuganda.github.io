export default {
  async fetch(request, env) {
    const now = new Date();
    // Offset for Uganda Time (UTC+3)
    const ugandaTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const currentTimeStr = ugandaTime.toISOString().replace('T', ' ').substring(0, 19);

    // 1. READ: Find any active user (assigned/used) whose time is up
    const { results } = await env.DB.prepare(`
      SELECT code FROM vouchers 
      WHERE (status = 'used' OR status = 'assigned') 
      AND expires_at <= ?
    `).bind(currentTimeStr).all();

    // 2. SHIFT: Automatically change their status to 'expired' in D1
    if (results && results.length > 0) {
      for (let v of results) {
        await env.DB.prepare("UPDATE vouchers SET status = 'expired' WHERE code = ?")
          .bind(v.code)
          .run();
      }
    }

    // 3. ORDER: Send the plain-text list of codes to MikroTik
    const kickList = results.map(v => v.code).join(",");
    
    return new Response(kickList, {
      headers: { 
        "Content-Type": "text/plain",
        "Cache-Control": "no-store" 
      }
    });
  }
};
