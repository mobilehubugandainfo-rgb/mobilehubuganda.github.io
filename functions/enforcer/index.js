export async function onRequest(context) {
    const { env } = context;
    
    // 1. Get current time in UTC (Standard for Cloudflare/D1)
    const now = new Date();
    const currentTimeStr = now.toISOString().replace('T', ' ').substring(0, 19);

    try {
        // 2. STEP A: Find 'used' vouchers that JUST expired and mark them as 'expired'
        await env.DB.prepare(`
            UPDATE vouchers 
            SET status = 'expired' 
            WHERE (status = 'used' OR status = 'assigned') 
            AND expires_at <= ?
        `).bind(currentTimeStr).run();

        // 3. STEP B: Find EVERYONE who is 'expired' and past their time.
        // This acts as a safety net for codes like MH-FC84-F9CD.
        const { results } = await env.DB.prepare(`
            SELECT code FROM vouchers 
            WHERE status = 'expired' 
            AND expires_at <= ?
            LIMIT 20
        `).bind(currentTimeStr).all();

        // 4. Return the codes as a plain string for MikroTik to kick
        const kickList = results && results.length > 0 
            ? results.map(v => v.code).join(",") 
            : "";
        
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
