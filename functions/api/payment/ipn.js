// functions/api/payment/ipn.js
// Production-ready Pesapal IPN handler for hotspot billing system

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);

    // 1️⃣ Parse query parameters first, fallback to body
    let OrderTrackingId = url.searchParams.get('OrderTrackingId');
    let OrderMerchantReference = url.searchParams.get('OrderMerchantReference');
    let OrderNotificationType = url.searchParams.get('OrderNotificationType');

    if (!OrderTrackingId || !OrderMerchantReference || !OrderNotificationType) {
      const contentType = request.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        // Handle JSON body - Pesapal may use different field names
        const body = await request.json();
        console.log('[IPN DEBUG] Received JSON body:', JSON.stringify(body));
        OrderTrackingId = OrderTrackingId || body.OrderTrackingId || body.orderTrackingId || body.order_tracking_id;
        OrderMerchantReference = OrderMerchantReference || body.OrderMerchantReference || body.orderMerchantReference || body.order_merchant_reference;
        OrderNotificationType = OrderNotificationType || body.OrderNotificationType || body.orderNotificationType || body.order_notification_type;
      } else {
        // Handle form-encoded body
        const raw = await request.text();
        console.log('[IPN DEBUG] Received form body:', raw);
        const params = new URLSearchParams(raw);
        OrderTrackingId = OrderTrackingId || params.get('OrderTrackingId');
        OrderMerchantReference = OrderMerchantReference || params.get('OrderMerchantReference');
        OrderNotificationType = OrderNotificationType || params.get('OrderNotificationType');
      }
    }

    if (!OrderTrackingId || !OrderMerchantReference) {
      console.warn('[IPN] Missing required fields', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });
      return new Response('OK', { status: 200 }); // ACK to Pesapal
    }

    console.log('[IPN] Received:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    // 2️⃣ Idempotency check - prevent duplicate processing
    const existingTx = await env.DB.prepare(
      `SELECT id, status, voucher_id 
       FROM transactions 
       WHERE pesapal_transaction_id = ? AND status = 'COMPLETED'
       LIMIT 1`
    ).bind(OrderTrackingId).first();

    if (existingTx) {
      console.log(`[IPN] Already processed Pesapal transaction: ${OrderTrackingId}`);
      return new Response('OK', { status: 200 });
    }

    // 3️⃣ Get Pesapal token from KV cache or fetch new
    const token = await getPesapalToken(env);

    // 4️⃣ Fetch payment status with retry and timeout
    const pStatus = await fetchPesapalStatus(OrderTrackingId, token);

    // Accept multiple success status variations (COMPLETED, SUCCESS, COMPLETE)
    const successStatuses = ['COMPLETED', 'SUCCESS', 'COMPLETE'];
    const isPaymentSuccessful = successStatuses.includes(pStatus);

    if (!isPaymentSuccessful) {
      console.log(`[IPN] Payment not completed: ${pStatus} (NotificationType: ${OrderNotificationType})`);
      return new Response('OK', { status: 200 });
    }

    // 5️⃣ Fetch transaction details
    const tx = await env.DB.prepare(
      `SELECT id, tracking_id, package_type, status, email, phone_number
       FROM transactions
       WHERE tracking_id = ?
       LIMIT 1`
    ).bind(OrderMerchantReference).first();

    if (!tx) {
      console.warn(`[IPN] Transaction not found: ${OrderMerchantReference}`);
      return new Response('OK', { status: 200 });
    }

    if (tx.status === 'COMPLETED') {
      console.log(`[IPN] Transaction already completed: ${OrderMerchantReference}`);
      return new Response('OK', { status: 200 });
    }

    // 6️⃣ Atomic voucher assignment with retry logic (6 attempts, 3s intervals)
    const voucher = await retryVoucherAssignment(env, OrderMerchantReference, tx.package_type, 6);

    if (!voucher) {
      console.error(`[IPN] ⚠️ CRITICAL: No unused vouchers after 6 retries for package: ${tx.package_type}`);
      
      // Alert for voucher depletion
      await sendAlert(env, {
        type: 'VOUCHER_DEPLETED',
        package: tx.package_type,
        transaction: OrderMerchantReference,
        timestamp: new Date().toISOString()
      });

      return new Response('OK', { status: 200 });
    }

    // 7️⃣ Update transaction with voucher info
    await env.DB.prepare(
      `UPDATE transactions
       SET status = 'COMPLETED',
           pesapal_transaction_id = ?,
           voucher_id = ?,
           completed_at = CURRENT_TIMESTAMP
       WHERE tracking_id = ?`
    ).bind(OrderTrackingId, voucher.id, OrderMerchantReference).run();

    console.log(`[IPN SUCCESS] ✅ Voucher ${voucher.code} assigned to transaction ${OrderMerchantReference}`);

    // 8️⃣ Send voucher to customer (async, non-blocking)
    notifyCustomer(env, tx.email, tx.phone_number, voucher.code, tx.package_type)
      .catch(err => console.error('[NOTIFY ERROR]', err));

    // 9️⃣ Always ACK to Pesapal
    return new Response(JSON.stringify({
      status: 200,
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      notificationType: OrderNotificationType,
      paymentStatus: pStatus,
      voucherAssigned: true
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error('[IPN ERROR] ❌ Critical:', err);
    
    // Log to monitoring service if available
    try {
      await logError(env, {
        error: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString()
      });
    } catch (logErr) {
      console.error('[LOGGING ERROR]', logErr);
    }

    // Always ACK to Pesapal to prevent infinite retries
    return new Response('OK', { status: 200 });
  }
}

// ---------- Helper Functions ----------

/**
 * Get Pesapal authentication token with KV caching
 * Caches token for 50 minutes to reduce API calls
 */
async function getPesapalToken(env) {
  // Try KV cache first
  if (env.KV) {
    try {
      const cached = await env.KV.get('pesapal_token', 'json');
      if (cached && cached.expiry > Date.now()) {
        console.log('[TOKEN] Using cached token');
        return cached.token;
      }
    } catch (err) {
      console.warn('[TOKEN] KV fetch failed, fetching new token:', err);
    }
  }

  // Fetch new token from Pesapal
  console.log('[TOKEN] Fetching new token from Pesapal');
  const res = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Accept': 'application/json' 
    },
    body: JSON.stringify({ 
      consumer_key: env.PESAPAL_KEY, 
      consumer_secret: env.PESAPAL_SECRET 
    })
  });

  if (!res.ok) {
    throw new Error(`Pesapal auth failed: ${res.status}`);
  }

  const data = await res.json();
  if (!data.token) {
    throw new Error('Pesapal auth response missing token');
  }

  // Cache in KV for 50 minutes
  if (env.KV) {
    try {
      const expiry = Date.now() + (50 * 60 * 1000);
      await env.KV.put('pesapal_token', JSON.stringify({ 
        token: data.token, 
        expiry 
      }), {
        expirationTtl: 3600 // 1 hour TTL as backup
      });
      console.log('[TOKEN] Cached new token');
    } catch (err) {
      console.warn('[TOKEN] Failed to cache token:', err);
    }
  }

  return data.token;
}

