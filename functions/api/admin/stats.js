export async function onRequestGet({ request, env }) {
  const h = {'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};

  const [ov, pkgs, stock, revDay, revWeek, revMonth, dataDay, dataWeek, dataMonth, sessions, customers] = await Promise.all([

    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM customers) as total_customers,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE status='COMPLETED') as total_revenue,
      (SELECT COUNT(*) FROM vouchers WHERE status='used' AND expires_at > datetime('now')) as active_sessions,
      (SELECT COUNT(*) FROM transactions WHERE status='COMPLETED') as vouchers_sold,
      (SELECT COALESCE(SUM(total_bytes_in),0) FROM customers) as total_bytes_in,
      (SELECT COALESCE(SUM(total_bytes_out),0) FROM customers) as total_bytes_out,
      (SELECT COUNT(*) FROM customers WHERE total_bytes_in > 104857600) as heavy_users,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE status='COMPLETED' AND date(completed_at)=date('now')) as rev_today,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE status='COMPLETED' AND completed_at >= date('now','weekday 0','-7 days')) as rev_week,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE status='COMPLETED' AND strftime('%Y-%m',completed_at)=strftime('%Y-%m','now')) as rev_month,
      (SELECT COALESCE(SUM(v.bytes_in),0) FROM vouchers v WHERE date(v.used_at)=date('now')) as data_today,
      (SELECT COALESCE(SUM(v.bytes_in),0) FROM vouchers v WHERE v.used_at >= date('now','-7 days')) as data_week,
      (SELECT COUNT(*) FROM vouchers WHERE status='unused') as v_unused,
      (SELECT COUNT(*) FROM vouchers WHERE status IN ('used','assigned')) as v_used,
      (SELECT COUNT(*) FROM vouchers WHERE status='expired') as v_expired,
      (SELECT COUNT(*) FROM vouchers WHERE status='reserved') as v_reserved`).first(),

    env.DB.prepare(`SELECT package_type, COUNT(*) as cnt FROM transactions WHERE status='COMPLETED' GROUP BY package_type`).all(),
    env.DB.prepare(`SELECT package_type, COUNT(*) as cnt FROM vouchers WHERE status='unused' GROUP BY package_type`).all(),

    env.DB.prepare(`SELECT date(completed_at) as date, SUM(amount) as amount FROM transactions WHERE status='COMPLETED' AND completed_at >= date('now','-14 days') GROUP BY date(completed_at) ORDER BY date`).all(),
    env.DB.prepare(`SELECT strftime('%Y-W%W',completed_at) as date, SUM(amount) as amount FROM transactions WHERE status='COMPLETED' AND completed_at >= date('now','-56 days') GROUP BY strftime('%Y-W%W',completed_at) ORDER BY date`).all(),
    env.DB.prepare(`SELECT strftime('%Y-%m',completed_at) as date, SUM(amount) as amount FROM transactions WHERE status='COMPLETED' AND completed_at >= date('now','-180 days') GROUP BY strftime('%Y-%m',completed_at) ORDER BY date`).all(),

    env.DB.prepare(`SELECT date(used_at) as date, SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out FROM vouchers WHERE used_at >= date('now','-14 days') GROUP BY date(used_at) ORDER BY date`).all(),
    env.DB.prepare(`SELECT strftime('%Y-W%W',used_at) as date, SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out FROM vouchers WHERE used_at >= date('now','-56 days') GROUP BY strftime('%Y-W%W',used_at) ORDER BY date`).all(),
    env.DB.prepare(`SELECT strftime('%Y-%m',used_at) as date, SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out FROM vouchers WHERE used_at >= date('now','-180 days') GROUP BY strftime('%Y-%m',used_at) ORDER BY date`).all(),

    env.DB.prepare(`SELECT v.code, v.package_type, v.expires_at, v.bytes_in, v.bytes_out, v.mac_address, t.phone_number as phone FROM vouchers v LEFT JOIN transactions t ON t.tracking_id=v.transaction_id WHERE v.status='used' AND v.expires_at > datetime('now') ORDER BY v.expires_at LIMIT 30`).all(),
    env.DB.prepare(`SELECT phone, mac_address, total_bytes_in, total_bytes_out, connect_count, last_seen, first_seen, vouchers_used FROM customers ORDER BY total_bytes_in DESC LIMIT 100`).all(),
  ]);

  const pkgMap={p1:0,p2:0,p3:0,p4:0,ft:0};
  pkgs.results?.forEach(r=>{ if(r.package_type==='free-trial') pkgMap.ft+=r.cnt; else pkgMap[r.package_type]=(pkgMap[r.package_type]||0)+r.cnt; });

  const stockMap={p1:0,p2:0,p3:0,p4:0,ft:0};
  stock.results?.forEach(r=>{ if(r.package_type==='free-trial') stockMap.ft+=r.cnt; else stockMap[r.package_type]=(stockMap[r.package_type]||0)+r.cnt; });

  return new Response(JSON.stringify({
    success:true, ...ov,
    pkg_p1:pkgMap.p1, pkg_p2:pkgMap.p2, pkg_p3:pkgMap.p3, pkg_p4:pkgMap.p4, pkg_ft:pkgMap.ft,
    stock:stockMap,
    revenue:{ day:revDay.results, week:revWeek.results, month:revMonth.results },
    dataUsage:{ day:dataDay.results, week:dataWeek.results, month:dataMonth.results },
    active_vouchers:sessions.results,
    top_customers:customers.results,
  }),{headers:h});
}

export function onRequestOptions(){
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
}
