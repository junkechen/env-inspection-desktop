// 视图冒烟测试（node test/views.smoke.test.mjs）
// 目的：无法启动 Electron GUI 的情况下，尽可能在 node 侧拦截运行期错误。
// 覆盖两层：
//  1. 真实 import 所有视图模块，验证 import/export 名字对得上、模块能求值；
//  2. 执行 setup() 并扫描模板，检查模板里用到的变量是否都在 setup() 返回值中
//     ——「模板引用了未暴露的函数」是最常见也最隐蔽的运行期崩溃来源。
import assert from 'assert';

// ---------- 模拟浏览器全局 ----------
const _ls = {};
global.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; }
};
global.window = {
  innerWidth: 1280,
  addEventListener: () => {},
  removeEventListener: () => {},
  getSelection: () => null
};
global.location = { hash: '#/', reload: () => {} };

global.Vue = {
  ref: (v) => ({ value: v }),
  reactive: (o) => o,
  computed: (fn) => {
    const o = {};
    Object.defineProperty(o, 'value', { get: fn });
    return o;
  },
  watch: () => {},
  onMounted: () => {},
  onBeforeUnmount: () => {},
  nextTick: () => Promise.resolve(),
  createApp: () => {
    const app = {
      config: {},
      use: () => app,
      component: () => app,
      mount: () => app
    };
    return app;
  }
};
global.ElementPlus = {
  ElMessage: { success() {}, error() {}, warning() {}, info() {} },
  ElMessageBox: { confirm: () => Promise.resolve(), prompt: () => Promise.resolve({ value: '' }) }
};
global.ElementPlusIconsVue = {
  Refresh: 'Refresh', Plus: 'Plus', View: 'View', ArrowLeft: 'ArrowLeft',
  Notification: 'Notification', Check: 'Check'
};
global.document = { createElement: () => ({}) };

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  \u2713 ' + name); pass++; })
    .catch((e) => { console.log('  \u2717 ' + name + ' -> ' + e.message); fail++; });
}

// ---------- 模板变量提取 ----------
// 需要排除的非业务标识符（JS 关键字/字面量/浏览器全局/模板局部变量）
const RESERVED = new Set([
  'true', 'false', 'null', 'undefined', 'new', 'typeof', 'in', 'of', 'if', 'else', 'return',
  'Math', 'Date', 'JSON', 'String', 'Number', 'Array', 'Object', 'Boolean', 'Promise',
  'console', 'window', 'document', 'localStorage', 'location', 'setTimeout', 'clearTimeout',
  'Vue', 'ElementPlus', 'ElementPlusIconsVue', 'echarts', 'item', 'key',
  // Vue 模板内置变量
  '$index', '$event', 'index'
]);

// 收集模板里所有可能被求值的表达式：{{ }} 插值 + v-*/:@ 指令值
function extractExpressions(tpl) {
  const out = [];
  const mustache = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = mustache.exec(tpl))) out.push(m[1]);
  // 指令属性：v-if / v-for / v-model / :prop / @event
  const dir = /(?:v-[a-zA-Z-]+|\:[a-zA-Z0-9-]+|@[a-zA-Z0-9-]+)\s*=\s*"([^"]*)"/g;
  while ((m = dir.exec(tpl))) out.push(m[1]);
  return out;
}

