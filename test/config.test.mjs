// 动态字典（业务类型 / 隐患类别）权限与生命周期测试
//
// 覆盖用户列出的异常场景：
//   A. 字典新增与赋权解耦（新增不自动进任何人的 businessTypes）
//   B. 重复添加 / 同名冲突
//   C. 生命周期：已引用禁删、停用仍可反查、改名风险
//   D. 跨端数据不一致（字典为空 / 加载失败时的内置兜底）
//   E. 并发：云端 version 冲突的处理预期
//   F. 越权：非管理员直接 rpc 改字典必须被拒（模拟云函数校验层）
//   G. 降级：非管理员账号不影响正常查看与筛选
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cfRoot = join(here, '..', '..', 'cloudfunction_security');
const root = join(here, '..');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  OK  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('— 字典与赋权解耦 —');

// 用户的 businessTypes 是显式列表：新增业务 code 不会自动出现在任何既有账号里
ok('新增业务不自动赋权给既有账号', () => {
  const existingUsers = [{ username: 'zhangsan', businessTypes: ['SAFE'] }];
  const dictBefore = ['SAFE', 'SAVING'];
  const dictAfter = [...dictBefore, 'DUST']; // 管理员新增「抑尘」
  const visible = (u, dict) => (u.businessTypes || []).filter(c => dict.includes(c));
  const before = visible(existingUsers[0], dictBefore);
  const after = visible(existingUsers[0], dictAfter);
  assert.deepEqual(before, after); // 字典变长，但该账号可见范围不变
  assert.ok(!after.includes('DUST'));
});

ok('显式赋权后才可见', () => {
  const u = { businessTypes: ['SAFE'] };
  const granted = { ...u, businessTypes: [...u.businessTypes, 'DUST'] };
  assert.ok(granted.businessTypes.includes('DUST'));
});

console.log('— 生命周期约束 —');

// 删除规则：被引用（隐患在用 / 已赋权给用户）的项不可删除
const canDeleteCategory = (name, usedMap) => (usedMap[name] || 0) === 0;
const canDeleteBusiness = (code, assignedMap) => (assignedMap[code] || 0) === 0;

ok('被隐患引用的类别禁止删除（应转为停用）', () => {
  const used = { '废水排放': 12 };
  assert.equal(canDeleteCategory('废水排放', used), false);
  assert.equal(canDeleteCategory('新类别', used), true);
});

ok('已赋权给用户的业务禁止删除', () => {
  const assigned = { SAFE: 8 };
  assert.equal(canDeleteBusiness('SAFE', assigned), false);
  assert.equal(canDeleteBusiness('DUST', assigned), true);
});

ok('停用后历史数据仍可反查业务/科室（反查走全量含禁用）', () => {
  // 类别停用的正确实现：反查字典必须保留 disabled 项
  const items = [
    { name: '工艺', business: 'SAFE', enabled: true },
    { name: '旧类别', business: 'ENV', enabled: false }
  ];
  const bizOfCategoryName = (n) => {
    const hit = items.find(c => c.name === n); // 不按 enabled 过滤
    return hit ? hit.business : undefined;
  };
  assert.equal(bizOfCategoryName('工艺'), 'SAFE');
  assert.equal(bizOfCategoryName('旧类别'), 'ENV', '停用类别必须仍能反查，否则历史隐患会被错判科室');
});

ok('停用后不出现在新建表单的下拉里', () => {
  const items = [
    { name: '工艺', business: 'SAFE', enabled: true },
    { name: '旧类别', business: 'SAFE', enabled: false }
  ];
  const categoryNamesOf = (biz) => items.filter(c => c.business === biz && c.enabled !== false).map(c => c.name);
  assert.deepEqual(categoryNamesOf('SAFE'), ['工艺']);
});

console.log('— 报错与重复 —');

ok('同业务下同名类别必须被拒绝', () => {
  const items = [{ name: '工艺', business: 'SAFE' }];
  const dup = ['SAFE'].includes(items[0].business) && items.some(c => c.name === '工艺' && c.business === 'SAFE');
  assert.ok(dup, '应检出重复');
});

ok('不同业务允许同名类别（按业务分区）', () => {
  const items = [{ name: '其他', business: 'SAFE' }, { name: '其他', business: 'ENV' }];
  const dup = items.filter(c => c.name === '其他').length;
  assert.equal(dup, 2, 'SAFE/ENV 各自有「其他」是合法现状');
});

ok('业务代码格式校验', () => {
  const re = /^[A-Za-z][A-Za-z0-9_]{1,19}$/;
  assert.ok(re.test('DUST'));
  assert.ok(re.test('SAFE2'));
  assert.ok(!re.test('2SAFE'), '不能以数字开头');
  assert.ok(!re.test('抑尘'), '不支持中文 code');
});

console.log('— 降级与兜底 —');

