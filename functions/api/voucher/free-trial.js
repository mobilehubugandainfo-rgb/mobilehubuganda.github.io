// functions/api/voucher/free-trial.js
// ✅ Assigns a free-trial voucher from D1 to the requesting device
// ✅ One free trial per MAC address per day (tracked in KV)
// ✅ Atomic voucher assignment — no race conditions
// ✅ Returns voucher code for hotspot login form submission

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const { mac } = await request.json();

    if (!mac) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Device identifier is required.'
      }), { status: 400, headers: jsonHeaders });
    }

    // Sanitize MAC — remove colons/dashes, uppercase
    const cleanMac = mac.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const kvKey = `free-trial:${cleanMac}:${today}`;

    // ── 1. Check if this device already used free trial today ──
    if (env.KV) {
      try {
        const used = await env.KV.get(kvKey);
        if (used) {
          return new Response(JSON.stringify({
            success: false,
            error: 'You have already used your free trial today. Come back tomorrow or purchase a voucher!'
          }), { status: 200, headers: jsonHeaders });
        }
      } catch (kvErr) {
        console.warn('[FREE-TRIAL] KV check failed (continuing):', kvErr.message);
      }
    }

    // ── 2. Check stock ─────────────────────────────────────────
    const stock = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM vouchers WHERE package_type = 'free-trial' AND status = 'unused'`
    ).first();

    if (!stock || stock.count === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Sorry, free trials are currently unavailable. Please purchase a voucher to get online.'
      }), { status: 200, headers: jsonHeaders });
    }

    // ── 3. Atomically assign a free-trial voucher ──────────────
    const voucher = await env.DB.prepare(
      `UPDATE vouchers
       SET status = 'assigned',
           transaction_id = ?,
           used_at = datetime('now')
       WHERE id = (
         SELECT id FROM vouchers
         WHERE package_type = 'free-trial' AND status = 'unused'
         ORDER BY id
         LIMIT 1
       )
       RETURNING id, code`
    ).bind(`FREE-${cleanMac}-${today}`).first();

    if (!voucher) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unable to assign free trial. Please try again.'
      }), { status: 500, headers: jsonHeaders });
    }

    console.log(`[FREE-TRIAL] Assigned ${voucher.code} to ${cleanMac}`);

    // ── 4. Mark this device as used today in KV ────────────────
    if (env.KV) {
      try {
        // Expire at midnight — seconds until end of day
        const now = new Date();
        const endOfDay = new Date(now);
        endOfDay.setUTCHours(23, 59, 59, 999);
        const ttl = Math.floor((endOfDay - now) / 1000) + 1;
        await env.KV.put(kvKey, '1', { expirationTtl: ttl });
      } catch (kvErr) {
        console.warn('[FREE-TRIAL] KV write failed (non-fatal):', kvErr.message);
      }
    }

    // ── 5. Return the voucher code ─────────────────────────────
    return new Response(JSON.stringify({
      success: true,
      code: voucher.code,
      password: voucher.code,
      message: 'Free trial activated! Connecting...'
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[FREE-TRIAL] Error:', error.message);
    return new Response(JSON.stringify({
      success: false,
      error: 'System error. Please try again.'
    }), { status: 500, headers: jsonHeaders });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
