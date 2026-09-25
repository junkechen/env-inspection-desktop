// 业务类型定义 —— 用户业务归属的唯一配置出处
// 与「科室」（dept.js，数据隔离维度）相互独立：业务类型是用户标签，科室决定数据可见范围。
export const BUSINESS_TYPES = [
  { code: 'SAFE', name: '安全业务', short: '安全', color: '#e8823c', icon: '⚠' },
  { code: 'ENERGY', name: '能源环保业务', short: '能源环保', color: '#2e9e5b', icon: '🌿' },
  { code: 'SITE', name: '现场业务', short: '现场', color: '#3b82f6', icon: '🏗' },
  { code: 'EQUIP', name: '设备业务', short: '设备', color: '#8b5cf6', icon: '🔧' }
];

export const BUSINESS_OPTS = BUSINESS_TYPES.map((b) => ({ value: b.code, label: b.name }));

/** 当前用户的业务类型信息数组（code→定义对象，过滤脏值） */
export function businessInfos(user) {
  const codes = (user && Array.isArray(user.businessTypes)) ? user.businessTypes : [];
  return codes.map((c) => BUSINESS_TYPES.find((b) => b.code === c)).filter(Boolean);
}

/** 右上角徽章用：短名拼接，如「安全 / 设备」；未设置返回「未分配」 */
export function businessShortLabel(user) {
  const infos = businessInfos(user);
  return infos.length ? infos.map((i) => i.short).join(' / ') : '未分配';
}

/** 列表列用：全名拼接，如「安全业务 / 设备业务」；空数组返回「—」 */
export function businessNames(row) {
  const codes = (row && Array.isArray(row.businessTypes)) ? row.businessTypes : [];
  const names = codes.map((c) => (BUSINESS_TYPES.find((b) => b.code === c) || {}).name || c);
  return names.join(' / ') || '—';
}
