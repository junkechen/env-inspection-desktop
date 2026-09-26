// 业务类型定义 —— 用户业务归属 + 隐患类别级联的唯一配置出处
//
// 与「科室」（dept.js，数据隔离维度）相互独立：
//   · 业务类型（安全/节能/环保）是用户/隐患的标签；
//   · 科室（AQ/JN）决定数据可见范围，由「业务 → 科室」映射推导。
//
// 本模块是类别字典的唯一真源，dept.js 会反向 import 本模块（business.js 不依赖 dept.js，无环）。

export const BUSINESS_TYPES = [
  { code: 'SAFE', name: '安全业务', short: '安全', color: '#e8823c', icon: '⚠' },
  { code: 'SAVING', name: '节能业务', short: '节能', color: '#2e9e5b', icon: '🌿' },
  { code: 'ENV', name: '环保业务', short: '环保', color: '#38bdf8', icon: '♻' }
];

export const BUSINESS_OPTS = BUSINESS_TYPES.map((b) => ({ value: b.code, label: b.name }));

/** 全部业务类型 code —— 新增/未设置用户默认全选 */
export const BUSINESS_ALL_CODES = BUSINESS_TYPES.map((b) => b.code);

/** 业务 → 科室（数据隔离），与 dept.js 的 DEPTS.code 对应 */
export const BUSINESS_TO_DEPT = {
  SAFE: 'AQ',
  SAVING: 'JN',
  ENV: 'JN'
};

/**
 * 按业务划分的隐患类别字典（库里仍存中文本身，历史数据零迁移）。
 * 上报隐患时先选业务、再从本字典取类别下拉；安全业务 13 项（含其他），
 * 节能 10 项，环保 5 项（沿用原废水/废气/固废/噪音/其他）。
 */
export const CATEGORY_BY_BUSINESS = {
  SAFE: [
    '工艺', '电气仪表', '消防应急', '设备隐患', '规章制度', '特种设备',
    '培训教育', '安全投入', '违章操作', '职业卫生', '有限空间', '外来施工', '其他'
  ],
  SAVING: [
    '节水', '节电', '压风', '氢气', '氮气', '燃气', '耗能设备',
    '工艺节能', '浪费损耗', '碳排管理'
  ],
  ENV: [
    '废水排放', '废气排放', '固废管理', '噪音污染', '其他'
  ]
};

/** 类别 → 业务 反查（旧隐患无 businessType，靠类别归业务；再映射科室） */
export const BUSINESS_OF_CATEGORY = (() => {
  const m = {};
  for (const b of Object.keys(CATEGORY_BY_BUSINESS)) {
    for (const c of CATEGORY_BY_BUSINESS[b]) m[c] = b;
  }
  return m;
})();

/** 当前用户的业务类型信息数组（code→定义对象，过滤脏值） */
export function businessInfos(user) {
  const codes = (user && Array.isArray(user.businessTypes)) ? user.businessTypes : [];
  return codes.map((c) => BUSINESS_TYPES.find((b) => b.code === c)).filter(Boolean);
}

/** 右上角徽章用：短名拼接，如「安全 / 节能」；未设置视为全部业务 */
export function businessShortLabel(user) {
  const infos = businessInfos(user);
  return infos.length ? infos.map((i) => i.short).join(' / ') : '全部业务';
}

/** 列表列用：全名拼接，如「安全业务 / 节能业务」；空数组视为全部业务 */
export function businessNames(row) {
  const codes = (row && Array.isArray(row.businessTypes)) ? row.businessTypes : [];
  const names = codes.map((c) => (BUSINESS_TYPES.find((b) => b.code === c) || {}).name || c);
  return names.join(' / ') || '全部业务';
}

/** 隐患业务中文名（用于列表/详情展示） */
export function businessLabelOf(code) {
  const b = BUSINESS_TYPES.find((x) => x.code === code);
  return b ? b.name : (code || '—');
}
