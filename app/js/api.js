// API 封装：统一对接腾讯云 CloudBase 云函数 HTTP 网关（与 APP 同源共享数据）
//
// 协议：POST 单端点，body = { action, collection?, query?, data? }
// 返回：{ code: 0, data?: [...], user?: {...}, message? }
// 请求必须带 X-TCB-Env 头，否则云函数报 INVALID_ENV。
//
// 注意：云函数 query 接口当前为公开（无需登录即可读取，含 users 明文密码），
// 生产环境请在云函数侧加鉴权，并在网关开启 CORS（Access-Control-Allow-Origin）。
import { computeStats } from './stats_utils.js';
import { cached, invalidate, warm } from './cache.js';
import {
  DOC_TYPE, STATUS, normalize, sortAnnouncements, filterAnnouncements,
  collectExpiredForArchive, readStats
} from './announcement.js';

const GW = (window.__API_BASE__) ||
  'https://anuanbu1-1-6gjqaydwd067dbb1-1421679372.ap-shanghai.app.tcloudbase.com/api';
export const ENV = 'anuanbu1-1-6gjqaydwd067dbb1';

// 公告集合名（需在 CloudBase 控制台预先创建）
const ANN_COL = 'announcement';

// 请求超时（毫秒）：弱网/网关卡死时避免 UI 永久 loading
const REQUEST_TIMEOUT = 20000;

const TOKEN_KEY = 'gz_token';
const USER_KEY = 'gz_user';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
export function getStoredUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
}

// 底层 RPC：调用云函数某个 action
// 带超时控制；统一把非约定结构（缺 code 或 code!=0）转换为可读错误。
export async function rpc(action, { collection, query, data } = {}) {
  const body = { action };
  if (collection) body.collection = collection;
  if (query) body.query = query;
  if (data) body.data = data;

  const headers = { 'Content-Type': 'application/json', 'X-TCB-Env': ENV };
  const tk = getToken();
  if (tk) headers['Authorization'] = 'Bearer ' + tk;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch(GW, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络或稍后重试');
    throw new Error('网络请求失败：' + (e && e.message ? e.message : '未知错误'));
  }
  clearTimeout(timer);

  let json = {};
  try { json = await res.json(); } catch (e) { /* 返回非 JSON（如网关 502 文本） */ }

  // 约定：成功必须显式 code===0；缺 code 也视为失败，避免静默拿到非约定结构
  if (!res.ok || json.code === undefined || json.code !== 0) {
    throw new Error(json.message || ('请求失败(' + res.status + ')'));
  }
  return json;
}

// 角色 / 状态 中文映射（与 APP 枚举保持一致）
export const ROLE_MAP = {
  admin: '管理员', inspector: '检查员', rectifier: '整改负责人',
  supervisor: '督查员', viewer: '只读查看员'
};
export const STATUS_MAP = {
  active: '正常', disabled: '禁用',
  pending: '待处理', processing: '整改中', reviewing: '待验收', closed: '已关闭', deleted: '已删除'
};
export const CATEGORY_MAP = {
  wastewater: '废水排放', wastegas: '废气排放', solidWaste: '固废管理', noise: '噪音污染', other: '其他'
};
export const SEVERITY_MAP = {
  general: '一般', serious: '较重', critical: '严重'
};

function fmt(v) { return v == null ? '' : String(v); }

// 前端分页切片：返回当前页数据 + 总数；page/size 缺失时返回全部
function paginate(list, page, size) {
  const total = list.length;
  const p = Number(page) || 1;
  const s = Number(size) || 0;
  if (!s || s <= 0) return { list, total };
  const start = (p - 1) * s;
  return { list: list.slice(start, start + s), total };
}

// ---------- 本地缓存 ----------
// 各集合缓存时长，按"数据多久可能变一次"设定：
//   用户/部门极少变动 → 较长 TTL；隐患/消息变动较频繁 → 较短 TTL。
const COLLECTION_TTL = {
  hazards: 60 * 1000,
  users: 5 * 60 * 1000,
  departments: 10 * 60 * 1000,
  message: 60 * 1000,
  announcement: 60 * 1000
};

// 是否写入 localStorage（仅内存缓存则刷新页面即失效）。
// users 设为 false 是安全考虑：云端 query 会返回明文密码（见文件头注释），
// 若持久化到磁盘，等同于把凭据明文留在本地。users 仅 51KB / 约 340ms，
// 只做内存缓存已能覆盖主要收益（同一次会话内多处共享）。
const COLLECTION_PERSIST = {
  users: false
};

