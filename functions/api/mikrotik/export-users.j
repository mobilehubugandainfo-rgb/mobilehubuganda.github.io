// functions/api/mikrotik/export-users.js
// Exports all vouchers as MikroTik CLI commands
// ✅ Matches your EXACT MikroTik profiles

export async function onRequestGet({ request, env }) {
  try {
    console.log('[MikroTik Export] Generating user commands...');

    // Get all vouchers from database
    const vouchers = await env.DB.prepare(`
      SELECT code, package_type, status, id
      FROM vouchers
      WHERE status IN ('unused', 'assigned')
      ORDER BY package_type, id
    `).all();

    console.log('[MikroTik Export] Found', vouchers.results.length, 'vouchers');

    // ✅ CORRECTED: Matches YOUR exact MikroTik profiles
    const profileMap = {
      'free-trial': 'free-trial',
      'free-trial-5min': 'free-trial',
      'p1': 'p1',
      'p2': 'p2',
      'p3': 'p3',
      'p4': 'p4',
      // Backward compatibility
      '250ugx-35min': 'p1',
      '500ugx-2hrs': 'p2',
      '1000ugx-24hrs': 'p3',
      '1500ugx-24hrs': 'p4'
    };

    // Generate MikroTik script
    let script = [];
    
    script.push('# ==========================================');
    script.push('# Mobile Hub Uganda - Hotspot Users');
    script.push('# Generated: ' + new Date().toISOString());
    script.push('# Total: ' + vouchers.results.length + ' vouchers');
    script.push('# ==========================================');
    script.push('');
    script.push('# NOTE: Profiles already exist in your MikroTik:');
    script.push('# - free-trial: 2M/2M, 5 minutes');
    script.push('# - p1: 1500K/1000K, 30 minutes (250 UGX)');
    script.push('# - p2: 3M/2M, 2 hours (500 UGX)');
    script.push('# - p3: 2M/1M, 24 hours (1000 UGX)');
    script.push('# - p4: 3M/2M, 24 hours (1500 UGX)');
    script.push('');
    script.push('# ==========================================');
    script.push('# Creating Hotspot Users');
    script.push('# ==========================================');
    script.push('');
    script.push('/ip hotspot user');

    // Group by package
    const grouped = {};
    vouchers.results.forEach(v => {
      const pkg = v.package_type.toLowerCase();
      if (!grouped[pkg]) grouped[pkg] = [];
      grouped[pkg].push(v);
    });

    // Generate commands
    Object.keys(grouped).sort().forEach(pkg => {
      const profile = profileMap[pkg] || 'p2';
      const users = grouped[pkg];
      
      script.push('');
      script.push(`# Package: ${pkg.toUpperCase()} → Profile: ${profile} (${users.length} codes)`);
      
      users.forEach(v => {
        script.push(`add name=${v.code} password=hub123 profile=${profile} disabled=no comment="${pkg}"`);
      });
    });

    script.push('');
    script.push('# ==========================================');
    script.push('# Summary');
    script.push('# ==========================================');
    Object.keys(grouped).forEach(pkg => {
      script.push(`# ${pkg.toUpperCase()}: ${grouped[pkg].length} vouchers`);
    });
    script.push(`# TOTAL: ${vouchers.results.length} vouchers created`);
    script.push('# ==========================================');

    return new Response(script.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (error) {
    console.error('[Export] Error:', error);
    return new Response(`# Error: ${error.message}`, { status: 500 });
  }
}

// CORS support
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
