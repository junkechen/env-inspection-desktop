// 科室（业务域）定义 —— 多科室隔离的唯一配置出处
//
// 设计约束（来自 xuncha多科室隔离方案.md）：
//   1. 科室是身份属性，不是会话选项 —— 登录时不让用户选，由后台配置的 users.deptCode 决定。
//   2. 只有同时归属多个科室的人才会看到切换入口。
//   3. 切换必须清缓存，否则会读到另一个科室的旧数据（原 api.js collectionKey 只有
//      'col:hazards:{}'，两科室共用同一条缓存，TTL 60s + localStorage 持久化）。
//
// 科室字典已迁到云端（appConfig 集合的 depts key，见 config_store.js + builtin_dict.js）：
//   · 管理员在【配置管理】里增删改，所有客户端无需重新编译即可生效；
//   · 本文件只做「组装」——把动态字典与老导出名对齐，保证既有调用方零改造；
//   · 静态常量（DEPTS 等）保留为离线兜底值，运行时请优先用动态函数
//     （activeDepts / allDepts / deptInfoOf / deptLabelOf / deptRefCount）。
//
// 注意：本模块依赖 config_store（取动态值），而 api.js 反向依赖本模块的 currentDept()，
//      因此这里一旦在「顶层」引入 api 就会形成环。
//      依赖方向：dept → config_store → api → dept，环靠 ES Module 的 live binding
//      + 全部在「函数体内」调用而非顶层求值来保证安全（项目里 api↔store 同理）。

import {
  allDepts, deptInfoOf, deptCodes as dynDeptCodes, deptLabelOf
} from './config_store.js';
// 业务隔离口径（v1.0.28）：inDeptScope 改按「可见业务集合」判定。
// business.js / stats_utils.js 均不反向依赖本模块的顶层值（环同上，仅函数体内调用）。
import { visibleBizCodes } from './business.js';
import { businessOf } from './stats_utils.js';

export const DEFAULT_DEPT = 'JN';

const KEY = 'gz_dept';

/** 离线兜底科室（config_store 尚未加载云端值时用，保证 JN/AQ 永远有效） */
function fallbackDepts() {
  return allDepts();
}

export function deptCodes() { return dynDeptCodes(); }

export function isValidDept(code) { return deptCodes().indexOf(code) !== -1; }

/** 当前激活科室。永远返回合法值，脏值回退到默认科室 */
export function currentDept() {
  try {
    const v = localStorage.getItem(KEY);
    return isValidDept(v) ? v : DEFAULT_DEPT;
  } catch (e) {
    return DEFAULT_DEPT;
  }
}

export function setDept(code) {
  if (!isValidDept(code)) return;
  try { localStorage.setItem(KEY, code); } catch (e) { /* 隐私模式下忽略 */ }
}

/** 退出登录时清掉，避免下一个人读到上一个用户的科室 */
export function resetDept() {
  try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
}

/**
 * 该用户可访问的科室列表。
 * 来源：login 返回体（服务端根据 users.deptCodes 计算）。
 * 存量用户尚未回填 deptCodes，服务端会兜底给 ['JN']，此时只剩一个科室、不显示切换入口。
 */
export function availableDepts(user) {
  const codes = (user && user.deptCodes) || [];
  const valid = codes.filter(isValidDept);
  return valid.length ? valid : [DEFAULT_DEPT];
}

/**
 * 登录后同步当前科室。
 * 只在"当前值不在可用列表里"时纠正 —— 这样单人单科室的用户永远不会被改写，
 * 多科室用户也不会落到自己无权访问的科室里。
 */
export function syncDeptFromUser(user) {
  const avail = availableDepts(user);
  if (avail.indexOf(currentDept()) === -1) setDept(avail[0]);
}

export function deptInfo(code) {
  const c = isValidDept(code) ? code : DEFAULT_DEPT;
  return deptInfoOf(c) || fallbackDepts().find((d) => d.code === DEFAULT_DEPT) || { code: DEFAULT_DEPT, name: '默认科室', short: '默认', color: '#64748b', icon: '🏷' };
}

// ============================================================
// 业务 → 科室 隔离字典（业务/类别唯一真源在 config_store.js）
//
// 隐患归属科室的判定顺序见 hazardDeptOf：
//   1. 自身 deptCode（上报时已按业务写入）
//   2. 自身 businessType → deptOfBusiness（读取业务条目的 dept 字段）
//   3. 自身 category（中文）→ businessOfCategory 反查业务 → 再映射科室
//   4. 兜底默认科室
// 类别在库里存中文本身，故反查仍用中文匹配，历史数据零迁移。
// ============================================================
import { categoryNamesOf, deptOfBusiness, bizOfCategoryName } from './config_store.js';

/**
 * 类别下拉：指定业务返回该业务的启用类别；不指定返回全部（合并各业务）。
 *
 * 动态字典：管理员在【配置管理】新增/停用的类别会反映到这里。
 * 取不到配置时 categoryNamesOf 内部回退内置字典，因此永远不会返回空数组 ——
 * 字典故障不应该表现为“所有人都没法上报隐患”。
 */
export function categoryOptions(businessCode) {
  return categoryNamesOf(businessCode);
}

/**
 * 隐患归属哪个科室。
 * 用途：列表/导出前的兜底过滤 —— 服务端过滤未开启时，前端至少不能把另一科室的数据混进来。
 *
 * 判定顺序：deptCode 优先 → businessType 映射 → 旧数据靠中文类别反查业务 → 兜底默认科室。
 */
export function hazardDeptOf(h) {
  if (!h) return DEFAULT_DEPT;
  if (isValidDept(h.deptCode)) return h.deptCode;
  if (h.businessType) {
    const d = deptOfBusiness(h.businessType);
    if (isValidDept(d)) return d;
  }
  // 旧隐患无 businessType：靠中文类别反查业务 → 科室。
  // 反查走「含已停用」的全量字典（bizOfCategoryName），
  // 否则管理员停用某个类别后，历史隐患会被静默改判到兜底科室。
  const biz = bizOfCategoryName(h.category);
  if (biz) {
    const d = deptOfBusiness(biz);
    if (isValidDept(d)) return d;
  }
  return DEFAULT_DEPT;
}

/**
 * 该用户是否可见此隐患 —— v1.0.28 起统一判定口径（按业务隔离）。
 *
 * 可见 ⇔ 隐患业务（businessType，缺失按类别反查，见 stats_utils.businessOf）
 * ∈ 用户可见业务集合（business.js visibleBizCodes：admin 全部 / 显式赋权 /
 * deptCodes 派生 / 存量兼容全部）。业务本就归属科室，按业务隔离天然蕴含科室隔离。
 *
 * 徽章（currentDept）不参与本判定 —— 只决定仪表盘分组视角与默认业务 tab。
 * 历史教训：v1.0.24~v1.0.27 三版回归均因「徽章参与数据过滤」且多处口径不一致
 * （本函数 vs permission.js 的 inCurrentDept 层），v1.0.28 起全端唯一口径。
 */
export function inDeptScope(h, user) {
  return visibleBizCodes(user).indexOf(businessOf(h)) !== -1;
}

// ============================================================
// 切换科室
//
// 只负责落当前科室，返回 true 表示确实切换了。
// **调用方（app.js）必须紧接着清缓存并回到首页**：
// 缓存键虽然带科室前缀（见 api.js collectionKey），
// 但手上打开着另一科室的详情页/草稿时，留在原页面会造成上下文错乱。
// ============================================================
export function switchDept(code) {
  if (!isValidDept(code) || code === currentDept()) return false;
  setDept(code);
  return true;
}
