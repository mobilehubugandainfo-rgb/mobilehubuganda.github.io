// functions/api/mikrotik/create-user.js
// Production-ready MikroTik user creation endpoint
// Configured for: hka0apw4nbj.sn.mynetname.net
// ✅ CORRECTED: Profile names match MikroTik exactly (p1, p2, p3, p4)

export async function onRequestPost({ request, env }) {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  try {
    console.log('[MikroTik Create] 📥 Request received');

    // 1️⃣ Parse and validate incoming data
    const body = await request.json();
    const { username, password, package_type } = body;
    
    console.log('[MikroTik Create] Request data:', { 
      username, 
      package_type,
      hasPassword: !!password 
    });

    // Validate required fields
    if (!username || !password || !package_type) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Missing required fields: username, password, or package_type' 
      }), { 
        status: 400, 
        headers: jsonHeaders 
      });
    }

    // 2️⃣ Map package type to MikroTik profile
    // ✅ CORRECTED: Removed "-profile" suffix to match your MikroTik exactly
    const profileMap = {
      'p1': 'p1',  // ✅ Matches MikroTik profile name
      'p2': 'p2',  // ✅ Matches MikroTik profile name
      'p3': 'p3',  // ✅ Matches MikroTik profile name
      'p4': 'p4'   // ✅ Matches MikroTik profile name
    };
    
    // ✅ CORRECTED: Default to 'p2' instead of 'p2-profile'
    const profile = profileMap[package_type.toLowerCase()] || 'p2';
    console.log('[MikroTik Create] 📦 Using profile:', profile);

    // 3️⃣ MikroTik Configuration (YOUR CREDENTIALS)
    const MIKROTIK_IP = 'hka0apw4nbj.sn.mynetname.net';  // ✅ Your Cloud ID
    const API_PORT = '8728';  // ✅ REST API port
    const API_USER = env.MIKROTIK_API_USER || 'api-user';  // ✅ Matches your MikroTik user
    const API_PASS = env.MIKROTIK_API_PASSWORD;
    
    if (!API_PASS) {
      console.error('[MikroTik Create] ❌ Missing MIKROTIK_API_PASSWORD');
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'MikroTik API not configured. Set MIKROTIK_API_PASSWORD in environment.' 
      }), { 
        status: 500, 
        headers: jsonHeaders 
      });
    }

    console.log('[MikroTik Create] 🔌 Connecting to:', MIKROTIK_IP);

    // 4️⃣ Create Basic Auth header
    const auth = btoa(`${API_USER}:${API_PASS}`);
    
    // 5️⃣ Check if user already exists
    console.log('[MikroTik Create] 🔍 Checking if user exists...');
    
    try {
      const checkResponse = await fetch(`http://${MIKROTIK_IP}:${API_PORT}/rest/ip/hotspot/user/print`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout for cloud
      });

      if (checkResponse.ok) {
        const existingUsers = await checkResponse.json();
        const userExists = existingUsers.some(u => u.name === username);
        
        if (userExists) {
          console.log('[MikroTik Create] ℹ️ User already exists:', username);
          return new Response(JSON.stringify({ 
            success: true,
            message: 'User already exists in MikroTik',
            username,
            profile,
            alreadyExisted: true
          }), { 
            status: 200, 
            headers: jsonHeaders 
          });
        }
      }
    } catch (checkError) {
      console.warn('[MikroTik Create] ⚠️ Check failed:', checkError.message);
      // Continue to create user anyway
    }

    // 6️⃣ Create new user in MikroTik
    console.log('[MikroTik Create] ➕ Creating new user...');
    
    const createResponse = await fetch(`http://${MIKROTIK_IP}:${API_PORT}/rest/ip/hotspot/user/add`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: username,
        password: password,
        profile: profile,  // ✅ Now uses correct profile name (p1, p2, p3, p4)
        disabled: 'no',
        comment: `Package: ${package_type} | Created: ${new Date().toISOString()}`
      }),
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });

    // 7️⃣ Handle response
    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error('[MikroTik Create] ❌ Error:', errorText);
      
      // Check if user already exists
      if (errorText.includes('already have')) {
        return new Response(JSON.stringify({ 
          success: true,
          message: 'User already exists',
          username,
          profile,
          alreadyExisted: true
        }), { 
          status: 200, 
          headers: jsonHeaders 
        });
      }
      
      throw new Error(`MikroTik API Error: ${errorText}`);
    }

    console.log('[MikroTik Create] ✅ Success!');

    return new Response(JSON.stringify({ 
      success: true,
      message: 'User created successfully',
      username,
      profile,
      package_type
    }), { 
      status: 200,
      headers: jsonHeaders
    });

  } catch (error) {
    console.error('[MikroTik Create] ❌ Error:', error.message);
    
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message
    }), { 
      status: 500,
      headers: jsonHeaders
    });
  }
}

// CORS support
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
