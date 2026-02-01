// functions/api/voucher/validate.js

```javascript
export async function onRequest(context) {
    const { request, env } = context;
    
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }
    
    try {
        const { code } = await request.json();
        
        console.log(`[Validate] Checking voucher: ${code}`);
        
        // Check if voucher was PAID FOR
        const voucher = await env.VOUCHERS.get(code, 'json');
        
        if (!voucher || !voucher.paid) {
            // Voucher exists in MikroTik, but customer didn't pay for it!
            console.log(`[Validate] Voucher not paid: ${code}`);
            return Response.json({ 
                success: false, 
                message: 'This voucher code has not been purchased. Please buy a package first.' 
            });
        }
        
        if (voucher.used) {
            console.log(`[Validate] Voucher already used: ${code}`);
            return Response.json({ 
                success: false, 
                message: 'This voucher has already been used' 
            });
        }
        
        // Mark as used
        voucher.used = true;
        voucher.usedAt = new Date().toISOString();
        await env.VOUCHERS.put(code, JSON.stringify(voucher));
        
        console.log(`[Validate] ✅ Voucher validated and marked as used`);
        
        return Response.json({
            success: true,
            code: code,
            password: 'hub123',
            ready_to_login: true  // Tell frontend to submit form
        });
        
    } catch (error) {
        console.error('[Validate] Error:', error);
        return Response.json({ 
            success: false, 
            message: 'System error' 
        });
    }
}
