// functions/api/voucher/validate.js
// Fixed version - checks if voucher was paid for

export async function onRequest(context) {
    const { request, env } = context;
    
    // CORS headers
    const jsonHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };
    
    // Handle OPTIONS (CORS preflight)
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: jsonHeaders
        });
    }
    
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }
    
    try {
        const { code } = await request.json();
        
        console.log(`[Validate] Checking voucher: ${code}`); // ✅ FIXED
        
        // Check if voucher was PAID FOR in KV storage
        let voucher;
        
        // Try env.VOUCHERS first, then env.KV
        if (env.VOUCHERS) {
            voucher = await env.VOUCHERS.get(code, 'json');
        } else if (env.KV) {
            voucher = await env.KV.get(code, 'json');
        } else {
            console.error('[Validate] No KV namespace configured!');
            return Response.json({ 
                success: false, 
                message: 'System configuration error' 
            }, { headers: jsonHeaders });
        }
        
        if (!voucher || !voucher.paid) {
            console.log(`[Validate] Voucher not paid: ${code}`); // ✅ FIXED
            return Response.json({ 
                success: false, 
                error: 'This voucher code has not been purchased. Please buy a package first.' 
            }, { headers: jsonHeaders });
        }
        
        if (voucher.used) {
            console.log(`[Validate] Voucher already used: ${code}`); // ✅ FIXED
            return Response.json({ 
                success: false, 
                error: 'This voucher has already been used' 
            }, { headers: jsonHeaders });
        }
        
        // Mark as used
        voucher.used = true;
        voucher.usedAt = new Date().toISOString();
        
        if (env.VOUCHERS) {
            await env.VOUCHERS.put(code, JSON.stringify(voucher));
        } else {
            await env.KV.put(code, JSON.stringify(voucher));
        }
        
        console.log(`[Validate] ✅ Voucher validated and marked as used`); // ✅ FIXED
        
        return Response.json({
            success: true,
            code: code,
            password: 'hub123',
            package: voucher.package || 'p2'
        }, { headers: jsonHeaders });
        
    } catch (error) {
        console.error('[Validate] Error:', error);
        console.error('[Validate] Stack:', error.stack);
        return Response.json({ 
            success: false, 
            message: 'System error'
        }, { 
            status: 500,
            headers: jsonHeaders 
        });
    }
}