/**
 * Fetch payment status from Pesapal with retry logic and timeout
 * 
 * Pesapal may return these payment_status_description values:
 * - COMPLETED / SUCCESS / COMPLETE (payment successful)
 * - FAILED (payment failed)
 * - INVALID (invalid transaction)
 * - PENDING (payment pending)
 * - REVERSED (payment reversed/refunded)
 * 
 * Note: Status is converted to uppercase for consistency
 */
async function fetchPesapalStatus(orderTrackingId, token, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const res = await fetch(
        `https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
        { 
          headers: { 
            Authorization: `Bearer ${token}`, 
            Accept: 'application/json' 
          },
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Pesapal API returned ${res.status}`);
      }

      const data = await res.json();
      const status = data.payment_status_description?.toUpperCase() || 'PENDING';
      
      console.log(`[Pesapal] Status fetched: ${status} (attempt ${attempt})`);
      return status;

    } catch (err) {
      console.warn(`[Pesapal Retry ${attempt}/${retries}] Failed:`, err.message);
      
      if (attempt < retries) {
        // Exponential backoff: 500ms, 1000ms, 1500ms
        const delay = attempt * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error('[Pesapal] ❌ All retries failed, defaulting to PENDING');
  return 'PENDING';
}

/**
 * Send voucher code to customer via email and/or SMS
 * Replace with your actual email/SMS provider
 */
async function notifyCustomer(env, email, phone, voucherCode, packageType) {
  if (!email && !phone) {
    console.warn('[NOTIFY] No contact info available');
    return;
  }

  console.log(`[NOTIFY] Sending voucher ${voucherCode} to email: ${email}, phone: ${phone}`);

  try {
    // Example: Email notification using Resend
    if (email && env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'noreply@yourdomain.com',
          to: email,
          subject: 'Your Hotspot Voucher Code',
          html: `
            <h2>Payment Successful!</h2>
            <p>Thank you for your purchase. Here is your hotspot voucher code:</p>
            <h3 style="background: #f4f4f4; padding: 10px; font-family: monospace;">${voucherCode}</h3>
            <p><strong>Package:</strong> ${packageType}</p>
            <p>Connect to the hotspot and enter this code to activate your internet access.</p>
          `
        })
      });
      console.log('[NOTIFY] Email sent successfully');
    }

    // Example: SMS notification using Twilio or Africa's Talking
    if (phone && env.SMS_API_KEY) {
      await fetch(env.SMS_API_URL || 'https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: {
          'apiKey': env.SMS_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          username: env.SMS_USERNAME || 'sandbox',
          to: phone,
          message: `Your hotspot voucher code: ${voucherCode}. Package: ${packageType}. Enter this code to connect.`
        })
      });
      console.log('[NOTIFY] SMS sent successfully');
    }

  } catch (err) {
    console.error('[NOTIFY] Failed to send notification:', err);
    // Don't throw - notification failure shouldn't break the payment flow
  }
}

