// 动态配置仓库 —— 业务类型 / 隐患类别的运行时字典（云端真源 + 内置兜底）
//
// 【云端数据契约】集合 appConfig，两条文档（集合无需预先创建，首次 add 会自动建）：
//   { _id, key: 'business_types',  items: [{ code, name, short, color, icon, dept, enabled, sort }],
//     version, updateBy, updateTime }
//   { _id, key: 'issue_categories', items: [{ name, business, enabled, sort }],
//     version, updateBy, updateTime }
//
// 【为什么不是硬编码改造】
//   原本业务类型与隐患类别硬编码在 business.js / 手机端 issue.dart 里，
//   改一个字就要重新编译 APK 和 EXE。现在字典落到云端，管理员在界面上改完，
//   各端在下一次拉取（进入应用 / 窗口聚焦 / 60 秒定时 / 保存后立即）自动生效。
//
// 【兜底设计（业务连续性优先）】
//   1. 云端无配置（首次上线）→ 管理员首次打开配置页时把内置默认值播种上去；
//   2. 请求失败 / 断网 / 非管理员会话 → 一律回退 config_store 之外的内置字典
//      （builtin_dict.js），字典读取函数永远不返回空，业务不中断；
//   3. 类别只允许「禁用」不允许物理删除 —— 历史隐患存的是中文类名，
//      删掉记录会让这些隐患丢失「类别 → 业务 → 科室」的反查链路而被错误归科室。
//
// 【依赖环说明】
//   config_store → api：api.js 顶部导出的 api 对象用 import 进来后在函数体内使用，
//                        ESM live binding 下求值期不解引用，环安全（项目里 api↔store 同理）。
//   api → stats_utils → business：本模块 import stats_utils 只为了注入动态反查函数
//                        （setBizCategoryLookup），反过来 stats_utils 不必依赖
//                        config_store（它还被 node 单测直接 import），环得以断开。
import { api, getStoredUser } from './api.js';
import { setBizCategoryLookup } from './stats_utils.js';
import {
  BUILTIN_BUSINESS_TYPES, BUILTIN_BUSINESS_TO_DEPT,
  BUILTIN_CATEGORY_BY_BUSINESS, BUILTIN_BUSINESS_OF_CATEGORY,
  builtinBusinessItems, builtinCategoryItems
} from './builtin_dict.js';

// node 环境下没有全局 Vue（test/*.mjs 会间接 import 本模块链），降级为普通对象：
// 失去响应式，但纯函数取值行为完全一致，不影响单测结果。
const reactive = (typeof Vue !== 'undefined' && Vue.reactive) ? Vue.reactive : (s) => s;

export const KEY_BUSINESS = 'business_types';
export const KEY_CATEGORY = 'issue_categories';

export const configState = reactive({
  /** null = 尚未从云端取到；数组 = 云端值（含 enabled:false 的禁用项） */
  businessItems: null,
  categoryItems: null,
  loaded: false,
  /** 云端最近一次更新时间，界面上给管理员一个"配置是否已下发"的确认点 */
  updatedAt: '',
  seeding: false
});

function bySort(items) {
  return (items || []).slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
}

function currentOperator() {
  // 用 getStoredUser 而不是 store.user：避免把 store.js（顶层依赖全局 Vue）
  // 拖进本模块的依赖链 —— stats_utils.test.mjs 在 node 下直接 import 本链路，
  // 只要链上出现 `const { reactive } = Vue` 就会整片崩。
  const u = getStoredUser() || {};
  return { username: u.username || '', name: u.name || '', role: u.role || '' };
}

/**
 * 从云端加载配置。
 * @param {boolean} force true 时先失效本地缓存（保存后立即刷新、定时轮询用）
 *
 * 非管理员也要加载：字典对所有角色可见（要看得到、筛选得到），
 * 只是写操作由前端入口 + 云函数双重限定为管理员。
 */
export async function loadConfig(force = false) {
  try {
    if (force) await api.refreshCache('appConfig');
    const map = await api.getAppConfig();
    const biz = map[KEY_BUSINESS];
    const cat = map[KEY_CATEGORY];
    configState.businessItems = biz && Array.isArray(biz.items) ? bySort(biz.items) : [];
    configState.categoryItems = cat && Array.isArray(cat.items) ? bySort(cat.items) : [];
    configState.updatedAt = (biz && biz.updateTime) || (cat && cat.updateTime) || '';
    configState.loaded = true;
    // 无论是否管理员，反查函数都切到动态字典（含禁用类别，保证历史数据可反查）
    setBizCategoryLookup(bizOfCategoryName);
    return configState;
  } catch (e) {
    // 加载失败：保持现状（未加载则用内置兜底），不抛错 —— 字典读不到不能让界面崩
    console.warn('[config] 加载配置失败，沿用内置字典:', e && e.message);
    return configState;
  }
}

