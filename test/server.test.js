// 静态服务器单元测试（CommonJS，node test/server.test.js）
// 覆盖：目录穿越防护、404、MIME 推断、默认首页、编码穿越。
const assert = require('assert');
const path = require('path');
const { handleRequest, MIME } = require('../static_server');

const ROOT = path.join(__dirname, '..', 'app');
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + ' -> ' + e.message); fail++; }
}

console.log('静态服务器边界测试：');

// 1. 正常资源：JS 正确 MIME
check('JS 文件返回 text/javascript', () => {
  const r = handleRequest(ROOT, '/js/api.js');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.contentType, 'text/javascript; charset=utf-8');
});

// 2. HTML 首页（默认 / -> index.html）
check('默认路径 / 解析为 index.html', () => {
  const r = handleRequest(ROOT, '/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.contentType, 'text/html; charset=utf-8');
});

// 3. CSS MIME
check('CSS 文件返回 text/css', () => {
  const r = handleRequest(ROOT, '/css/style.css');
  assert.strictEqual(r.contentType, 'text/css; charset=utf-8');
});

// 4. 404：不存在文件
check('不存在文件返回 404', () => {
  const r = handleRequest(ROOT, '/nope/xyz.js');
  assert.strictEqual(r.status, 404);
});

// 5. 目录穿越（明文 ..）：应 403
check('明文 ../ 目录穿越被拦截(403)', () => {
  const r = handleRequest(ROOT, '/../main.js');
  assert.strictEqual(r.status, 403);
});

// 6. 目录穿越（编码 %2e%2e）：decodeURIComponent 后应同样拦截
check('编码 %2e%2e 目录穿越被拦截(403)', () => {
  const r = handleRequest(ROOT, '/%2e%2e/%2e%2e/main.js');
  assert.strictEqual(r.status, 403);
});

// 7. 编码穿越尝试逃逸到系统文件（绝对路径不应被允许）
check('尝试逃逸到 /etc/passwd 被拦截', () => {
  // path.normalize(path.join(ROOT, '/../../../../etc/passwd')) 仍会被 startsWith(ROOT) 拒掉
  const r = handleRequest(ROOT, '/../../../../etc/passwd');
  assert.strictEqual(r.status, 403);
});

// 8. 子目录正常资源（vendor 本地依赖）
check('vendor 本地依赖可访问(200)', () => {
  const r = handleRequest(ROOT, '/vendor/vue.global.prod.js');
  assert.strictEqual(r.status, 200);
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
