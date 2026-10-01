// 内置默认字典 —— 业务类型 + 隐患类别的「种子数据」与「离线兜底」。
//
// 动态配置上线后，字典的唯一真源迁移到云端 appConfig 集合（见 config_store.js）：
//   · 云端有配置（或已播种）      → 以云端为准，管理员改动即时生效；
//   · 云端没配置 / 断网 / 请求失败 → 回退本模块的静态默认值，业务零中断。
//
// 之所以单独拆成这个文件，而不放在 business.js：business.js 需要反向依赖
// config_store.js（取动态值），而 config_store.js 又要读本文件的默认值作为种子。
// 若默认值写在 business.js 会形成 business ↔ config_store 的双向依赖环；
// 抽到第三层后依赖方向变成「business → config_store → builtin_dict」的单链。
// 环: business → config_store → api → stats_utils → business 的处理见 config_store.js 顶部注释。

/** 内置业务类型（新增/未设置业务的账号默认全选） */
export const BUILTIN_BUSINESS_TYPES = [
  { code: 'SAFE', name: '安全业务', short: '安全', color: '#e8823c', icon: '⚠' },
  { code: 'SAVING', name: '节能业务', short: '节能', color: '#2e9e5b', icon: '🌿' },
  { code: 'ENV', name: '环保业务', short: '环保', color: '#38bdf8', icon: '♻' }
];

/** 业务 → 科室（数据隔离维度），与 dept.js 的 DEPTS.code 对应 */
export const BUILTIN_BUSINESS_TO_DEPT = {
  SAFE: 'AQ',
  SAVING: 'JN',
  ENV: 'JN'
};

/**
 * 内置隐患类别（按业务划分）。
 * 库里仍存中文本身，历史数据零迁移 —— 这一点决定了后续所有设计：
 * 类别改名/禁用都不能物理删除，否则历史隐患会失去「类别 → 业务 → 科室」的反查能力。
 *   安全 13 项（含其他）、节能 10 项、环保 5 项（沿用原废水/废气/固废/噪音/其他）。
 */
export const BUILTIN_CATEGORY_BY_BUSINESS = {
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

/** 类别 → 业务 反查（旧隐患无 businessType，靠中文类别归业务，再映射科室） */
export const BUILTIN_BUSINESS_OF_CATEGORY = (() => {
  const m = {};
  for (const b of Object.keys(BUILTIN_CATEGORY_BY_BUSINESS)) {
    for (const c of BUILTIN_CATEGORY_BY_BUSINESS[b]) m[c] = b;
  }
  return m;
})();

/** 内置业务类型 → appConfig items 结构（播种用） */
export function builtinBusinessItems() {
  return BUILTIN_BUSINESS_TYPES.map((b, i) => ({
    code: b.code,
    name: b.name,
    short: b.short,
    color: b.color,
    icon: b.icon,
    dept: BUILTIN_BUSINESS_TO_DEPT[b.code] || 'JN',
    enabled: true,
    sort: i + 1
  }));
}

/** 内置隐患类别 → appConfig items 结构（播种用） */
export function builtinCategoryItems() {
  const items = [];
  let sort = 1;
  for (const biz of Object.keys(BUILTIN_CATEGORY_BY_BUSINESS)) {
    for (const name of BUILTIN_CATEGORY_BY_BUSINESS[biz]) {
      items.push({ name, business: biz, enabled: true, sort: sort++ });
    }
  }
  return items;
}
