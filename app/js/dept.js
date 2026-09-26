// 科室（业务域）定义 —— 多科室隔离的唯一配置出处
//
// 设计约束（来自 xuncha多科室隔离方案.md）：
//   1. 科室是身份属性，不是会话选项 —— 登录时不让用户选，由后台配置的 users.deptCode 决定。
//   2. 只有同时归属多个科室的人才会看到切换入口。
//   3. 切换必须清缓存，否则会读到另一个科室的旧数据（原 api.js collectionKey 只有
//      'col:hazards:{}'，两科室共用同一条缓存，TTL 60s + localStorage 持久化）。
//
// 注意：本模块保持零依赖 —— 不 import api.js / cache.js。
//       api.js 会反向依赖本模块的 currentDept()，因此这里一旦引入依赖就会形成环，
//       ES Module 在这种环上的初始化顺序不可靠。清缓存的动作交给调用方执行。

export const DEPTS = [
  { code: 'JN', name: '节能环保科', short: '节能环保', color: '#2e9e5b', icon: '🌿' },
  { code: 'AQ', name: '安全科', short: '安全', color: '#e8823c', icon: '⚠' }
];

export const DEFAULT_DEPT = 'JN';

const KEY = 'gz_dept';

export function deptCodes() { return DEPTS.map((d) => d.code); }

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
 * 来源：login 返回体（服务端根据 users.deptCode 计算）。
 * 存量用户尚未回填 deptCode，服务端会兜底给 ['JN']，此时只剩一个科室、不显示切换入口。
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
  return DEPTS.find((d) => d.code === c) || DEPTS[0];
}

// ============================================================
// 业务 → 科室 隔离字典（业务/类别唯一真源在 business.js）
//
// 隐患归属科室的判定顺序见 hazardDeptOf：
//   1. 自身 deptCode（上报时已按业务写入）
//   2. 自身 businessType → BUSINESS_TO_DEPT
//   3. 自身 category（中文）→ BUSINESS_OF_CATEGORY 反查业务 → 再映射科室
//   4. 兜底默认科室
// 类别在库里存中文本身，故 BUSINESS_OF_CATEGORY 仍用中文匹配，历史数据零迁移。
// ============================================================
import { CATEGORY_BY_BUSINESS, BUSINESS_TO_DEPT, BUSINESS_OF_CATEGORY } from './business.js';

/** 类别下拉：指定业务返回该业务类别；不指定返回全部（合并三业务） */
export function categoryOptions(businessCode) {
  if (businessCode && CATEGORY_BY_BUSINESS[businessCode]) return CATEGORY_BY_BUSINESS[businessCode];
  return Object.values(CATEGORY_BY_BUSINESS).flat();
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
  if (h.businessType && BUSINESS_TO_DEPT[h.businessType] && isValidDept(BUSINESS_TO_DEPT[h.businessType])) {
    return BUSINESS_TO_DEPT[h.businessType];
  }
  // 旧隐患无 businessType：靠中文类别反查业务 → 科室
  const biz = BUSINESS_OF_CATEGORY[h.category];
  if (biz && BUSINESS_TO_DEPT[biz] && isValidDept(BUSINESS_TO_DEPT[biz])) return BUSINESS_TO_DEPT[biz];
  return DEFAULT_DEPT;
}

/** 是否命中当前科室（列表/统计/导出统一用这个） */
export function inCurrentDept(h) { return hazardDeptOf(h) === currentDept(); }

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
