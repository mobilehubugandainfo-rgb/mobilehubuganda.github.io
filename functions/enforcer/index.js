export async function onRequest(context) {
    const { env } = context;
    
    // 1. Get current time in UTC
    const now = new Date();
    const currentTimeStr = now.toISOString().replace('T', ' ').substring(0, 19);

    try {
        // 2. STEP A: Force-update any 'used' or 'assigned' vouchers to 'expired' if their time is up
        await env.DB.prepare(`
            UPDATE vouchers 
            SET status = 'expired' 
            WHERE (status = 'used' OR status = 'assigned') 
            AND expires_at <= ?
        `).bind(currentTimeStr).run();

        // 3. STEP B: Fetch EVERY SINGLE code that is currently 'expired'
        // We remove the LIMIT so the MikroTik cleans up everyone, even old "ghost" sessions
        const { results } = await env.DB.prepare(`
            SELECT code FROM vouchers 
            WHERE status = 'expired'
        `).all();

        // 4. Return the codes as a comma-separated string
        const kickList = results && results.length > 0 
            ? results.map(v => v.code).join(",") 
            : "";
        
        return new Response(kickList, {
            headers: { 
                "Content-Type": "text/plain",
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*"
            }
        });

    } catch (e) {
        return new Response("Database Error: " + e.message, { status: 500 });
    }
}
