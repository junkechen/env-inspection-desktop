// 前端 api.js 逻辑单元测试（ESM，node test/api.test.mjs）
// 通过 mock 浏览器全局（window/localStorage/fetch/AbortController）隔离网络，
// 覆盖：分页切片、消息 read 筛选、批量标记已读(updateMany)、请求超时/网络异常、非约定结构。

import assert from 'assert';

// ---- mock 浏览器全局（必须在 import api 之前设置） ----
global.window = { __API_BASE__: 'http://mockgw/api' };
const _ls = {};
// 补全 length/key，缓存模块的失效与淘汰逻辑依赖这两个 API
global.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
  get length() { return Object.keys(_ls).length; },
  key: (i) => Object.keys(_ls)[i] || null
};
let fetchImpl;
global.fetch = (...args) => fetchImpl(...args);

const mod = await import('../app/js/api.js');
const api = mod.api;
const { clear: clearCache } = await import('../app/js/cache.js');

let pass = 0, fail = 0;
function check(name, fn) {
  // 接入本地缓存后各用例必须相互隔离：否则前一个用例缓存的数据会被后一个用例命中，
  // 导致本用例 mock 的 fetch 根本没被调用（例如期望抛超时/网络错误却直接返回了旧数据）。
  clearCache();
  return fn().then(() => { console.log('  \u2713 ' + name); pass++; })
    .catch((e) => { console.log('  \u2717 ' + name + ' -> ' + e.message); fail++; });
}

// 统一：fetch 返回约定的 {code:0,data}
function mockData(data) {
  fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ code: 0, data }) });
}

console.log('前端 api.js 逻辑测试：');

await check('users 分页切片 page=2 size=10 取第 11-20 条', async () => {
  const users = Array.from({ length: 25 }, (_, i) => ({ _id: 'u' + i, name: String.fromCharCode(65 + i), username: 'un' + i, status: 'active' }));
  mockData(users);
  const r = await api.users({ page: 2, size: 10 });
  assert.strictEqual(r.total, 25);
  assert.strictEqual(r.list.length, 10);
  assert.strictEqual(r.list[0].name, 'K'); // 排序后第11个（索引10）为 'K'
});

await check('users 无 size 时返回全部', async () => {
  const users = Array.from({ length: 5 }, (_, i) => ({ _id: 'u' + i, name: '用户' + i, status: 'active' }));
  mockData(users);
  const r = await api.users({});
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.list.length, 5);
});

await check('users 过滤已删除账号', async () => {
  const users = [
    { _id: '1', name: 'A', status: 'active' },
    { _id: '2', name: 'B', status: 'deleted' }
  ];
  mockData(users);
  const r = await api.users({});
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.list[0].name, 'A');
});

await check('messages read=false 仅返回未读', async () => {
  const msgs = [
    { _id: '1', isRead: true },
    { _id: '2', isRead: false },
    { _id: '3', isRead: false }
  ];
  mockData(msgs);
  const r = await api.messages({ read: 'false' });
  assert.strictEqual(r.list.length, 2);
  assert.strictEqual(r.unread, 2);
});

await check('messages read=true 仅返回已读', async () => {
  const msgs = [
    { _id: '1', isRead: true },
    { _id: '2', isRead: false },
    { _id: '3', isRead: false }
  ];
  mockData(msgs);
  const r = await api.messages({ read: 'true' });
  assert.strictEqual(r.list.length, 1);
});

await check('readAllMessages 优先使用 updateMany 一次批量标记（含 $in）', async () => {
  let captured = null;
  fetchImpl = (url, opts) => { captured = JSON.parse(opts.body); return Promise.resolve({ ok: true, json: async () => ({ code: 0 }) }); };
  await api.readAllMessages(['a', 'b', 'c']);
  assert.strictEqual(captured.action, 'updateMany');
  assert.deepStrictEqual(captured.query._id.$in, ['a', 'b', 'c']);
  assert.strictEqual(captured.data.isRead, true);
});

