// 本地缓存模块单测（node test/cache.test.mjs）
// 覆盖：TTL 命中/过期、并发去重、SWR 先旧后新、按前缀失效、
//       容量保护（超大值不落盘）、配额不足淘汰、订阅通知、
//       localStorage 不可用时降级为纯内存。
import assert from 'assert';

// ---- mock 浏览器全局（必须在 import cache 之前设置） ----
const _ls = {};
let quotaFull = false; // 手动制造配额不足场景
global.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => {
    if (quotaFull) {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    _ls[k] = String(v);
  },
  removeItem: (k) => { delete _ls[k]; },
  get length() { return Object.keys(_ls).length; },
  key: (i) => Object.keys(_ls)[i] || null
};

// 可控时钟：缓存按 Date.now() 判断过期，用假时钟精确控制，避免依赖真实 sleep
let clock = 1000000;
const realDateNow = Date.now;
Date.now = () => clock;

const cache = await import('../app/js/cache.js');
const { cached, invalidate, clear, onUpdate, warm, stats } = cache;

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  \u2713 ' + name); pass++; })
    .catch((e) => { console.log('  \u2717 ' + name + ' -> ' + e.message); fail++; });
}
function clearAll() {
  clear();
  for (const k of Object.keys(_ls)) delete _ls[k];
}

console.log('本地缓存模块测试：');

await check('TTL 内命中：第二次调用不再请求网络', async () => {
  clearAll();
  let calls = 0;
  const fetcher = async () => { calls += 1; return [{ id: 1 }]; };
  const a = await cached('k1', fetcher, { ttl: 1000 });
  const b = await cached('k1', fetcher, { ttl: 1000 });
  assert.strictEqual(calls, 1, 'fetcher 只应被调用一次，实际 ' + calls);
  assert.deepStrictEqual(a, b);
});

await check('TTL 过期后（会话内）阻塞刷新，保证拿到新值', async () => {
  clearAll();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 'v' + calls; };
  assert.strictEqual(await cached('k2', fetcher, { ttl: 1000 }), 'v1');
  clock += 2000; // 推进到过期之后
  // 内存中的过期数据走阻塞刷新：点「刷新」按钮时必须拿到新值，
  // 否则会看起来像刷新没生效（SWR 只用于磁盘残留数据的冷启动场景）
  assert.strictEqual(await cached('k2', fetcher, { ttl: 1000 }), 'v2');
  assert.strictEqual(calls, 2);
});

await check('并发去重：同一 key 的并发请求只发一次网络请求', async () => {
  clearAll();
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20)); // 模拟网络耗时
    return 'shared';
  };
  const [a, b, c] = await Promise.all([
    cached('k3', fetcher, { ttl: 1000 }),
    cached('k3', fetcher, { ttl: 1000 }),
    cached('k3', fetcher, { ttl: 1000 })
  ]);
  assert.strictEqual(calls, 1, '三个并发请求应共用一次网络请求，实际 ' + calls);
  assert.deepStrictEqual([a, b, c], ['shared', 'shared', 'shared']);
});

// 模拟"上一次会话残留在磁盘上的数据"：绕过模块直接写入 localStorage
function seedDisk(key, value, ageMs) {
  _ls['gz_cache_v1_' + key] = JSON.stringify({ ts: clock - ageMs, value });
}

await check('SWR：冷启动读到过期磁盘数据时先返回旧值，再后台刷新', async () => {
  clearAll();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 'v' + calls; };
  // 磁盘上有 5 秒前的旧数据（TTL 仅 1 秒，已过期），模拟冷启动
  seedDisk('k4', 'disk-old', 5000);
  // 立即返回旧值（不等网络），保证首屏立刻有内容
  assert.strictEqual(await cached('k4', fetcher, { ttl: 1000 }), 'disk-old');
  // 等后台刷新完成后应拿到新值
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls, 1, '应触发一次后台刷新');
  assert.strictEqual(await cached('k4', fetcher, { ttl: 1000 }), 'v1');
});

await check('SWR 后台刷新会通知订阅者', async () => {
  clearAll();
  const notified = [];
  const off = onUpdate((k) => notified.push(k));
  seedDisk('k5', 'disk-old', 5000);
  await cached('k5', async () => 'data', { ttl: 1000 }); // 触发后台刷新
  await new Promise((r) => setTimeout(r, 20));
  off();
  assert.deepStrictEqual(notified, ['k5'], '订阅者应收到一次通知');
});

await check('未过期的磁盘数据直接命中，不触发后台刷新', async () => {
  clearAll();
  let calls = 0;
  seedDisk('k15', 'fresh-disk', 100); // 仅 100ms，远小于 TTL
  const v = await cached('k15', async () => { calls += 1; return 'new'; }, { ttl: 10000 });
  assert.strictEqual(v, 'fresh-disk');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls, 0, '未过期不应发起请求');
});

await check('force:true 强制绕过缓存', async () => {
  clearAll();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 'v' + calls; };
  await cached('k6', fetcher, { ttl: 100000 });
  await cached('k6', fetcher, { ttl: 100000, force: true });
  assert.strictEqual(calls, 2, 'force 应强制重新请求');
});

await check('invalidate 按前缀失效，不影响其他分组', async () => {
  clearAll();
  let hz = 0, us = 0;
  await cached('col:hazards:{}', async () => { hz += 1; return []; }, { ttl: 100000 });
  await cached('col:users:{}', async () => { us += 1; return []; }, { ttl: 100000 });
  await cached('col:hazards:{}', async () => { hz += 1; return []; }, { ttl: 100000 });
  assert.strictEqual(hz, 1);
  invalidate('col:hazards');
  await cached('col:hazards:{}', async () => { hz += 1; return []; }, { ttl: 100000 });
  await cached('col:users:{}', async () => { us += 1; return []; }, { ttl: 100000 });
  assert.strictEqual(hz, 2, 'hazards 失效后应重新请求');
  assert.strictEqual(us, 1, 'users 不应受影响');
});

