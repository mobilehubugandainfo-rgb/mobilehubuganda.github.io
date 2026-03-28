const SECRET = 'YOUR_ADMIN_SECRET';

const h = {
  'Content-Type':'application/json',
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET, OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type, x-admin-secret'
};

export async function onRequestGet({ request, env }) {
  if(request.headers.get('x-admin-secret') !== SECRET)
    return new Response(JSON.stringify({success:false,error:'Forbidden'}),{status:403,headers:h});

  const [overview, pkgs, stock, revenue, conns, activeSessions, topCustomers] = await Promise.all([
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM customers) as total_customers,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE status='COMPLETED') as total_revenue,
      (SELECT COUNT(*) FROM vouchers WHERE status='used' AND expires_at > datetime('now')) as active_sessions,
      (SELECT COUNT(*) FROM transactions WHERE status='COMPLETED') as vouchers_sold,
      (SELECT COALESCE(SUM(total_bytes_in),0) FROM customers) as total_bytes_in,
      (SELECT COALESCE(SUM(total_bytes_out),0) FROM customers) as total_bytes_out,
      (SELECT COUNT(*) FROM vouchers WHERE status='unused') as v_unused,
      (SELECT COUNT(*) FROM vouchers WHERE status IN ('used','assigned')) as v_used,
      (SELECT COUNT(*) FROM vouchers WHERE status='expired') as v_expired,
      (SELECT COUNT(*) FROM vouchers WHERE status='reserved') as v_reserved`).first(),
    env.DB.prepare(`SELECT package_type, COUNT(*) as cnt FROM transactions WHERE status='COMPLETED' GROUP BY package_type`).all(),
    env.DB.prepare(`SELECT package_type, COUNT(*) as cnt FROM vouchers WHERE status='unused' GROUP BY package_type`).all(),
    env.DB.prepare(`SELECT date(completed_at) as date, SUM(amount) as amount FROM transactions WHERE status='COMPLETED' AND completed_at >= date('now','-14 days') GROUP BY date(completed_at) ORDER BY date`).all(),
    env.DB.prepare(`SELECT date(used_at) as date, COUNT(*) as count FROM vouchers WHERE used_at >= date('now','-14 days') GROUP BY date(used_at) ORDER BY date`).all(),
    env.DB.prepare(`SELECT code, package_type, expires_at, bytes_in, bytes_out FROM vouchers WHERE status='used' AND expires_at > datetime('now') ORDER BY expires_at LIMIT 20`).all(),
    env.DB.prepare(`SELECT phone, mac_address, total_bytes_in, total_bytes_out, connect_count, last_seen, vouchers_used FROM customers ORDER BY total_bytes_in DESC LIMIT 20`).all(),
  ]);

  const pkgMap = {p1:0,p2:0,p3:0,p4:0,ft:0};
  pkgs.results?.forEach(r=>{ if(r.package_type==='free-trial') pkgMap.ft+=r.cnt; else pkgMap[r.package_type]=(pkgMap[r.package_type]||0)+r.cnt; });

  const stockMap = {p1:0,p2:0,p3:0,p4:0,ft:0};
  stock.results?.forEach(r=>{ if(r.package_type==='free-trial') stockMap.ft+=r.cnt; else stockMap[r.package_type]=(stockMap[r.package_type]||0)+r.cnt; });

  return new Response(JSON.stringify({
    success: true,
    ...overview,
    pkg_p1: pkgMap.p1, pkg_p2: pkgMap.p2, pkg_p3: pkgMap.p3, pkg_p4: pkgMap.p4, pkg_ft: pkgMap.ft,
    stock: stockMap,
    revenue_by_day: revenue.results,
    connections_by_day: conns.results,
    active_vouchers: activeSessions.results,
    top_customers: topCustomers.results
  }), {headers:h});
}

export function onRequestOptions(){
  return new Response(null,{status:204,headers:h});
}