/**
 * 播种内置默认值（仅当云端该 key 没有文档）。
 *
 * 只在管理员会话里播种：一是避免普通用户会话产生意料之外的写请求，
 * 二是云函数侧已把 appConfig 的写操作限定为管理员（见 index.js 的 requireAdmin）。
 * 并发：由 configState.seeding 简单去抖，最坏情况是两条一样的种子文档，
 * 出现后可在配置页删除多余的（读取以第一条为准）。
 */
async function seedIfEmpty() {
  if (configState.seeding) return;
  const needBiz = !configState.businessItems || !configState.businessItems.length;
  const needCat = !configState.categoryItems || !configState.categoryItems.length;
  if (!needBiz && !needCat) return;
  configState.seeding = true;
  try {
    if (needBiz) await api.saveAppConfig(KEY_BUSINESS, builtinBusinessItems(), 'system-init');
    if (needCat) await api.saveAppConfig(KEY_CATEGORY, builtinCategoryItems(), 'system-init');
    await loadConfig(true);
  } catch (e) {
    console.warn('[config] 播种默认字典失败（不影响内置兜底）:', e && e.message);
  } finally {
    configState.seeding = false;
  }
}

/** 管理员打开配置页时调用：保证云端一定有字典可编辑（空数据引导） */
export async function ensureSeeded() {
  if (!configState.loaded) await loadConfig(true);
  await seedIfEmpty();
}

// ============================================================
// 字典读取（全部带内置兜底，调用方无需判断 loaded）
// ============================================================

/** 启用中的业务类型列表（下拉/切换栏用） */
export function activeBusinesses() {
  const items = (configState.businessItems || []).filter(b => b && b.enabled !== false);
  if (!items.length) return BUILTIN_BUSINESS_TYPES;
  return items;
}

/** 全部业务类型（含禁用）—— 反查/统计用，历史数据提到被禁用的业务时仍能定位 */
export function allBusinesses() {
  return (configState.businessItems || []).length ? configState.businessItems : BUILTIN_BUSINESS_TYPES;
}

/** 业务 → 科室：优先云端（含禁用业务），回退内置映射 */
export function deptOfBusiness(code) {
  const hit = allBusinesses().find(b => b.code === code);
  if (hit && hit.dept) return hit.dept;
  return BUILTIN_BUSINESS_TO_DEPT[code] || 'JN';
}

/** 指定业务的启用类别名数组（下拉用） */
export function categoryNamesOf(businessCode) {
  if (!configState.categoryItems || !configState.categoryItems.length) {
    if (businessCode && BUILTIN_CATEGORY_BY_BUSINESS[businessCode]) return BUILTIN_CATEGORY_BY_BUSINESS[businessCode];
    return Object.values(BUILTIN_CATEGORY_BY_BUSINESS).flat();
  }
  const hit = configState.categoryItems.filter(c => c && c.enabled !== false && (!businessCode || c.business === businessCode));
  return hit.map(c => c.name);
}

/** 全部启用类别（跨业务合并，去重后按业务分组顺序） */
export function allCategoryNames() {
  return categoryNamesOf('');
}

/**
 * 类别中文名 → 业务。
 * 走全部条目（含禁用）：历史隐患写了旧类别，即使类别被管理员停用，
 * 也必须能反查出它原本所属的业务/科室，否则会被误归到兜底科室。
 */
export function bizOfCategoryName(name) {
  if (!name) return undefined;
  if (configState.categoryItems && configState.categoryItems.length) {
    const hit = configState.categoryItems.find(c => c && c.name === name);
    if (hit) return hit.business;
  }
  return BUILTIN_BUSINESS_OF_CATEGORY[name];
}

// ============================================================
// 写操作（仅供管理员；云函数侧会二次校验，前端这道只是拦截与提示）
// ============================================================

export async function saveBusinessItems(items) {
  await api.saveAppConfig(KEY_BUSINESS, items, currentOperator());
  configState.businessItems = bySort(items);
  return true;
}

export async function saveCategoryItems(items) {
  await api.saveAppConfig(KEY_CATEGORY, items, currentOperator());
  configState.categoryItems = bySort(items);
  return true;
}
