// functions/api/voucher/free-trial.js
//
// ✅ Assigns a secure MH-XXXX-XXXX voucher from D1
// ✅ One free trial per MAC per day (KV, expires at midnight UTC)
// ✅ Atomic + random assignment — no race conditions, no sequential guessing
// ✅ Auto-seeds 100 fresh vouchers when stock drops below 10
// ✅ Returns code + pin for MikroTik login form

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────
const SAFE_CHARS  = 'ACDEFGHJKLMNPQRTUVWXY2346789'; // no 0/O, 1/I, 8/B confusion
const SEED_TARGET = 100;   // how many to seed when stock is low
const SEED_FLOOR  =  10;   // seed when unused stock drops below this

const HEADERS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
};

// ─────────────────────────────────────────────────────────
// CRYPTO HELPERS
// ─────────────────────────────────────────────────────────
function randomSegment(len) {
  const out   = [];
  const bytes = new Uint8Array(len * 3); // oversample to avoid modulo bias
  crypto.getRandomValues(bytes);
  const limit = Math.floor(256 / SAFE_CHARS.length) * SAFE_CHARS.length;
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    if (bytes[i] < limit) out.push(SAFE_CHARS[bytes[i] % SAFE_CHARS.length]);
  }
  // Safety fallback (statistically never reached)
  while (out.length < len) {
    const b = new Uint8Array(1);
    crypto.getRandomValues(b);
    out.push(SAFE_CHARS[b[0] % SAFE_CHARS.length]);
  }
  return out.join('');
}

function generateCode() {
  return `MH-${randomSegment(4)}-${randomSegment(4)}`;
}

function generatePin() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(100000 + (n[0] % 900000)); // always exactly 6 digits
}

// ─────────────────────────────────────────────────────────
// RESPONSE HELPER
// ─────────────────────────────────────────────────────────
function respond(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

// ─────────────────────────────────────────────────────────
// AUTO-SEED — runs silently when stock is low
// ─────────────────────────────────────────────────────────
async function autoSeedIfLow(env) {
  const stock = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM vouchers
     WHERE package_type = 'free-trial' AND status = 'unused'`
  ).first();

  const current = stock?.n ?? 0;
  if (current >= SEED_FLOOR) return; // enough stock, skip

  console.log(`[FREE-TRIAL] Stock at ${current}, seeding ${SEED_TARGET} new vouchers...`);

  const inserts = [];
  let   tries   = 0;

  while (inserts.length < SEED_TARGET && tries < SEED_TARGET * 6) {
    tries++;
    const code = generateCode();
    const pin  = generatePin();

    const clash = await env.DB.prepare(
      `SELECT id FROM vouchers WHERE code = ?`
    ).bind(code).first();

    if (!clash) inserts.push({ code, pin });
  }

  if (inserts.length === 0) {
    console.error('[FREE-TRIAL] Auto-seed failed — no unique codes generated');
    return;
  }

  await env.DB.batch(
    inserts.map(v =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO vouchers (code, pin, package_type, status)
         VALUES (?, ?, 'free-trial', 'unused')`
      ).bind(v.code, v.pin)
    )
  );

  console.log(`[FREE-TRIAL] Seeded ${inserts.length} vouchers. New stock: ${current + inserts.length}`);
}

// ─────────────────────────────────────────────────────────
// MAIN — POST /api/voucher/free-trial
// ─────────────────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  try {
    // ── Parse body ──────────────────────────────────────
    const body = await request.json().catch(() => ({}));
    const { mac } = body;

    if (!mac) {
      return respond({ success: false, error: 'Device identifier is required.' }, 400);
    }

    const cleanMac = mac.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (cleanMac.length < 6) {
      return respond({ success: false, error: 'Invalid device identifier.' }, 400);
    }

    // ── Daily limit key ─────────────────────────────────
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const kvKey = `ft:${cleanMac}:${today}`;

    // ── 1. KV check — already used today? ───────────────
    if (env.KV) {
      try {
        const used = await env.KV.get(kvKey);
        if (used) {
          return respond({
            success: false,
            error:   'You have already used your free trial today. Come back tomorrow or purchase a voucher!'
          });
        }
      } catch (e) {
        console.warn('[FREE-TRIAL] KV read failed (continuing):', e.message);
      }
    }

    // ── 2. Auto-seed if stock is low ─────────────────────
    await autoSeedIfLow(env);

    // ── 3. Atomically assign a random unused voucher ─────
    // ORDER BY RANDOM() prevents sequential code prediction
    const voucher = await env.DB.prepare(
      `UPDATE vouchers
       SET    status         = 'assigned',
              transaction_id = ?,
              used_at        = datetime('now')
       WHERE  id = (
         SELECT id FROM vouchers
         WHERE  package_type = 'free-trial'
         AND    status       = 'unused'
         ORDER  BY RANDOM()
         LIMIT  1
       )
       RETURNING id, code, pin`
    ).bind(`FREE-${cleanMac}-${today}`).first();

    if (!voucher) {
      return respond({
        success: false,
        error:   'Free trials are temporarily unavailable. Please purchase a voucher to get online.'
      });
    }

    console.log(`[FREE-TRIAL] ${voucher.code} assigned to ${cleanMac}`);

    // ── 4. Mark device as used today in KV ───────────────
    if (env.KV) {
      try {
        const now      = new Date();
        const midnight = new Date(now);
        midnight.setUTCHours(23, 59, 59, 999);
        const ttl = Math.ceil((midnight - now) / 1000);
        await env.KV.put(kvKey, '1', { expirationTtl: ttl });
      } catch (e) {
        console.warn('[FREE-TRIAL] KV write failed (non-fatal):', e.message);
      }
    }

    // ── 5. Return voucher credentials to portal ──────────
    // Portal POSTs: username = code, password = pin
    // MikroTik user was created with: name = code, password = pin
    return respond({
      success:  true,
      code:     voucher.code,
      password: voucher.pin,
      message:  'Free trial activated! Connecting...'
    });

  } catch (err) {
    console.error('[FREE-TRIAL] Unhandled error:', err.message);
    return respond({ success: false, error: 'System error. Please try again.' }, 500);
  }
}

// ─────────────────────────────────────────────────────────
// OPTIONS — CORS preflight
// ─────────────────────────────────────────────────────────
export function onRequestOptions() {
  return new Response(null, {
    status:  204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
