// 本地缓存：内存(Map) + localStorage 双层，用于降低云端往返、提升界面响应速度。
//
// 背景（实测数据，决定了本模块的设计）：
//   message 集合 973 条 / 1.4MB / 单次约 1.7 秒；hazards 123 条 / 191KB / 约 1.5 秒。
//   修复前仪表盘首屏会把 message 全量拉取三次（stats 内一次、api.messages 一次、
//   启动时取未读数一次），合计约 5 秒。接入本模块后同一集合在 TTL 内只发一次请求。
//
// 设计要点：
//   1. 双层：内存优先（同进程内零成本）；localStorage 持久化（重启后首屏即时渲染）
//   2. 并发去重：相同 key 的并发请求只真正发一次网络请求
//   3. SWR（stale-while-revalidate）：**仅对磁盘残留数据**先返回旧值保证冷启动即时渲染，
//      同时后台刷新并通过 onUpdate 通知界面。会话内的过期数据走阻塞刷新，
//      以保证「刷新」按钮能真正拿到新数据（否则点了刷新却还是旧值，像没生效）。
//   4. 容量保护：单条超过上限不落盘；配额不足时淘汰最旧的一半
//   5. 容错：localStorage 不可用（隐私模式/禁用）时自动降级为纯内存缓存
//
// 注意：缓存的是"集合原始数据"，筛选/分页仍在前端做，
//       因此不同参数的各种调用可以共享同一份缓存。

const NS = 'gz_cache_v1_';
const DEFAULT_TTL = 60 * 1000;

// 单条超过此大小不写入 localStorage（localStorage 是同步 API，
// 写超大值会明显阻塞主线程；且总配额通常只有 5MB）
const MAX_PERSIST_BYTES = 2 * 1024 * 1024;

const memory = new Map();   // key -> { ts, value }
const inflight = new Map(); // key -> Promise（并发去重）
const listeners = new Set();

function now() { return Date.now(); }

// localStorage 可能不存在（node 测试环境）或被禁用（隐私模式）
function ls() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    return localStorage;
  } catch (e) { return null; }
}

function lsRead(key) {
  const s = ls();
  if (!s) return null;
  try {
    const raw = s.getItem(NS + key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || typeof o.ts !== 'number') return null;
    return o;
  } catch (e) { return null; } // 数据损坏时当作未命中
}

function lsRemove(keys) {
  const s = ls();
  if (!s) return;
  for (const k of keys) {
    try { s.removeItem(k); } catch (e) { /* 忽略单个失败 */ }
  }
}

// 配额不足时淘汰最旧的一半，给新数据腾地方
function evictOldest() {
  const s = ls();
  if (!s) return;
  const entries = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(NS)) continue;
      let ts = 0;
      try {
        const o = JSON.parse(s.getItem(k));
        ts = o && typeof o.ts === 'number' ? o.ts : 0;
      } catch (e) { ts = 0; }
      entries.push({ k, ts });
    }
  } catch (e) { return; }
  entries.sort((a, b) => a.ts - b.ts);
  const half = Math.max(1, Math.floor(entries.length / 2));
  lsRemove(entries.slice(0, half).map((e) => e.k));
}

function lsWrite(key, value) {
  const s = ls();
  if (!s) return false;
  let raw;
  try {
    raw = JSON.stringify({ ts: now(), value });
  } catch (e) { return false; } // 存在循环引用等无法序列化的情况
  if (raw.length > MAX_PERSIST_BYTES) return false;
  try {
    s.setItem(NS + key, raw);
    return true;
  } catch (e) {
    // 配额不足：淘汰最旧的一半后重试一次
    evictOldest();
    try { s.setItem(NS + key, raw); return true; } catch (e2) { return false; }
  }
}

function notify(key) {
  for (const fn of Array.from(listeners)) {
    try { fn(key); } catch (e) { /* 单个订阅者报错不应影响其他订阅者 */ }
  }
}

