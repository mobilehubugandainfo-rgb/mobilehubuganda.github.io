export async function onRequest(context) {
    const { searchParams } = new URL(context.request.url);
    const code = searchParams.get('code');
    const mac = searchParams.get('mac');
    const { env } = context;

    if (!code || !mac) {
        return new Response("Missing parameters", { status: 400 });
    }

    try {
        // 1. Check if the voucher already has a MAC assigned
        const voucher = await env.DB.prepare("SELECT mac_address FROM vouchers WHERE code = ?")
            .bind(code)
            .first();

        if (voucher && !voucher.mac_address) {
            // 2. First time use: Lock it to THIS MAC address
            await env.DB.prepare("UPDATE vouchers SET mac_address = ? WHERE code = ?")
                .bind(mac, code)
                .run();
            return new Response("Voucher Locked to MAC: " + mac);
        } 
        
        return new Response("Voucher Already Linked");
    } catch (e) {
        return new Response("Database Error: " + e.message, { status: 500 });
    }
}
