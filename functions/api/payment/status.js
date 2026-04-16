// ✅ Self-healing: reads pesapal_transaction_id saved by checkout.js
//    Queries Pesapal directly on every PENDING poll after attempt 2
//    Assigns voucher itself if Pesapal confirms COMPLETED
//    Surgically updated to prevent "Ghost Vouchers" on high-latency devices

export async function onRequestGet({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const url = new URL(request.url);
    const tracking_id = url.searchParams.get('tracking_id') || url.searchParams.get('id');

    if (!tracking_id) {
      return new Response(JSON.stringify({ status: 'ERROR', error: 'Missing tracking_id' }), {
        status: 400, headers: jsonHeaders
      });
    }

    console.log('[STATUS] Checking:', tracking_id);

    // ─── 1. Query DB ───────────────────────────────────────────
    const data = await env.DB.prepare(`
      SELECT 
        t.id, t.tracking_id, t.pesapal_transaction_id, 
        t.status, t.package_type, t.amount,
        t.voucher_id, t.created_at, t.completed_at,
        t.email, t.phone_number,
        v.code as voucherCode, v.status as voucherStatus
      FROM transactions t
      LEFT JOIN vouchers v ON t.voucher_id = v.id
      WHERE t.tracking_id = ? OR t.pesapal_transaction_id = ?
    `).bind(tracking_id, tracking_id).first();

    if (!data) {
      return new Response(JSON.stringify({ 
        status: 'NOT_FOUND', message: 'Transaction not found', tracking_id 
      }), { status: 404, headers: jsonHeaders });
    }

    // ─── 2. Already done — return immediately ──────────────────
    if (data.status === 'COMPLETED' && data.voucherCode) {
      console.log('[STATUS] Already completed:', data.voucherCode);
      return new Response(JSON.stringify({
        status: 'COMPLETED',
        voucherCode: data.voucherCode,
        tracking_id: data.tracking_id,
        package_type: data.package_type,
        amount: data.amount
      }), { status: 200, headers: jsonHeaders });
    }

    // ─── 3. Still PENDING — get Pesapal transaction ID ─────────
    const pesapalTxId = data.pesapal_transaction_id || url.searchParams.get('OrderTrackingId');

    if (!pesapalTxId) {
      console.warn('[STATUS] No pesapal_transaction_id yet for:', tracking_id);
      return new Response(JSON.stringify({
        status: 'PENDING',
        tracking_id: data.tracking_id,
        package_type: data.package_type,
        amount: data.amount
      }), { status: 200, headers: jsonHeaders });
    }

    // ─── 4. Ask Pesapal directly ───────────────────────────────
    console.log('[STATUS] Querying Pesapal for:', pesapalTxId);
    const token = await getPesapalToken(env);
    const pStatus = await fetchPesapalStatus(pesapalTxId, token, env);

    console.log('[STATUS] Pesapal says:', pStatus);

    if (!['COMPLETED', 'SUCCESS', 'COMPLETE'].includes(pStatus)) {
      return new Response(JSON.stringify({
        status: 'PENDING',
        tracking_id: data.tracking_id,
        package_type: data.package_type,
        amount: data.amount
      }), { status: 200, headers: jsonHeaders });
    }

    // ─── 5. Pesapal confirmed COMPLETED — assign voucher ───────
    console.log('[STATUS] Pesapal confirmed payment — locking voucher...');

    // Find reserved voucher or pick a fresh one atomically
    let voucher = await env.DB.prepare(
      `SELECT id, code FROM vouchers WHERE transaction_id = ? LIMIT 1`
    ).bind(data.tracking_id).first();

    if (!voucher) {
  const atomicResult = await env.DB.prepare(`
    UPDATE vouchers 
    SET status = 'assigned', 
        transaction_id = ?, 
        used_at = CURRENT_TIMESTAMP 
    WHERE id = (
      SELECT id FROM vouchers 
      WHERE status = 'unused' AND package_type = ? 
      ORDER BY id ASC LIMIT 1
    )
    RETURNING id, code
  `).bind(data.tracking_id, data.package_type).first();

  if (atomicResult) {
    voucher = atomicResult;
  } else {
    // 🔥 CRITICAL FALLBACK — another request already assigned it
    voucher = await env.DB.prepare(
      `SELECT id, code FROM vouchers WHERE transaction_id = ? LIMIT 1`
    ).bind(data.tracking_id).first();
  }
}
    if (!voucher) {
  console.error('[STATUS] No vouchers available for', data.package_type);

  return new Response(JSON.stringify({ 
    status: 'ERROR', 
    error: 'VOUCHER_DEPLETED',
    message: 'No vouchers available. Please contact support.'
  }), { status: 200, headers: jsonHeaders });
}
    // ─── 6. Finalize Transaction ───────────────────────────────
    await env.DB.prepare(`
  UPDATE transactions 
  SET status = 'COMPLETED', 
      pesapal_transaction_id = ?, 
      voucher_id = ?, 
      completed_at = CURRENT_TIMESTAMP
  WHERE tracking_id = ?
    AND status != 'COMPLETED'
`).bind(pesapalTxId, voucher.id, data.tracking_id).run();
    
    // Save to KV for MikroTik Enforcer to see
    try {
      const kvTtl = parseInt(env.VOUCHER_KV_TTL_SECONDS || '604800', 10);
      await env.KV.put(voucher.code, JSON.stringify({
        package: data.package_type,
        paid: true,
        transaction: data.tracking_id
      }), { expirationTtl: kvTtl });
    } catch (kvErr) {
      console.warn('[STATUS] KV save failed (non-fatal):', kvErr.message);
    }

    // Background notification
    notifyCustomer(env, {
      email: data.email,
      phone: data.phone_number,
      voucherCode: voucher.code,
      packageType: data.package_type
    }).catch(e => console.error('[STATUS] Notify failed:', e.message));

    return new Response(JSON.stringify({
      status: 'COMPLETED',
      voucherCode: voucher.code,
      tracking_id: data.tracking_id,
      package_type: data.package_type,
      amount: data.amount
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[STATUS] Critical error:', error.message);
    return new Response(JSON.stringify({ status: 'ERROR', message: error.message }), { status: 500, headers: jsonHeaders });
  }
}

// ... Keep your getPesapalToken, fetchPesapalStatus, and notifyCustomer helpers as they were ...
