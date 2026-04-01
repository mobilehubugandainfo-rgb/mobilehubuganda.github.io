// functions/api/voucher/usage.js
// Called by MikroTik scheduler every 60s to push live bandwidth data.
// Updates bytes_in / bytes_out for the matching voucher in D1.
// Also accumulates lifetime data per customer.

const USAGE_SECRET = 'admin123';

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestPost({ request, env }) {
  try {
    const body      = await request.json();
    const code      = (body.code      || '').trim().toUpperCase();
    const bytes_in  = parseInt(body.bytes_in)  || 0;
    const bytes_out = parseInt(body.bytes_out) || 0;
    const secret    = (body.secret    || '').trim();
    const mac       = (body.mac_address || '').trim();
    const ip        = (body.ip_address  || '').trim();
    const uptime    = (body.uptime      || '').trim();

    // ── Auth check ────────────────────────────────────────────
    if (secret !== USAGE_SECRET) {
      return new Response(JSON.stringify({
        success: false, error: 'Forbidden'
      }), { status: 403, headers: jsonHeaders });
    }

    if (!code) {
      return new Response(JSON.stringify({
        success: false, error: 'Voucher code is required'
      }), { status: 400, headers: jsonHeaders });
    }

    // ── READ previous bytes BEFORE updating ───────────────────
    // Critical: must read prev values first so delta is correct
    const prevRow = await env.DB.prepare(`
      SELECT v.bytes_in    AS prev_in,
             v.bytes_out   AS prev_out,
             v.mac_address AS stored_mac,
             t.phone_number
      FROM vouchers v
      LEFT JOIN transactions t ON t.tracking_id = v.transaction_id
      WHERE v.code = ?
      LIMIT 1
    `).bind(code).first();

    const prev_in  = prevRow?.prev_in  || 0;
    const prev_out = prevRow?.prev_out || 0;
    const phone    = prevRow?.phone_number || null;

    // ── Update voucher bytes + MAC ────────────────────────────
    // Only fills MAC if currently empty or unknown
    await env.DB.prepare(`
      UPDATE vouchers
      SET bytes_in  = ?,
          bytes_out = ?,
          mac_address = CASE
            WHEN mac_address IS NULL
              OR mac_address = ''
              OR mac_address = 'unknown'
            THEN ?
            ELSE mac_address
          END
      WHERE code = ?
    `).bind(bytes_in, bytes_out, mac, code).run();

    console.log('[USAGE] ✅ Voucher updated:', code,
      '| MAC:', mac,
      '| IP:', ip,
      '| Uptime:', uptime,
      '| ↓', bytes_in, '↑', bytes_out
    );

    // ── Calculate delta using values read BEFORE update ───────
    const delta_in  = Math.max(0, bytes_in  - prev_in);
    const delta_out = Math.max(0, bytes_out - prev_out);

    console.log('[USAGE] 📊 Delta for', code,
      '| prev↓', prev_in, '→ new↓', bytes_in, '| Δ↓', delta_in,
      '| prev↑', prev_out, '→ new↑', bytes_out, '| Δ↑', delta_out
    );

    // ── Accumulate lifetime data to customer record ───────────
    if (phone && (delta_in > 0 || delta_out > 0)) {
      await env.DB.prepare(`
        UPDATE customers
        SET total_bytes_in  = total_bytes_in  + ?,
            total_bytes_out = total_bytes_out + ?,
            mac_address = CASE
              WHEN mac_address IS NULL
                OR mac_address = ''
              THEN ?
              ELSE mac_address
            END,
            last_seen  = datetime('now'),
            updated_at = datetime('now')
        WHERE phone = ?
      `).bind(delta_in, delta_out, mac, phone).run();

      console.log('[USAGE] 👤 Customer accumulated:', phone,
        '| +↓', delta_in, '+↑', delta_out
      );
    } else if (!phone) {
      console.warn('[USAGE] ⚠️ No phone found for voucher:', code, '- customer not updated');
    } else {
      console.log('[USAGE] ℹ️ No delta for', code, '- customer unchanged');
    }

    // ── Return success with full debug info ───────────────────
    return new Response(JSON.stringify({
      success:   true,
      code,
      mac,
      ip,
      bytes_in,
      bytes_out,
      delta_in,
      delta_out,
      phone:     phone || null,
      prev_in,
      prev_out
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[USAGE] ❌ Fatal error:', error.message);
    return new Response(JSON.stringify({
      success: false, error: 'System error', detail: error.message
    }), { status: 500, headers: jsonHeaders });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
```

---

## 📋 What This Does End To End
```
MikroTik (every 60s)
    │  POST { code, bytes_in, bytes_out, mac, ip, uptime, secret }
    ▼
usage.js Worker
    │
    ├── 1. Auth check (secret must = 'admin123')
    ├── 2. Read PREVIOUS bytes from voucher (before update)
    ├── 3. Update voucher → new bytes + fill MAC if empty
    ├── 4. Calculate delta (new - prev) → always positive
    ├── 5. Add delta to customer total_bytes_in/out
    └── 6. Fill customer MAC if empty
    │
    ▼
D1 Database
    ├── vouchers.bytes_in/out → live session usage ✅
    ├── vouchers.mac_address  → device identity ✅
    ├── customers.total_bytes_in/out → lifetime usage ✅
    └── customers.mac_address → device identity ✅
