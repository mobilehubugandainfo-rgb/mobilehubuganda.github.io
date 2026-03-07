// functions/api/payment/cleanup.js
// ✅ Frees vouchers stuck in 'reserved' after abandoned checkouts
// ✅ Expires PENDING transactions older than 30 minutes
// ✅ Runs automatically via Cloudflare Cron Trigger every 30 minutes
// ✅ Can also be triggered manually via GET /api/payment/cleanup
// ✅ Logs every action clearly so you can monitor in Cloudflare dashboard

// ─────────────────────────────────────────────────────────────
// CRON TRIGGER (automatic — runs every 30 minutes)
// This is called by Cloudflare's scheduler, not by HTTP request.
// To enable, add this to your wrangler.toml:
//
//   [triggers]
//   crons = ["*/30 * * * *"]
//
// And add this to your main worker entry point (or wrangler.toml):
//   export { scheduled } from './functions/api/payment/cleanup.js'
// ─────────────────────────────────────────────────────────────
export async function scheduled(event, env, ctx) {
  console.log('[CLEANUP] Cron triggered at:', new Date().toISOString());
  ctx.waitUntil(runCleanup(env));
}

// ─────────────────────────────────────────────────────────────
// MANUAL HTTP TRIGGER (optional — for testing or emergency use)
// Hit GET /api/payment/cleanup to run cleanup immediately
// ─────────────────────────────────────────────────────────────
export async function onRequestGet({ env }) {
  const result = await runCleanup(env);
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ─────────────────────────────────────────────────────────────
// CORE CLEANUP LOGIC
// ─────────────────────────────────────────────────────────────
async function runCleanup(env) {
  const startTime = Date.now();
  console.log('[CLEANUP] Starting cleanup run...');

  const results = {
    timestamp: new Date().toISOString(),
    vouchersFreed: 0,
    transactionsExpired: 0,
    errors: []
  };

  // ── Step 1: Free vouchers stuck in 'reserved' for more than 30 minutes ──
  // These are checkouts where the client:
  //   - Started payment but never completed it
  //   - Closed the browser before paying
  //   - Had a Pesapal failure after reservation
  //
  // 30 minutes is generous — real payments complete in under 5 minutes.
  // This matches Pesapal's own session timeout.
  try {
    const freedVouchers = await env.DB.prepare(`
      UPDATE vouchers
      SET status = 'unused',
          transaction_id = NULL
      WHERE status = 'reserved'
      AND created_at < datetime('now', '-30 minutes')
    `).run();

    results.vouchersFreed = freedVouchers.meta.changes || 0;
    console.log(`[CLEANUP] Freed ${results.vouchersFreed} stuck reserved vouchers`);
  } catch (err) {
    console.error('[CLEANUP] Voucher cleanup failed:', err.message);
    results.errors.push(`Voucher cleanup: ${err.message}`);
  }

  // ── Step 2: Mark orphaned PENDING transactions as EXPIRED ──
  // Transactions that have been PENDING for more than 30 minutes
  // with no voucher assigned are dead — the client abandoned the flow.
  // Mark them EXPIRED so your dashboard doesn't show false PENDINGs.
  try {
    const expiredTx = await env.DB.prepare(`
      UPDATE transactions
      SET status = 'EXPIRED'
      WHERE status = 'PENDING'
      AND voucher_id IS NULL
      AND created_at < datetime('now', '-30 minutes')
    `).run();

    results.transactionsExpired = expiredTx.meta.changes || 0;
    console.log(`[CLEANUP] Expired ${results.transactionsExpired} abandoned transactions`);
  } catch (err) {
    console.error('[CLEANUP] Transaction cleanup failed:', err.message);
    results.errors.push(`Transaction cleanup: ${err.message}`);
  }

  // ── Step 3: Log summary ──
  const duration = Date.now() - startTime;
  results.durationMs = duration;

  if (results.vouchersFreed > 0 || results.transactionsExpired > 0) {
    console.log(`[CLEANUP] ✅ Done in ${duration}ms — freed ${results.vouchersFreed} vouchers, expired ${results.transactionsExpired} transactions`);
  } else {
    console.log(`[CLEANUP] ✅ Done in ${duration}ms — nothing to clean up`);
  }

  return results;
}
