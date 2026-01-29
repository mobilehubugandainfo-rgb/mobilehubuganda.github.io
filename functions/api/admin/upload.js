// functions/api/admin/upload.js
export async function onRequestPost({ request, env }) {
  const jsonHeaders = { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    const { codes, package_type } = await request.json();

    if (!codes || !Array.isArray(codes) || !package_type) {
      return new Response(JSON.stringify({ error: 'Invalid data format' }), { status: 400, headers: jsonHeaders });
    }

    // Normalize inputs
    const normalizedPackage = package_type.trim().toLowerCase();
    const normalizedCodes = codes
      .map(c => c.trim().toUpperCase())
      .filter(c => c.length > 0); // remove empty strings

    if (normalizedCodes.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid voucher codes provided' }), { status: 400, headers: jsonHeaders });
    }

    // Batch insert
    const statements = normalizedCodes.map(code => 
      env.DB.prepare(
        "INSERT OR IGNORE INTO vouchers (code, package_type, status) VALUES (?, ?, 'unused')"
      ).bind(code, normalizedPackage)
    );

    const results = await env.DB.batch(statements);

    // Count successful inserts
    const totalInserted = results.reduce((acc, res) => acc + (res.meta?.changes || 0), 0);

    return new Response(JSON.stringify({
      success: true,
      message: `Successfully uploaded ${totalInserted} vouchers for "${normalizedPackage}".`,
      duplicates_ignored: normalizedCodes.length - totalInserted
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[Admin Upload Error]:', error);
    return new Response(JSON.stringify({ error: 'Server error: ' + error.message }), { status: 500, headers: jsonHeaders });
  }
}

// Optional: CORS preflight
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