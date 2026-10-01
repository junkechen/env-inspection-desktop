// 业务类型定义 —— 用户业务归属 + 隐患类别级联的配置入口
//
// 与「科室」（dept.js，数据隔离维度）相互独立：
//   · 业务类型（安全/节能/环保…）是用户/隐患的标签；
//   · 科室（AQ/JN）决定数据可见范围，由「业务 → 科室」映射推导。
//
// 字典本体已迁到云端（appConfig 集合，见 config_store.js + builtin_dict.js）：
//   · 管理员在【配置管理】里增删改，所有客户端无需重新编译即可生效；
//   · 本文件只做「组装」——把动态字典与老导出名对齐，保证既有调用方零改造；
//   · 静态常量（BUSINESS_TYPES 等）保留为离线兜底值，运行时请优先用动态函数
//     （activeBusinesses / businessOptions / deptOfBusiness / categoryNamesOf）。
import {
  BUILTIN_BUSINESS_TYPES, BUILTIN_BUSINESS_TO_DEPT,
  BUILTIN_CATEGORY_BY_BUSINESS, BUILTIN_BUSINESS_OF_CATEGORY
} from './builtin_dict.js';
import {
  activeBusinesses, deptOfBusiness, bizOfCategoryName
} from './config_store.js';

/**
 * 【授权模式】账号未显式设置 businessTypes 时怎么算。
 *
 *   'inherit'（默认）: 继承「当前科室派生的业务」——等价于老版本的“全能”语义。
 *                      保留它是为了不打断存量账号：历史上管理员从未给普通账号设过
 *                      业务，一刀切成“空=无权限”会让所有人打开软件就看不到业务。
 *   'strict'         : 空即未授权，什么业务都用不了，必须管理员显式赋权。
 *
 * 什么时候改成 'strict'：管理员已在【用户管理】用「批量赋权」把存量账号补齐后。
 * 注意：无论哪种模式，管理员（role=admin）账号始终继承全部 —— 否则 admin 自己
 * 把自己锁死，连赋权界面都进不去（这是最容易踩的自锁坑）。
 */
export const UNAUTH_MODE = 'inherit';

/** @deprecated 仅为兼容旧 import；运行时请用 activeBusinesses() */
export const BUSINESS_TYPES = BUILTIN_BUSINESS_TYPES;
export const BUSINESS_OPTS = BUILTIN_BUSINESS_TYPES.map((b) => ({ value: b.code, label: b.name }));
export const BUSINESS_ALL_CODES = BUILTIN_BUSINESS_TYPES.map((b) => b.code);
export const BUSINESS_TO_DEPT = BUILTIN_BUSINESS_TO_DEPT;
export const CATEGORY_BY_BUSINESS = BUILTIN_CATEGORY_BY_BUSINESS;
export const BUSINESS_OF_CATEGORY = BUILTIN_BUSINESS_OF_CATEGORY;

/**
 * 当前用户的业务类型信息数组（过滤脏值）。
 *
 * 【为什么这是“默认不赋权”的实现点】
 *   user.businessTypes 是**显式列表**，管理员在【用户管理】里勾选才有值。
 *   字典里新增一项（比如 suppression 抑尘业务）不会写进任何人的 businessTypes，
 *   因此天然不会自动出现在任何用户的下拉里 —— 字典新增与赋权是两条独立链路。
 */
export function businessInfos(user) {
  const codes = (user && Array.isArray(user.businessTypes)) ? user.businessTypes : [];
  const dict = activeBusinesses();
  return codes.map((c) => dict.find((b) => b.code === c)).filter(Boolean);
}

/** 右上角徽章用：短名拼接，如「安全 / 节能」；未设置视为全部业务 */
export function businessShortLabel(user) {
  const infos = businessInfos(user);
  return infos.length ? infos.map((i) => i.short || i.name).join(' / ') : '全部业务';
}

/** 列表列用：全名拼接，如「安全业务 / 节能业务」；空数组视为全部业务 */
export function businessNames(row) {
  const codes = (row && Array.isArray(row.businessTypes)) ? row.businessTypes : [];
  const dict = activeBusinesses();
  const names = codes.map((c) => (dict.find((b) => b.code === c) || {}).name || c);
  return names.join(' / ') || '全部业务';
}

/** 隐患业务中文名（用于列表/详情展示） */
export function businessLabelOf(code) {
  const b = activeBusinesses().find((x) => x.code === code);
  return b ? b.name : (code || '—');
}

/** 业务下拉选项（动态，管理员新增的业务会立刻出现在这里） */
export function businessOptions() {
  return activeBusinesses().map((b) => ({ value: b.code, label: b.name }));
}

/** 全部业务 code（动态） */
export function businessCodes() {
  return activeBusinesses().map((b) => b.code);
}

/** 业务 → 科室（动态，含被停用业务，保证历史数据仍可定位科室） */
export function deptOf(code) {
  return deptOfBusiness(code);
}

/**
 * 指定科室下「可见」的业务列表（科室隔离：SAFE→AQ，SAVING/ENV→JN）。
 *
 * 优先级（含两次历史修复，改动前请先看这里）：
 *   1. 账号已设业务权限（businessTypes 非空）→ 以账号权限为准，不被科室限死。
 *      （v1.0.14：修复“多业务用户只能看到一项”）
 *   2. 管理员账号 → 继承当前科室派生的业务，保证右上角切科室后仪表盘联动。
 *   3. 其他角色未设业务 → 看 UNAUTH_MODE：
 *        inherit（默认）= 继承科室派生，兼容存量账号；
 *        strict           = 空数组，体现“未赋权不可用”。
 */
export function businessesForDept(deptCode, user) {
  const infos = businessInfos(user);
  if (infos.length) return infos;
  const dict = activeBusinesses();
  const u = user || {};
  const isAdminUser = u.role === 'admin' || u.username === 'admin' || u.username === 'Administrator';
  if (!isAdminUser && UNAUTH_MODE === 'strict') return [];
  const deptBiz = dict.filter((b) => deptOfBusiness(b.code) === deptCode);
  return deptBiz.length ? deptBiz : dict;
}

/** 类别 → 业务 反查（动态，含已停用类别 —— 历史隐患的科室归属全靠它） */
export function businessOfCategory(name) {
  return bizOfCategoryName(name);
}
