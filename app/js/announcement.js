// 公告模块：数据模型 + 纯业务逻辑
// 设计约束（已实测确认，勿改）：
//  1. 云端单集合 announcement，用 docType 区分 announcement / read / audit
//     （云函数无 createCollection，建集合只能人工在控制台做，故只建一个）
//  2. 云端无 remove 动作 → 删除一律软删除 isDeleted:true
//  3. 云端无 updateMany → 批量操作只能逐条（api 层处理）
//  4. query 支持服务端字段过滤与 $in（已实测），故已读记录可按需精确拉取
// 本文件不依赖 DOM/网络，可在 node 下直接单测。
import { isAdmin, canManageAnnouncement } from './permission.js';

// ---------- 常量 ----------
export const DOC_TYPE = { ANN: 'announcement', READ: 'read', AUDIT: 'audit' };
export const STATUS = { DRAFT: 'draft', PUBLISHED: 'published', ARCHIVED: 'archived' };
export const STATUS_MAP = { draft: '草稿', published: '已发布', archived: '已归档' };

// 公告分类（预留字段，可按需扩展 key，无需改结构）
export const CATEGORY_MAP = {
  notice: '通知公告',
  regulation: '制度规范',
  safety: '安全警示',
  training: '培训活动',
  holiday: '节假日安排',
  other: '其他'
};

// 置顶数量上限
export const MAX_PINNED = 3;

// 审计动作
export const AUDIT_ACTION = {
  CREATE: 'create',
  UPDATE: 'update',
  PUBLISH: 'publish',
  UNPUBLISH: 'unpublish',
  PIN: 'pin',
  UNPIN: 'unpin',
  DELETE: 'delete',
  ARCHIVE: 'archive',
  RESTORE: 'restore'
};
export const AUDIT_ACTION_MAP = {
  create: '新建公告',
  update: '编辑公告',
  publish: '发布',
  unpublish: '转为草稿',
  pin: '置顶',
  unpin: '取消置顶',
  delete: '删除',
  archive: '自动归档',
  restore: '恢复'
};

// ---------- HTML 安全 ----------
// 富文本以 v-html 渲染，必须消毒：白名单标签 + 白名单属性 + URL 协议校验。
// 采用纯字符串实现（不依赖 DOM），以便在 node 下做 XSS 用例单测。
const ALLOWED_TAGS = new Set([
  'P', 'BR', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'SUB', 'SUP',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE',
  'A', 'IMG', 'HR', 'FONT',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH'
]);
const GLOBAL_ATTRS = ['style', 'align', 'dir'];
const ALLOWED_ATTRS = {
  A: ['href', 'target', 'rel'],
  IMG: ['src', 'alt', 'width', 'height'],
  FONT: ['color', 'size', 'face'],
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan']
};
// 整块移除（含内容）的危险标签
const BLOCK_TAGS = 'script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math|template';

