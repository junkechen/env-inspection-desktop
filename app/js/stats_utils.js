// 统计聚合纯函数模块（无浏览器全局依赖，可单测）
// 与 api.js 的 stats() 共用同一套聚合逻辑：
// dashboard / statistics 在“非管理员”角色下用过滤后的隐患数据调用本模块，
// 管理员直接对全量调用（api.stats() 内部也复用本模块）。
// 注意：不要 import api.js，避免 ESM 循环依赖（api.js 会 import 本模块）。
const CATEGORY_MAP = {
  wastewater: '废水排放', wastegas: '废气排放', solidWaste: '固废管理', noise: '噪音污染', other: '其他'
};

export function computeStats(hazards) {
  const list = Array.isArray(hazards) ? hazards : [];

  const counts = { total: list.length, pending: 0, processing: 0, reviewing: 0, closed: 0, overdue: 0 };
  const byDepartment = {};
  const byDepartmentDetail = {};
  const bySeverity = { general: 0, serious: 0, critical: 0 };
  const byCategory = {};
  const byLocation = {};
  const now = Date.now();
  const oneDay = 86400000;

  for (const h of list) {
    if (counts[h.status] !== undefined) counts[h.status]++;
    if (h.status !== 'closed' && h.dueDate && new Date(h.dueDate).getTime() < now) counts.overdue++;
    const d = h.department || '未分配';
    byDepartment[d] = (byDepartment[d] || 0) + 1;
    if (!byDepartmentDetail[d]) byDepartmentDetail[d] = { name: d, total: 0, pending: 0, processing: 0, reviewing: 0, closed: 0, overdue: 0 };
    const dd = byDepartmentDetail[d];
    dd.total++;
    if (dd[h.status] !== undefined) dd[h.status]++;
    if (h.status !== 'closed' && h.dueDate && new Date(h.dueDate).getTime() < now) dd.overdue++;

    const sev = String(h.severity || 'general').toLowerCase();
    if (bySeverity[sev] !== undefined) bySeverity[sev]++;

    const cat = CATEGORY_MAP[h.category] || h.category || '其他';
    byCategory[cat] = (byCategory[cat] || 0) + 1;

    const loc = h.location || '未填写位置';
    byLocation[loc] = (byLocation[loc] || 0) + 1;
  }

  const repeatLocations = Object.entries(byLocation)
    .filter(([_, v]) => v > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }));

  // 按日聚合（用于趋势 + 环比 + 同比）
  function dayKey(date) { return date.toISOString().slice(0, 10); }
  const daily = {};
  list.forEach(h => {
    const c = (h.createdAt || '').slice(0, 10);
    if (c) {
      if (!daily[c]) daily[c] = { created: 0, closed: 0 };
      daily[c].created++;
    }
    if (h.status === 'closed' && h.closedAt) {
      const cl = (h.closedAt || '').slice(0, 10);
      if (cl) {
        if (!daily[cl]) daily[cl] = { created: 0, closed: 0 };
        daily[cl].closed++;
      }
    }
  });

  // 近 30 天趋势
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now - i * oneDay);
    const key = dayKey(day);
    trend.push({ date: key, created: daily[key]?.created || 0, closed: daily[key]?.closed || 0 });
  }

  const sumRange = (startOffDays, days) => {
    let c = 0, cl = 0;
    for (let i = 0; i < days; i++) {
      const key = dayKey(new Date(now - (startOffDays + i) * oneDay));
      c += daily[key]?.created || 0;
      cl += daily[key]?.closed || 0;
    }
    return { created: c, closed: cl };
  };
  const thisWeek = sumRange(0, 7);
  const lastWeek = sumRange(7, 7);
  const mom = lastWeek.created ? (((thisWeek.created - lastWeek.created) / lastWeek.created) * 100).toFixed(1) : '0.0';
  const thisMonth = sumRange(0, 30);
  const lastMonth = sumRange(30, 30);
  const yoy = lastMonth.created ? (((thisMonth.created - lastMonth.created) / lastMonth.created) * 100).toFixed(1) : '0.0';

  const alerts = [];
  if (counts.overdue > 0) alerts.push({ level: 'danger', text: `存在 ${counts.overdue} 条逾期隐患，请优先督办闭环。` });
  if (Number(mom) > 50) alerts.push({ level: 'warning', text: `本周新增环比上周增长 ${mom}%，请关注激增原因。` });
  if (Number(mom) < -30) alerts.push({ level: 'info', text: `本周新增环比上周下降 ${Math.abs(mom)}%，整改成效显著。` });
  const criticalCount = bySeverity.critical;
  if (criticalCount > 0) alerts.push({ level: 'danger', text: `发现 ${criticalCount} 条严重隐患，需立即处置。` });

  return {
    counts,
    byDepartment: Object.entries(byDepartment).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    byDepartmentDetail: Object.values(byDepartmentDetail).sort((a, b) => b.total - a.total),
    bySeverity,
    byCategory: Object.entries(byCategory).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    repeatLocations,
    trend,
    comparison: { thisWeek, lastWeek, mom, thisMonth, lastMonth, yoy },
    alerts
  };
}
