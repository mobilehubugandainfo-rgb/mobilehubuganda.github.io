export async function onRequest(context) {
    const { env } = context;
    const now = new Date();
    // Uganda Time (EAT is UTC+3)
    const ugandaTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const currentTimeStr = ugandaTime.toISOString().replace('T', ' ').substring(0, 19);

    try {
        // 1. Find vouchers that are 'used' or 'assigned' and past their expiry time
        const { results } = await env.DB.prepare(`
          SELECT code FROM vouchers 
          WHERE (status = 'used' OR status = 'assigned') 
          AND expires_at <= ?
        `).bind(currentTimeStr).all();

        // 2. Shift them to 'expired' in the database
        if (results && results.length > 0) {
            for (let v of results) {
                await env.DB.prepare("UPDATE vouchers SET status = 'expired' WHERE code = ?")
                    .bind(v.code)
                    .run();
            }
        }

        // 3. Return the codes as a plain string for MikroTik
        const kickList = results.map(v => v.code).join(",");
        
        return new Response(kickList, {
            headers: { 
                "Content-Type": "text/plain",
                "Cache-Control": "no-store" 
            }
        });

    } catch (e) {
        return new Response("Database Error: " + e.message, { status: 500 });
    }
}