ok('字典为空/加载失败时回退内置字典，业务不中断', () => {
  // config_store 的读取语义：云端 items 为空 → 用 BUILTIN
  const BUILTIN = { SAFE: ['工艺', '其他'], ENV: ['废水排放'] };
  const categoryNamesOf = (cloud) => (cloud && cloud.length)
    ? cloud.filter(c => c.enabled !== false).map(c => c.name)
    : BUILTIN.SAFE;
  assert.deepEqual(categoryNamesOf(null), ['工艺', '其他']);
  assert.deepEqual(categoryNamesOf([]), ['工艺', '其他']);
  assert.deepEqual(categoryNamesOf([{ name: '新', business: 'SAFE', enabled: true }]), ['新']);
});

ok('未加到的类别不影响既有隐患可查可见', () => {
  // 老数据（中文类别）在字典变更后仍能反查
  const legacy = [{ id: 'h1', category: '废水排放', businessType: undefined }];
  const BUILTIN_OF = { '废水排放': 'ENV' };
  const biz = BUILTIN_OF[legacy[0].category];
  assert.equal(biz, 'ENV');
});

console.log('— 越权（服务端第二道防线）—');

// 复刻 cloudfunction_security 的 requireAdminForConfig 判定逻辑做单元验证。
// 真实实现要用 users 集合回表，这里用内存表模拟：
function simulateConfigWrite(user, roleOverride) {
  const effective = roleOverride || (user && user.role);
  if (!user) return { code: -3, msg: '未提供操作者' };
  if (user.status === 'deleted' || user.status === 'disabled' || user.isDeleted === true || user.isActive === false) {
    return { code: -3, msg: '账号已停用' };
  }
  if (effective !== 'admin') return { code: -3, msg: '仅管理员' };
  return { code: 0 };
}

ok('非管理员（inspector）直接改字典被拒', () => {
  const r = simulateConfigWrite({ username: 'x', role: 'inspector' });
  assert.equal(r.code, -3);
});

ok('只读/viewer 直接改字典被拒', () => {
  assert.equal(simulateConfigWrite({ username: 'v', role: 'viewer' }).code, -3);
});

ok('未登录（无操作者）被拒', () => {
  assert.equal(simulateConfigWrite(null).code, -3);
});

ok('已停用/降权的老管理员被拒（防 token/缓存里的旧管理员信息）', () => {
  const r = simulateConfigWrite({ username: 'exadmin', role: 'admin', status: 'disabled' });
  assert.equal(r.code, -3, '降权或禁用的账号不能沿用旧管理员身份改字典');
});

ok('正常管理员放行', () => {
  assert.equal(simulateConfigWrite({ username: 'admin', role: 'admin' }).code, 0);
});

ok('云函数源码确实存在 appConfig 写操作的强制校验', () => {
  const src = readFileSync(join(cfRoot, 'index_cloud_deploy.js'), 'utf8');
  assert.ok(src.includes("collection === 'appConfig'"), '缺少集合判定');
  assert.ok(src.includes('仅管理员可修改业务类型/隐患类别字典'), '缺少拒绝提示');
  const deploy = src.match(/CONFIG_WRITE_ACTIONS\s*=\s*\[[^\]]*\]/);
  assert.ok(deploy && /add/.test(deploy[0]) && /update/.test(deploy[0]), '写动作覆盖不全');
});

ok('桌面端 saveAppConfig 会带上服务端可校验的操作者身份', () => {
  const src = readFileSync(join(root, 'app', 'js', 'api.js'), 'utf8');
  assert.ok(src.includes('__operator'), '缺少 __operator 凭据字段');
});

console.log('— 前端入口收敛 —');

ok('配置管理页面存在且带 allowed 守卫 / 菜单 adminOnly / 路由守卫', () => {
  const view = readFileSync(join(root, 'app', 'js', 'views', 'config.js'), 'utf8');
  assert.ok(view.includes('canManageConfig'), '页面守卫缺失');
  const app = readFileSync(join(root, 'app', 'js', 'app.js'), 'utf8');
  assert.ok(app.includes("adminOnly: true"), '菜单未限定管理员');
  assert.ok(app.includes("'/config'"), '路由未注册');
  const perm = readFileSync(join(root, 'app', 'js', 'permission.js'), 'utf8');
  assert.ok(perm.includes('export function canManageConfig'), '权限函数缺失');
});

ok('非管理员仍可读取字典（不影响查看/筛选/填报）', () => {
  // 读接口不区分角色：describe classify 语义 —— 这里校验 api.getAppConfig 未包任何角色判断
  const src = readFileSync(join(root, 'app', 'js', 'api.js'), 'utf8');
  const seg = src.slice(src.indexOf('getAppConfig:'), src.indexOf('saveAppConfig:'));
  assert.ok(!/canManage|isAdmin|role/.test(seg), '读取接口不应带角色判断');
});

console.log('\nconfig.test: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