/**
 * 取数据：命中且新鲜 → 直接返回；命中但过期 → 先返回旧值并后台刷新；未命中 → 拉取。
 * @param {string} key 缓存键（建议前缀分组，便于按前缀失效）
 * @param {() => Promise<any>} fetcher 取数函数
 * @param {{ttl?: number, persist?: boolean, force?: boolean}} opts
 * @returns {Promise<any>}
 */
export async function cached(key, fetcher, opts = {}) {
  const { ttl = DEFAULT_TTL, persist = true, force = false } = opts;

  let entry = memory.get(key);
  let fromDisk = false;
  if (!entry && persist) {
    const disk = lsRead(key);
    if (disk) {
      entry = disk;
      fromDisk = true;
      memory.set(key, entry); // 提升到内存，后续访问零成本
    }
  }

  const age = entry ? now() - entry.ts : Infinity;

  if (entry && !force && age < ttl) return entry.value;

  // SWR（先返回旧值 + 后台刷新）只用于「上一会话残留在磁盘上的数据」：
  // 这时界面能立刻有内容，是最需要它的场景（冷启动首屏）。
  //
  // 会话内（内存）的过期数据则一律阻塞刷新：否则用户点「刷新」按钮会拿到旧值，
  // 看起来像刷新没生效——这是把 SWR 无差别应用会踩的坑。
  if (entry && !force && fromDisk) {
    refresh(key, fetcher, { persist });
    return entry.value;
  }

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await fetcher();
      memory.set(key, { ts: now(), value });
      if (persist) lsWrite(key, value);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// 后台刷新：失败静默（保留旧值），成功后通知订阅者
async function refresh(key, fetcher, { persist }) {
  if (inflight.has(key)) return;
  const p = (async () => {
    try {
      const value = await fetcher();
      memory.set(key, { ts: now(), value });
      if (persist) lsWrite(key, value);
      notify(key);
    } catch (e) {
      // 后台刷新失败不影响界面：旧值仍可用，下次进入会再试
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
}

/** 后台预取：不抛错、不阻塞调用方，用于登录后预热 */
export function warm(key, fetcher, opts = {}) {
  Promise.resolve()
    .then(() => cached(key, fetcher, opts))
    .catch(() => null);
}

/** 订阅缓存更新，返回取消订阅函数 */
export function onUpdate(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * 按 key 或前缀失效。写操作后调用，避免界面看到过期数据。
 * 传入空字符串会清空全部缓存。
 */
export function invalidate(prefix) {
  for (const k of Array.from(memory.keys())) {
    if (k === prefix || k.startsWith(prefix)) memory.delete(k);
  }
  const s = ls();
  if (!s) return;
  const toRemove = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(NS)) continue;
      const bare = k.slice(NS.length);
      if (bare === prefix || bare.startsWith(prefix)) toRemove.push(k);
    }
  } catch (e) { /* 忽略 */ }
  lsRemove(toRemove);
}

/** 清空本模块写入的全部缓存（不影响其他 localStorage 数据） */
export function clear() { invalidate(''); }

/** 仅供调试/测试：返回当前内存缓存概况 */
export function stats() {
  const out = {};
  for (const [k, v] of memory.entries()) out[k] = { ageMs: now() - v.ts };
  return out;
}

/**
 * 返回匹配前缀的缓存中"最后写入时间"（毫秒时间戳），无数据返回 0。
 * 用途：界面显示"数据更新于"必须取真实取数时刻——
 * 若取自渲染时刻，冷启动读到磁盘旧数据时会把陈旧数据显示成刚更新。
 */
export function cachedAt(prefix) {
  let best = 0;
  for (const [k, v] of memory.entries()) {
    if (k === prefix || k.startsWith(prefix)) best = Math.max(best, v.ts || 0);
  }
  const s = ls();
  if (s) {
    try {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k || !k.startsWith(NS)) continue;
        const bare = k.slice(NS.length);
        if (bare !== prefix && !bare.startsWith(prefix)) continue;
        try {
          const o = JSON.parse(s.getItem(k));
          if (o && typeof o.ts === 'number') best = Math.max(best, o.ts);
        } catch (e) { /* 损坏条目跳过 */ }
      }
    } catch (e) { /* 忽略 */ }
  }
  return best;
}
