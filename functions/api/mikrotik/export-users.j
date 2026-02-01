// functions/api/mikrotik/export-users.js
export async function onRequestGet({ request, env }) {
  try {
    const vouchers = await env.DB.prepare(`
      SELECT code, package_type, status, id
      FROM vouchers
      WHERE status IN ('unused', 'assigned')
      ORDER BY package_type, id
    `).all();

    const profileMap = {
      'free-trial': 'free-trial',
      'free-trial-5min': 'free-trial',
      'p1': 'p1',
      'p2': 'p2',
      'p3': 'p3',
      'p4': 'p4',
      '250ugx-35min': 'p1',
      '500ugx-2hrs': 'p2',
      '1000ugx-24hrs': 'p3',
      '1500ugx-24hrs': 'p4'
    };

    let script = [];
    script.push('# Mobile Hub Uganda - Hotspot Users');
    script.push('# Total: ' + vouchers.results.length + ' vouchers');
    script.push('');
    script.push('/ip hotspot user');

    const grouped = {};
    vouchers.results.forEach(v => {
      const pkg = v.package_type.toLowerCase();
      if (!grouped[pkg]) grouped[pkg] = [];
      grouped[pkg].push(v);
    });

    Object.keys(grouped).sort().forEach(pkg => {
      const profile = profileMap[pkg] || 'p2';
      const users = grouped[pkg];
      
      script.push('');
      script.push('# Package: ' + pkg.toUpperCase() + ' → Profile: ' + profile);
      
      users.forEach(v => {
        script.push('add name=' + v.code + ' password=hub123 profile=' + profile + ' disabled=no comment="' + pkg + '"');
      });
    });

    return new Response(script.join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return new Response('# Error: ' + error.message, { status: 500 });
  }
}

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