// 从表达式里取出「变量链的根标识符」，如 form.attachments → form，readMap[a._id] → readMap
function rootIdentifiers(expr) {
  const ids = [];
  // 去掉字符串字面量，避免把 '草稿' 之类当成标识符
  const cleaned = expr.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const re = /(^|[^.\w$'"])([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(cleaned))) ids.push(m[2]);
  return ids;
}

// 提取 v-for 的局部变量（如 (v,k) in CATEGORY_MAP 里的 v、k），这些不需要 setup 暴露
function extractForLocals(tpl) {
  const locals = new Set();
  const re = /v-for\s*=\s*"\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)?\s+in\s+/g;
  let m;
  while ((m = re.exec(tpl))) {
    if (m[1]) locals.add(m[1]);
    if (m[2]) locals.add(m[2]);
  }
  return locals;
}

// 提取作用域插槽变量（<template #default="{row}"> 里的 row），
// 这是 el-table 自定义列的常规写法，同样不需要 setup 暴露
function extractSlotLocals(tpl) {
  const locals = new Set();
  const re = /(?:#default|#header|v-slot(?::[\w-]+)?|slot-scope)\s*=\s*"\s*\{([^}]*)\}"/g;
  let m;
  while ((m = re.exec(tpl))) {
    for (const part of m[1].split(',')) {
      // 支持 { row }、{ row: r } 两种写法
      const id = part.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) locals.add(id);
    }
  }
  return locals;
}

// 去掉对象字面量的键：:style="{ borderLeft:'4px', padding:'12px' }" 里的
// borderLeft/padding 是 CSS 属性名，不是业务变量，否则会大量误报
function stripObjectKeys(expr) {
  return expr.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1');
}

// 主校验：模板引用的根标识符必须能在 setup 返回值或额外允许表里找到
function assertTemplateBindings(name, mod) {
  const tpl = mod.template;
  assert.ok(typeof tpl === 'string' && tpl.length, name + ' 缺少 template');
  assert.strictEqual(typeof mod.setup, 'function', name + ' 缺少 setup()');

  const returned = mod.setup() || {};
  const keys = new Set(Object.keys(returned));
  const locals = new Set([...extractForLocals(tpl), ...extractSlotLocals(tpl)]);
  const missing = new Set();

  for (const expr of extractExpressions(tpl)) {
    for (const id of rootIdentifiers(stripObjectKeys(expr))) {
      if (RESERVED.has(id) || locals.has(id)) continue;
      if (keys.has(id)) continue;
      missing.add(id);
    }
  }
  // Element Plus 全局组件名（el-xxx 标签）不参与校验，上面只取表达式，已天然排除

  assert.strictEqual(missing.size, 0,
    name + ' 模板引用了 setup() 未暴露的变量：' + Array.from(missing).join(', '));
  return keys;
}

console.log('视图冒烟测试：');

const views = [
  ['公告栏 announcements', '../app/js/views/announcements.js'],
  ['仪表盘 dashboard', '../app/js/views/dashboard.js'],
  ['隐患管理 hazards', '../app/js/views/hazards.js'],
  ['消息催办 messages', '../app/js/views/messages.js'],
  ['用户管理 users', '../app/js/views/users.js'],
  ['部门 departments', '../app/js/views/departments.js']
];

for (const [label, path] of views) {
  await check(label + ' 可导入且模板绑定完整', async () => {
    const mod = (await import(path)).default;
    assertTemplateBindings(label, mod);
  });
}

await check('富文本编辑器 richtext 可导入且结构正确', async () => {
  const mod = (await import('../app/js/richtext.js')).default;
  assert.strictEqual(mod.name, 'RichTextEditor');
  assert.ok(mod.template.includes('contenteditable'), '应包含 contenteditable 编辑区');
  // 工具栏按钮必须用 mousedown.prevent，否则点击会抢走编辑器焦点导致选区丢失
  const btns = mod.template.match(/<button[^>]*>/g) || [];
  assert.ok(btns.length > 0, '应有工具栏按钮');
  const withoutGuard = btns.filter(b => !/mousedown\.prevent/.test(b));
  assert.strictEqual(withoutGuard.length, 0,
    '有 ' + withoutGuard.length + ' 个按钮缺少 @mousedown.prevent，会导致选区丢失');
  assert.ok(mod.template.includes(':style="{ minHeight: minHeight }"'), 'minHeight 必须绑定到编辑区');
});

await check('app.js 可导入且已注册公告栏菜单与路由', async () => {
  await import('../app/js/app.js');
  // app.js 内部直接 mount，导入成功即说明菜单/路由/viewMap 结构无误。
  // 这里通过源码文本确认公告栏已接入（模块未导出 menus，读取源文件校验）。
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
  assert.ok(src.includes("path: '/announcements'"), '菜单应包含 /announcements');
  assert.ok(src.includes("'/announcements': Announcements"), 'viewMap 应包含 /announcements');
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