// 稳定序列化：保证"内容相同但键顺序不同"的查询生成同一个缓存键。
// 注意不能用 JSON.stringify 的 replacer 数组，它会把嵌套键（如 $in）一并过滤掉。
function stableKey(query) {
  if (!query || typeof query !== 'object') return '{}';
  const walk = (v) => {
    if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + walk(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  };
  return walk(query);
}

// 集合缓存键：集合名 + 稳定序列化后的查询条件
import { currentDept } from './dept.js';

/**
 * 缓存键 —— 必须带科室维度。
 *
 * 原实现是 'col:' + collection + ':' + stableKey(query)。隐患查询恰好是空 query
 * （pc 端 queryCollection('hazards') 全量拉取），于是键恒为 'col:hazards:{}'，
 * 且 TTL 60s + localStorage 持久化。**加上科室切换后，两个科室会共用同一条缓存**：
 * 环保用户切到安全科，60 秒内看到的仍是环保的旧数据，关掉软件重开也一样。
 *
 * 这类"看起来隔离了、实际是脏数据"的问题极难排查 —— 服务端返回正确、
 * 前端代码也没写错，但屏幕上就是另一个科室的数据。所以缓存键从最底层就带上科室。
 */
function collectionKey(collection, query) {
  return 'col:' + currentDept() + ':' + collection + ':' + stableKey(query);
}

/** 某集合在当前科室下的缓存前缀（失效/取更新时间用） */
export function cachePrefix(collection) {
  return 'col:' + currentDept() + ':' + (collection || '');
}

// 统一查询入口：同一集合 + 同一查询在 TTL 内只发一次网络请求。
// 这是本次提速的关键——修复前仪表盘首屏会把 message（1.4MB / 约 1.7 秒）
// 全量拉取三次（stats 内一次、api.messages 一次、启动取未读数一次），
// 三者拿的其实是同一份数据；现在它们共享同一份缓存。
function queryCollection(collection, query = {}, opts = {}) {
  return cached(collectionKey(collection, query), async () => {
    const r = await rpc('query', { collection, query });
    return r.data || [];
  }, Object.assign({
    ttl: COLLECTION_TTL[collection] || 60000,
    persist: COLLECTION_PERSIST[collection] !== false
  }, opts));
}

// 公告集合未创建时，云端 add 返回 -10「添加失败，未返回ID」。
// 这个原始提示对使用者毫无指引，这里翻译成可执行的排查建议。
function annAddHint(e) {
  const msg = (e && e.message) || '';
  if (/未返回ID|添加失败/.test(msg)) {
    return new Error('保存失败：云端 announcement 集合尚未创建。请管理员在腾讯云 CloudBase 控制台 → 数据库中新建 announcement 集合后重试。');
  }
  return e;
}

export const api = {
  // ---------- 认证 ----------
  login: async (username, password) => {
    // 云端 login action 同时支持按 username 或 name 匹配，
    // 这里两个都带上，用户输账号或姓名都能登录。
    const r = await rpc('login', { query: { username, name: username, password } });
    return { token: 'cb_' + Date.now(), user: r.user };
  },
  me: () => getStoredUser(),

  // ---------- 用户 ----------
  users: async (params = {}) => {
    const all = await queryCollection('users');
    let list = all.filter(u => u.status !== 'deleted');
    // 状态筛选（active/pending/disabled）；此前漏了这段，下拉选什么都返回全部
    if (params.status && params.status !== 'all') {
      list = list.filter(u => (u.status || 'active') === params.status);
    }
    const kw = (params.keyword || '').trim();
    if (kw) {
      list = list.filter(u =>
        fmt(u.name).includes(kw) || fmt(u.username).includes(kw) || fmt(u.phone).includes(kw) || fmt(u.department).includes(kw));
    }
    // 按姓名拼音/字母排序
    list = [...list].sort((a, b) => fmt(a.name).localeCompare(fmt(b.name), 'zh'));
    return paginate(list, params.page, params.size);
  },
  // 写操作后失效对应集合的缓存，否则界面会继续显示改前的数据
  createUser: async (u) => {
    const r = await rpc('add', { collection: 'users', data: u });
    invalidate(cachePrefix('users'));
    return r;
  },
  updateUser: async (id, u) => {
    const r = await rpc('update', { collection: 'users', query: { _id: id }, data: u });
    invalidate(cachePrefix('users'));
    return r;
  },
  deleteUser: async (id) => {
    // 软删除：云端无 delete action，标记 status='deleted'（列表已过滤该状态），
    // 之前误写为 'disabled'，界面上看起来只是「禁用」而不是删除。
    // 同时置 isActive=false 并随机化密码，防止该账号再从 APP 端登录。
    const r = await rpc('update', { collection: 'users', query: { _id: id }, data: { status: 'deleted', isDeleted: true, isActive: false, password: 'Deleted_' + Date.now() } });
    invalidate(cachePrefix('users'));
    return r;
  },
  resetPassword: async (id) => {
    const r = await rpc('update', { collection: 'users', query: { _id: id }, data: { password: '123456' } });
    invalidate(cachePrefix('users'));
    return r;
  },

  // ---------- 部门 ----------
  departments: async () => {
    const all = await queryCollection('departments');
    return all.filter(d => !d.isDeleted);
  },
  createDept: async (d) => {
    const r = await rpc('add', { collection: 'departments', data: d });
    invalidate(cachePrefix('departments'));
    return r;
  },
  updateDept: async (id, d) => {
    const r = await rpc('update', { collection: 'departments', query: { _id: id }, data: d });
    invalidate(cachePrefix('departments'));
    return r;
  },
  deleteDept: async (id) => {
    const r = await rpc('update', { collection: 'departments', query: { _id: id }, data: { isDeleted: true } });
    invalidate(cachePrefix('departments'));
    return r;
  },

  // ---------- 隐患 ----------
  hazards: async (params = {}) => {
    // 注：云函数 query 已确认支持 $ne；这里仍在前端过滤 isDeleted 兼容脏数据
    const all = await queryCollection('hazards');
    const kw = (params.keyword || '').trim();
    let list = all.filter((h) => {
      if (h.status === 'deleted' || h.isDeleted) return false;
      if (params.status && params.status !== 'all' && h.status !== params.status) return false;
      if (params.department && h.department !== params.department) return false;
      if (params.category && h.category !== params.category) return false;
      if (params.severity && h.severity !== params.severity) return false;
      if (kw && !(fmt(h.title).includes(kw) || fmt(h.description).includes(kw) || fmt(h.location).includes(kw) ||
        fmt(h.department).includes(kw) || fmt(h.assigneeName).includes(kw))) return false;
      return true;
    });
    // 默认按创建时间倒序
    list = [...list].sort((a, b) => fmt(b.createdAt).localeCompare(fmt(a.createdAt)));
    return paginate(list, params.page, params.size);
  },
  createHazard: async (h) => {
    const r = await rpc('add', { collection: 'hazards', data: h });
    invalidate(cachePrefix('hazards'));
    return r;
  },
  updateHazard: async (id, h) => {
    const r = await rpc('update', { collection: 'hazards', query: { _id: id }, data: h });
    invalidate(cachePrefix('hazards'));
    return r;
  },
  // 详情直接命中已缓存的集合，避免为单条数据再发一次网络请求
  getHazard: async (id) => {
    const all = await queryCollection('hazards');
    return all.find((h) => String(h._id) === String(id)) || null;
  },
  remindHazard: async (id, content) => {
    const r = await rpc('sendReminder', { data: { issueId: id, content } });
    // 催办会新增消息，消息列表需刷新
    invalidate(cachePrefix('message'));
    return r;
  },

  // ---------- 消息 ----------
  // 云端集合名是 message（单数，实测 908 条），APP 用的也是它。
  // 此前误写为 messages（复数，实为 0 条空集合），导致消息列表全空。
  // 未读字段是 isRead(boolean)，不是 read/status。
  messages: async (params = {}) => {
    const all = await queryCollection('message');
    let list = all.slice();
    if (params.read === 'false' || params.read === false) {
      list = list.filter(m => m.isRead !== true);
    } else if (params.read === 'true' || params.read === true) {
      list = list.filter(m => m.isRead === true);
    }
    list = list.sort((a, b) => fmt(b.createdAt || b._createTime).localeCompare(fmt(a.createdAt || a._createTime)));
    const unread = all.filter(m => m.isRead === false).length;
    return Object.assign(paginate(list, params.page, params.size), { unread });
  },
  readMessage: async (id) => {
    const r = await rpc('update', { collection: 'message', query: { _id: id }, data: { isRead: true } });
    invalidate(cachePrefix('message'));
    return r;
  },
  readAllMessages: async (ids, onProgress) => {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return true;
    // 优先尝试云端 updateMany（一次改多条）；若云端未部署则降级为逐条 update
    try {
      await rpc('updateMany', { collection: 'message', query: { _id: { $in: list } }, data: { isRead: true } });
      invalidate(cachePrefix('message'));
      return true;
    } catch (e) {
      if (e && e.message && /unknown|未知|updateMany/i.test(e.message)) {
        // 降级：10 条并发逐条更新，避免一次发 700+ 请求把窗口卡死
        const batch = 10;
        for (let i = 0; i < list.length; i += batch) {
          const chunk = list.slice(i, i + batch);
          await Promise.all(chunk.map(id =>
            rpc('update', { collection: 'message', query: { _id: id }, data: { isRead: true } }).catch(() => null)
          ));
          if (typeof onProgress === 'function') onProgress(Math.min(i + batch, list.length), list.length);
        }
        invalidate(cachePrefix('message'));
        return true;
      }
      throw e;
    }
  },

  // ---------- 统计 ----------
  // 云函数无 stats action，前端计算；聚合逻辑在 stats_utils.computeStats。
  // 三个集合查询全部走缓存，与列表页/启动未读数共享同一份数据，
  // 因此仪表盘不会重复拉取（修复前 message 会被重复拉取三次）。
  stats: async () => {
    const [hazardsAll, usersAll, messages] = await Promise.all([
      queryCollection('hazards'),
      queryCollection('users'),
      queryCollection('message')
    ]);
    const hazards = hazardsAll.filter((h) => h.status !== 'deleted' && !h.isDeleted);
    const users = usersAll.filter(u => u.status !== 'deleted');

    const s = computeStats(hazards);

    return {
      ...s,
      unreadMessages: messages.filter(m => m.isRead === false).length,
      userCount: users.length
    };
  },

  // ---------- 公告 ----------
  // 存储说明（实测约束，勿改）：
  //  · 单集合 announcement，docType 区分 announcement / read / audit，
  //    这样只需在控制台建 1 个集合即可，不必再建「已读表」「日志表」。
  //  · 集合必须先在 CloudBase 控制台创建，否则 add 返回 -10「添加失败，未返回ID」。
  //  · 云端无 remove 动作 → 删除一律软删除（isDeleted）。
  //  · 云端无 updateMany → 批量只能逐条。
  //  · query 支持服务端字段过滤与 $in（已实测）→ 按 docType 过滤，避免把基数更大的
  //    read/audit 文档一起拉回来。
  announcements: async (params = {}) => {
    const all = await queryCollection(ANN_COL, { docType: DOC_TYPE.ANN });
    let list = all.filter((a) => a.isDeleted !== true).map(normalize);
    list = sortAnnouncements(filterAnnouncements(list, params, Date.now()));
    return paginate(list, params.page, params.size);
  },
  getAnnouncement: async (id) => {
    const all = await queryCollection(ANN_COL, { docType: DOC_TYPE.ANN });
    const d = all.find((x) => String(x._id) === String(id));
    return d ? normalize(d) : null;
  },
  createAnnouncement: async (a) => {
    let r;
    try {
      r = await rpc('add', { collection: ANN_COL, data: Object.assign({ docType: DOC_TYPE.ANN }, a) });
    } catch (e) {
      throw annAddHint(e);
    }
    invalidate(cachePrefix(ANN_COL));
    // 云端 add 通常不回传 _id（实测该云函数如此），能拿到就返回，拿不到返回空串，
    // 由调用方决定是否需要补写关联数据（如审计日志）。
    const d = r && r.data;
    return String((r && (r.id || r._id || r.insertedId)) || (d && (d.id || d._id || d.insertedId)) || '');
  },
  updateAnnouncement: async (id, a) => {
    const r = await rpc('update', { collection: ANN_COL, query: { _id: id }, data: a });
    invalidate(cachePrefix(ANN_COL));
    return r;
  },
  // 软删除：云端无 remove 动作，只能置标记
  deleteAnnouncement: async (id, who) => {
    const r = await rpc('update', {
      collection: ANN_COL, query: { _id: id },
      data: { isDeleted: true, deletedAt: new Date().toISOString(), deletedBy: who || '' }
    });
    invalidate(cachePrefix(ANN_COL));
    return r;
  },

  // 已读：一条 (公告, 用户) 对应一个 read 文档。
  // 相比在公告文档上维护 readBy 数组，这里用「新增文档」而非「读改写」，
  // 避免多人同时阅读时互相覆盖导致已读丢失。
  announcementReads: async (ids) => {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return [];
    const r = await rpc('query', { collection: ANN_COL, query: { docType: DOC_TYPE.READ, announcementId: { $in: list } } });
    return r.data || [];
  },
  markAnnouncementRead: async (id, user) => {
    const uid = user ? String(user._id || user.id || user.username || '') : '';
    if (!uid) return false;
    const r = await rpc('query', { collection: ANN_COL, query: { docType: DOC_TYPE.READ, announcementId: id, userId: uid } });
    if ((r.data || []).length) return false; // 已读过则不重复计数
    try {
      await rpc('add', {
        collection: ANN_COL,
        data: {
          docType: DOC_TYPE.READ, announcementId: id, userId: uid,
          userName: (user && (user.name || user.username)) || '',
          readAt: new Date().toISOString()
        }
      });
    } catch (e) { throw annAddHint(e); }
    return true;
  },
  // 批量统计：一次 $in 查询取回这批公告的全部已读文档，再本地聚合出阅读量与本人已读
  announcementStats: async (ids, user) => {
    const reads = await api.announcementReads(ids);
    const uid = user ? String(user._id || user.id || user.username || '') : '';
    const map = {};
    (Array.isArray(ids) ? ids : []).forEach((id) => { map[id] = readStats(reads, id, uid); });
    return map;
  },

  // 审计日志
  announcementAudits: async (announcementId) => {
    const r = await rpc('query', { collection: ANN_COL, query: { docType: DOC_TYPE.AUDIT, announcementId } });
    return (r.data || []).sort((a, b) => fmt(b.createdAt).localeCompare(fmt(a.createdAt)));
  },
  writeAnnouncementAudit: async (announcementId, action, user, detail) => {
    try {
      return await rpc('add', {
        collection: ANN_COL,
        data: {
          docType: DOC_TYPE.AUDIT, announcementId, action,
          operatorId: user ? String(user._id || user.id || user.username || '') : '',
          operatorName: user ? (user.name || user.username || '') : '',
          detail: detail || '', createdAt: new Date().toISOString()
        }
      });
    } catch (e) { throw annAddHint(e); }
  },

  // 过期自动归档：逐条写回（云端无 updateMany）；归档同时取消置顶，避免占位
  archiveExpiredAnnouncements: async (list, user) => {
    const expired = collectExpiredForArchive(list, Date.now());
    if (!expired.length) return 0;
    for (const a of expired) {
      await rpc('update', {
        collection: ANN_COL, query: { _id: a._id },
        data: { status: STATUS.ARCHIVED, archivedAt: new Date().toISOString(), pinned: false }
      }).catch(() => null);
      await api.writeAnnouncementAudit(a._id, 'archive', user,
        '到达过期时间，系统自动归档：' + (a.title || '')).catch(() => null);
    }
    invalidate(cachePrefix(ANN_COL));
    return expired.length;
  },

  // ---------- 上传 ----------
  upload: (fileName, fileData) => rpc('uploadImage', { data: { fileName, fileData } }),

  // ---------- 云存储文件 URL 刷新 ----------
  // cloud:// 格式的 fileID 无法被浏览器直接加载，必须刷新为临时 HTTPS URL（与 APK 一致）
  getFileUrl: async (filePath, maxAge = 60 * 60 * 24 * 30) => {
    const r = await rpc('getFileUrl', { data: { filePath, maxAge } });
    return r.url || '';
  },

  // ---------- 缓存 ----------
  // 后台预热：登录后把各集合提前取回，之后切换页面/打开弹窗即可即时渲染。
  // 不 await、失败静默，绝不阻塞登录流程。
  warmCache: () => {
    const jobs = [
      ['hazards', {}],
      ['users', {}],
      ['message', {}],
      ['departments', {}],
      [ANN_COL, { docType: DOC_TYPE.ANN }]
    ];
    for (const [collection, query] of jobs) {
      warm(collectionKey(collection, query), async () => {
        const r = await rpc('query', { collection, query });
        return r.data || [];
      }, {
        ttl: COLLECTION_TTL[collection] || 60000,
        persist: COLLECTION_PERSIST[collection] !== false
      });
    }
  },
  // 强制刷新指定集合（各页面刷新按钮可用）；不传参则刷新全部集合缓存
  // 注意前缀必须带科室（cachePrefix），否则命中不到实际键值
  refreshCache: (collection) => invalidate(cachePrefix(collection)),
  // 清空本应用写入的全部本地缓存
  clearCache: () => invalidate('')
};
