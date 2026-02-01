//functions/api/payment/callback.js`

```javascript
export async function onRequest(context) {
    const { request, env } = context;
    
    try {
        const data = await request.json();
        const { package_id, phone, email, transaction_id } = data;
        
        if (data.status !== 'COMPLETED') {
            return Response.json({ success: false });
        }
        
        // Get next available voucher for this package
        const voucherKey = `available_${package_id}`;
        let availableList = await env.VOUCHER_POOL.get(voucherKey, 'json') || [];
        
        if (availableList.length === 0) {
            // Initialize pool
            availableList = [];
            for (let i = 1; i <= 125; i++) {
                const num = String(i).padStart(4, '0');
                availableList.push(`MH-${package_id}-${num}`);
            }
        }
        
        const voucherCode = availableList.shift();
        
        if (!voucherCode) {
            return Response.json({ 
                success: false, 
                message: 'No vouchers available' 
            });
        }
        
        // Save updated pool
        await env.VOUCHER_POOL.put(voucherKey, JSON.stringify(availableList));
        
        // Mark voucher as PAID (not used yet)
        await env.VOUCHERS.put(voucherCode, JSON.stringify({
            package: package_id,
            paid: true,        // ← They paid for it
            used: false,       // ← Haven't logged in yet
            paidAt: new Date().toISOString(),
            phone: phone,
            email: email,
            transaction: transaction_id
        }));
        
        console.log(`✅ Voucher ${voucherCode} assigned (paid but not used)`);
        
        return Response.json({
            success: true,
            voucher: voucherCode,
            redirect: `/payment-success.html?voucher=${voucherCode}`
        });
        
    } catch (error) {
        console.error('Payment callback error:', error);
        return Response.json({ success: false });
    }
}
```

---