// 允许的 URL 协议：http(s)/mailto/tel、data:image base64、相对路径
export function sanitizeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (/^\s*javascript\s*:|^\s*vbscript\s*:|^\s*data\s*:\s*text\/html/i.test(s)) return '';
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s;
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  // 相对路径 / 锚点 / 同域路径（形如 ./x、/x、#x、abc/x）
  if (/^[./#]/.test(s) || /^[\w-]+([/?#]|$)/.test(s)) return s;
  return '';
}

function sanitizeStyle(v) {
  // style 可被用于 url()/expression() 等注入来源，命中即整体丢弃
  const s = String(v == null ? '' : v);
  if (!s) return '';
  if (/url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding|javascript\s*:/i.test(s)) return '';
  return s.replace(/"/g, '&quot;');
}

function sanitizeAttrs(tag, attrStr) {
  const allowed = (ALLOWED_ATTRS[tag] || []).concat(GLOBAL_ATTRS);
  const re = /([a-zA-Z][a-zA-Z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  const out = [];
  let m;
  while ((m = re.exec(attrStr))) {
    const name = m[1].toLowerCase();
    const raw = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] || ''));
    if (name.indexOf('on') === 0) continue;          // 事件属性一律剔除
    if (allowed.indexOf(name) < 0) continue;          // 非白名单属性剔除
    if (name === 'href' || name === 'src') {
      const safe = sanitizeUrl(raw);
      if (!safe) continue;
      out.push(name + '="' + safe.replace(/"/g, '&quot;') + '"');
      continue;
    }
    if (name === 'style') {
      const sv = sanitizeStyle(raw);
      if (!sv) continue;
      out.push('style="' + sv + '"');
      continue;
    }
    out.push(name + '="' + raw.replace(/"/g, '&quot;') + '"');
  }
  return out.length ? ' ' + out.join(' ') : '';
}

// 对外：把任意富文本清洗为可安全 v-html 的片段
export function sanitizeHtml(html) {
  let s = String(html == null ? '' : html);
  if (!s) return '';
  s = s.replace(/<!--[\s\S]*?-->/g, '');                                     // 注释
  s = s.replace(new RegExp('<\\s*(' + BLOCK_TAGS + ')\\b[\\s\\S]*?<\\s*/\\s*\\1\\s*>', 'gi'), ''); // 危险块含内容
  s = s.replace(new RegExp('<\\s*/?\\s*(' + BLOCK_TAGS + ')\\b[^>]*>', 'gi'), '');                // 残留危险标签
  s = s.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (m, slash, tag, attrs) => {
    const upper = tag.toUpperCase();
    if (!ALLOWED_TAGS.has(upper)) return '';         // 非法标签丢标签、留文本
    if (slash) return '</' + upper + '>';
    return '<' + upper + sanitizeAttrs(upper, attrs) + '>';
  });
  return s;
}

// 富文本 → 纯文本：用于列表搜索匹配与摘要预览
export function stripTags(html) {
  const s = sanitizeHtml(html);
  return s
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 字段工具 ----------
function ts(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? NaN : n;
}
function str(v) { return v == null ? '' : String(v); }

// 字段兜底：云端脏数据/历史文档缺字段时统一补齐，避免渲染层到处判空
export function normalize(a) {
  const o = a && typeof a === 'object' ? a : {};
  return Object.assign({}, o, {
    docType: o.docType || DOC_TYPE.ANN,
    title: str(o.title),
    content: str(o.content),
    category: o.category || 'other',
    status: o.status || STATUS.DRAFT,
    pinned: o.pinned === true,
    expireAt: o.expireAt || '',
    attachments: Array.isArray(o.attachments) ? o.attachments : [],
    isDeleted: o.isDeleted === true,
    createdAt: o.createdAt || '',
    updatedAt: o.updatedAt || o.createdAt || '',
    publishedAt: o.publishedAt || '',
    pinnedAt: o.pinnedAt || ''
  });
}

export function isDeleted(a) { return !!(a && (a.isDeleted === true || a.status === 'deleted')); }
export function isPinned(a) { return !!(a && a.pinned === true); }

// 过期判定：有 expireAt 且已到点即过期。expireAt 为空表示长期有效。
export function isExpired(a, now) {
  const t = ts(a && a.expireAt);
  if (Number.isNaN(t)) return false;
  const n = now == null ? Date.now() : ts(now);
  return t <= (Number.isNaN(n) ? Date.now() : n);
}

// 展示用状态标签：已发布但已到过期时间 → 显示“已过期”
export function statusText(a, now) {
  const o = normalize(a);
  if (isDeleted(o)) return '已删除';
  if (o.status === STATUS.DRAFT) return '草稿';
  if (o.status === STATUS.ARCHIVED) return '已归档';
  return isExpired(o, now) ? '已过期' : '已发布';
}

// ---------- 排序 ----------
// 规则：置顶优先（同置顶按 pinnedAt 倒序，后置顶的排前面）→ 按发布时间倒序（无则创建时间）
export function sortAnnouncements(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.sort((x, y) => {
    const px = isPinned(x) ? 1 : 0;
    const py = isPinned(y) ? 1 : 0;
    if (px !== py) return py - px;
    if (px === 1) {
      const tx = ts(x.pinnedAt) || 0;
      const ty = ts(y.pinnedAt) || 0;
      if (tx !== ty) return ty - tx;
    }
    const ax = ts(x.publishedAt);
    const bx = ts(y.publishedAt);
    const px2 = Number.isNaN(ax) ? (ts(x.createdAt) || 0) : ax;
    const py2 = Number.isNaN(bx) ? (ts(y.createdAt) || 0) : bx;
    return py2 - px2;
  });
}

// ---------- 筛选 ----------
// params: { keyword, category, status, includeExpired }
export function matchFilters(a, params, now) {
  const o = normalize(a);
  const p = params || {};
  if (p.status && p.status !== 'all' && o.status !== p.status) return false;
  if (p.category && p.category !== 'all' && o.category !== p.category) return false;
  if (!p.includeExpired && isExpired(o, now)) return false;
  const kw = str(p.keyword).trim();
  if (kw) {
    const hay = (o.title + ' ' + stripTags(o.content) + ' ' + str(o.authorName)).toLowerCase();
    if (hay.indexOf(kw.toLowerCase()) < 0) return false;
  }
  return true;
}

export function filterAnnouncements(list, params, now) {
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.filter(a => matchFilters(a, params, now));
}

// ---------- 权限与可见性 ----------
// 公告管理权限：严格限定管理员。
// 规则本身收敛在 permission.js（权限唯一出处），这里只做转发，方便公告模块自包含地引用。
export const canManage = canManageAnnouncement;

// 单条公告对某用户是否可见：
//  管理员 → 全部（含草稿/已归档/已过期）
//  其他人 → 仅“已发布且未过期”
export function visibleTo(user, a, now) {
  const o = normalize(a);
  if (isDeleted(o)) return false;
  if (canManage(user)) return true;
  if (o.status !== STATUS.PUBLISHED) return false;
  return !isExpired(o, now);
}

// 列表可见性过滤 + 排序（面向展示层）
export function visibleAnnouncements(user, list, now) {
  const arr = Array.isArray(list) ? list.slice() : [];
  return sortAnnouncements(arr.filter(a => visibleTo(user, a, now)));
}

// ---------- 置顶 ----------
export function pinnedList(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.filter(a => !isDeleted(a) && isPinned(a) && a.status !== STATUS.ARCHIVED);
}

// 置顶前校验：返回 { ok, reason }
//  已置顶的自身不计入名额；达到 MAX_PINNED 且不是自身 → 拒绝
export function canPin(a, list) {
  const target = normalize(a);
  const cur = pinnedList(list);
  if (isPinned(target)) return { ok: false, reason: '该公告已置顶' };
  if (target.status !== STATUS.PUBLISHED) return { ok: false, reason: '仅已发布的公告可置顶' };
  if (cur.length >= MAX_PINNED) {
    return { ok: false, reason: '置顶数量已达上限 ' + MAX_PINNED + ' 条，请先取消其它置顶' };
  }
  return { ok: true, reason: '' };
}

// ---------- 过期自动归档 ----------
// 返回需要归档的文档（已发布且已过期）。展示层调用后由 api 层逐条写回，
// 写回后 status 变为 archived，不会重复触发。
export function collectExpiredForArchive(list, now) {
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.filter(a => !isDeleted(a) && a.status === STATUS.PUBLISHED && isExpired(a, now));
}

// ---------- 阅读统计 ----------
// readDocs：docType=read 的文档集合；返回 { views, read }
export function readStats(readDocs, announcementId, userId) {
  const docs = Array.isArray(readDocs) ? readDocs : [];
  const uid = userId == null ? '' : String(userId);
  const mine = docs.filter(d => String(d.announcementId) === String(announcementId));
  const read = uid ? mine.some(d => String(d.userId) === uid) : false;
  return { views: mine.length, read };
}

// ---------- 草稿本地自动保存 ----------
export const DRAFT_KEY_PREFIX = 'gz_ann_draft_';
export const DRAFT_MAX_AGE = 7 * 24 * 3600 * 1000; // 超过 7 天的本地草稿视为失效

export function draftKey(id) { return DRAFT_KEY_PREFIX + (id || 'new'); }

// 校验草稿是否可用于恢复（结构正确且未过期）；返回草稿对象或 null
export function parseDraft(raw, now) {
  if (!raw) return null;
  let d;
  try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
  if (!d || typeof d !== 'object') return null;
  const savedAt = ts(d.savedAt);
  if (Number.isNaN(savedAt)) return null;
  const n = now == null ? Date.now() : ts(now);
  if ((Number.isNaN(n) ? Date.now() : n) - savedAt > DRAFT_MAX_AGE) return null;
  if (!d.form || typeof d.form !== 'object') return null;
  return d;
}