await check('readAllMessages 云端不支持 updateMany 时降级为逐条 update', async () => {
  const calls = [];
  fetchImpl = (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.action === 'updateMany') return Promise.resolve({ ok: true, json: async () => ({ code: -1, message: '未知操作: updateMany' }) });
    return Promise.resolve({ ok: true, json: async () => ({ code: 0 }) });
  };
  await api.readAllMessages(['x', 'y']);
  assert.ok(calls.some(c => c.action === 'updateMany'), '应先尝试 updateMany');
  assert.ok(calls.filter(c => c.action === 'update').length >= 2, '失败后应逐条 update');
});

await check('readAllMessages 空数组不发起请求', async () => {
  let called = false;
  fetchImpl = () => { called = true; return Promise.resolve({ ok: true, json: async () => ({ code: 0 }) }); };
  await api.readAllMessages([]);
  assert.strictEqual(called, false);
});

await check('rpc 遇到 AbortError（超时）抛出“请求超时”', async () => {
  fetchImpl = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await assert.rejects(() => api.users({}), /请求超时/);
});

await check('rpc 遇到网络错误抛出“网络请求失败”', async () => {
  fetchImpl = () => Promise.reject(new TypeError('network down'));
  await assert.rejects(() => api.users({}), /网络请求失败/);
});

await check('rpc 返回无 code 的非约定结构视为失败', async () => {
  fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ foo: 'bar' }) });
  await assert.rejects(() => api.users({}), /请求失败/);
});

await check('rpc 返回 code!=0 抛出服务器 message', async () => {
  fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ code: -1, message: '用户名或密码错误' }) });
  await assert.rejects(() => api.login('x', 'y'), /用户名或密码错误/);
});

await check('rpc HTTP 非 200 视为失败', async () => {
  fetchImpl = () => Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(() => api.users({}), /请求失败/);
});

await check('stats 返回趋势/环比/同比/预警/等级/车间/类型/重复位置', async () => {
  const now = Date.now();
  const iso = (off) => new Date(now - off * 86400000).toISOString();
  fetchImpl = (url, opts) => {
    const body = JSON.parse(opts.body);
    const collection = body.collection;
    if (collection === 'hazards') {
      return Promise.resolve({ ok: true, json: async () => ({ code: 0, data: [
        { _id: 'h1', status: 'pending', severity: 'critical', category: 'wastewater', department: 'A', location: 'L1', createdAt: iso(1), dueDate: iso(-1) },
        { _id: 'h2', status: 'closed', severity: 'general', category: 'wastegas', department: 'A', location: 'L1', createdAt: iso(8), closedAt: iso(1) },
        { _id: 'h3', status: 'processing', severity: 'serious', category: 'noise', department: 'B', location: 'L2', createdAt: iso(35), dueDate: iso(10) }
      ]}) });
    }
    if (collection === 'users') return Promise.resolve({ ok: true, json: async () => ({ code: 0, data: [{ _id: 'u1', name: 'A', status: 'active' }] }) });
    if (collection === 'message') return Promise.resolve({ ok: true, json: async () => ({ code: 0, data: [] }) });
    return Promise.resolve({ ok: true, json: async () => ({ code: 0, data: [] }) });
  };
  const r = await api.stats();
  assert.strictEqual(r.counts.total, 3);
  assert.strictEqual(r.counts.pending, 1);
  assert.strictEqual(r.counts.closed, 1);
  assert.strictEqual(r.counts.overdue, 1);
  assert.strictEqual(r.bySeverity.critical, 1);
  assert.ok(Array.isArray(r.byDepartmentDetail) && r.byDepartmentDetail.length === 2);
  assert.ok(r.byDepartmentDetail.find(d => d.name === 'A').total === 2);
  assert.ok(Array.isArray(r.byCategory) && r.byCategory.length === 3);
  assert.ok(Array.isArray(r.repeatLocations) && r.repeatLocations[0].name === 'L1' && r.repeatLocations[0].value === 2);
  assert.strictEqual(r.trend.length, 30);
  assert.ok(r.comparison.mom !== undefined);
  assert.ok(r.alerts.length > 0);
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