/**
 * Send alert for critical issues (voucher depletion, etc.)
 */
async function sendAlert(env, alertData) {
  try {
    console.error('[ALERT]', JSON.stringify(alertData));
    
    // Example: Send to Slack webhook
    if (env.SLACK_WEBHOOK_URL) {
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *${alertData.type}*`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Alert Type:* ${alertData.type}\n*Package:* ${alertData.package}\n*Transaction:* ${alertData.transaction}\n*Time:* ${alertData.timestamp}`
              }
            }
          ]
        })
      });
    }

    // Example: Send email alert
    if (env.ALERT_EMAIL && env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'alerts@yourdomain.com',
          to: env.ALERT_EMAIL,
          subject: `ALERT: ${alertData.type}`,
          text: JSON.stringify(alertData, null, 2)
        })
      });
    }
  } catch (err) {
    console.error('[ALERT] Failed to send alert:', err);
  }
}

/**
 * Log errors to external monitoring service
 */
async function logError(env, errorData) {
  // Example: Log to Axiom, Logflare, or similar
  if (env.LOG_API_URL && env.LOG_API_KEY) {
    await fetch(env.LOG_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.LOG_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        level: 'error',
        service: 'ipn-handler',
        ...errorData
      })
    });
  }
}

/**
 * Retry voucher retrieval with exponential backoff
 */
async function retryVoucherAssignment(env, OrderMerchantReference, packageType, maxRetries = 6) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const voucher = await env.DB.prepare(
        `UPDATE vouchers
         SET status = 'assigned',
             transaction_id = ?,
             used_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id FROM vouchers
           WHERE package_type = ? AND status = 'unused'
           ORDER BY id
           LIMIT 1
         )
         RETURNING id, code`
      ).bind(OrderMerchantReference, packageType).first();

      if (voucher) {
        console.log(`[VOUCHER] Retrieved on attempt ${attempt}`);
        return voucher;
      }
    } catch (dbErr) {
      console.warn(`[VOUCHER DB BUSY] Attempt ${attempt}: ${dbErr.message}`);
    }

    if (attempt < maxRetries) {
      console.log(`[VOUCHER] Attempt ${attempt} failed, retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000)); // Wait 3 seconds
    }
  }

  return null; // All retries exhausted
}