await check('invalidate 同时清理内存与 localStorage', async () => {
  clearAll();
  await cached('k8', async () => 'x', { ttl: 100000 });
  assert.ok(Object.keys(_ls).some((k) => k.endsWith('k8')), '应已写入 localStorage');
  invalidate('k8');
  assert.ok(!Object.keys(_ls).some((k) => k.endsWith('k8')), 'localStorage 也应被清除');
  assert.ok(!stats().k8, '内存缓存也应被清除');
});

await check('localStorage 持久化：磁盘上的新鲜数据可直接恢复，无需请求', async () => {
  clearAll();
  let calls = 0;
  seedDisk('k9', 'persisted', 100); // 磁盘上有 100ms 前的数据，远未过期
  // 模拟页面刷新后重新读取：内存为空，应从磁盘恢复
  const v = await cached('k9', async () => { calls += 1; return 'from-network'; }, { ttl: 100000 });
  assert.strictEqual(v, 'persisted', '应恢复磁盘数据');
  assert.strictEqual(calls, 0, '不应发起网络请求');
});

await check('persist:false 不写入 localStorage（但仍在内存中缓存）', async () => {
  clearAll();
  let calls = 0;
  const fetcher = async () => { calls += 1; return 'secret'; };
  await cached('k10', fetcher, { ttl: 100000, persist: false });
  await cached('k10', fetcher, { ttl: 100000, persist: false });
  assert.strictEqual(calls, 1, '内存缓存应生效');
  assert.ok(!Object.keys(_ls).some((k) => k.endsWith('k10')), '不应写入 localStorage');
});

await check('超大值不落盘，避免阻塞主线程与撑爆配额', async () => {
  clearAll();
  const big = 'x'.repeat(2 * 1024 * 1024 + 10); // 超过 2MB 上限
  await cached('k11', async () => big, { ttl: 100000 });
  assert.ok(!Object.keys(_ls).some((k) => k.endsWith('k11')), '超大值不应持久化');
  // 内存缓存仍然可用
  let calls = 0;
  await cached('k11', async () => { calls += 1; return 'y'; }, { ttl: 100000 });
  assert.strictEqual(calls, 0, '内存中的超大值应可被复用');
});

await check('配额不足时淘汰最旧数据且不抛错', async () => {
  clearAll();
  await cached('old1', async () => 'a', { ttl: 100000 });
  clock += 10;
  await cached('old2', async () => 'b', { ttl: 100000 });
  clock += 10;
  quotaFull = true;
  // 触发写入：配额不足应走淘汰逻辑并静默失败，不向上抛出
  await assert.doesNotReject(() => cached('new1', async () => 'c', { ttl: 100000 }));
  quotaFull = false;
  const keys = Object.keys(_ls);
  assert.ok(keys.some((k) => k.endsWith('old1')) === false || keys.some((k) => k.endsWith('old2')) === false,
    '应至少淘汰掉一部分旧数据');
});

await check('localStorage 不可用时降级为纯内存缓存（不崩溃）', async () => {
  clearAll();
  const saved = global.localStorage;
  global.localStorage = undefined; // 模拟隐私模式/禁用存储
  try {
    let calls = 0;
    const fetcher = async () => { calls += 1; return 'mem'; };
    assert.strictEqual(await cached('k12', fetcher, { ttl: 100000 }), 'mem');
    assert.strictEqual(await cached('k12', fetcher, { ttl: 100000 }), 'mem');
    assert.strictEqual(calls, 1, '无 localStorage 时内存缓存仍应生效');
    await assert.doesNotReject(async () => { invalidate('k12'); });
  } finally {
    global.localStorage = saved;
  }
});

await check('损坏的 localStorage 数据被当作未命中（不崩溃）', async () => {
  clearAll();
  _ls['gz_cache_v1_broken'] = '{不是合法JSON';
  let calls = 0;
  const v = await cached('broken', async () => { calls += 1; return 'fresh'; }, { ttl: 100000 });
  assert.strictEqual(v, 'fresh');
  assert.strictEqual(calls, 1);
});

await check('warm 后台预取：失败静默，不抛出', async () => {
  clearAll();
  // warm 是"发射后不管"的接口，本身不返回 Promise，失败必须内部消化
  warm('k13', async () => { throw new Error('网络错误'); });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!stats().k13, '预取失败不应写入缓存');
});

await check('后台刷新失败时保留旧值，且不产生未处理的 Promise 拒绝', async () => {
  clearAll();
  // 后台刷新的 Promise 无人 await，若内部未消化错误会变成 unhandledRejection，
  // 在 Electron 里会弹出错误提示——这是必须验证的点
  const unhandled = [];
  const onUnhandled = (r) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    seedDisk('k14', 'disk-old', 5000); // 过期磁盘数据
    const v = await cached('k14', async () => { throw new Error('刷新失败'); }, { ttl: 1000 });
    assert.strictEqual(v, 'disk-old', '应先用旧值渲染，不受后台失败影响');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(unhandled, [], '后台刷新失败不应产生未处理的拒绝');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  // 注：旧值被提升到内存后，再次调用会走"会话内过期→阻塞刷新"路径并正常抛出错误，
  // 这是期望行为（用户主动刷新时，网络错误应当可见）。
});

// 恢复真实时钟，避免影响同进程后续逻辑
Date.now = realDateNow;

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
