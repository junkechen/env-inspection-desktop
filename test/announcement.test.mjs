// 公告模块纯逻辑单测（node test/announcement.test.mjs）
// 覆盖：HTML 消毒(XSS)、纯文本抽取、过期判定、状态文案、排序规则、
//       置顶上限、自动归档、权限可见性、搜索筛选、阅读统计、草稿恢复。
import assert from 'assert';

const M = await import('../app/js/announcement.js');
const {
  sanitizeHtml, sanitizeUrl, stripTags, normalize, isExpired, statusText,
  sortAnnouncements, matchFilters, filterAnnouncements, canManage, visibleTo,
  visibleAnnouncements, canPin, pinnedList, collectExpiredForArchive,
  readStats, parseDraft, draftKey, STATUS, MAX_PINNED, DRAFT_MAX_AGE
} = M;

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  \u2713 ' + name); pass++; })
    .catch((e) => { console.log('  \u2717 ' + name + ' -> ' + e.message); fail++; });
}

const NOW = Date.parse('2026-08-29T12:00:00Z');
const iso = (offMs) => new Date(NOW + offMs).toISOString();
const admin = { _id: 'a1', username: 'admin', role: 'admin' };
const normal = { _id: 'u1', username: 'zhangsan', role: 'inspector' };

function ann(o) { return normalize(Object.assign({ docType: 'announcement', createdAt: iso(-86400000) }, o)); }

console.log('公告模块逻辑测试：');

// ---------- HTML 消毒 ----------
await check('消毒：移除 script 整块（含内容）', () => {
  const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
  assert.ok(!/script/i.test(out), '不应残留 script，实际=' + out);
  assert.ok(!/alert/.test(out), '不应残留脚本内容，实际=' + out);
  // 注：消毒器会把标签规范化为大写（HTML 标签大小写不敏感）
  assert.ok(/<p>hi<\/p>/i.test(out), '合法内容应保留，实际=' + out);
});

await check('消毒：移除 onerror 等事件属性', () => {
  const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
  assert.ok(!/onerror/i.test(out), '事件属性应被剔除，实际=' + out);
  assert.ok(out.indexOf('<IMG') >= 0, '标签本身应保留');
});

await check('消毒：javascript: 协议被剔除', () => {
  const out = sanitizeHtml('<a href="javascript:alert(1)">点我</a>');
  assert.ok(!/javascript:/i.test(out), 'javascript: 不应保留，实际=' + out);
  assert.ok(out.indexOf('点我') >= 0, '文本应保留');
});

await check('消毒：data:text/html 被拒绝，data:image base64 允许', () => {
  assert.strictEqual(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4='), '');
  assert.ok(sanitizeUrl('data:image/png;base64,iVBORw0KGgo=').startsWith('data:image/png'));
  assert.strictEqual(sanitizeUrl('javascript:alert(1)'), '');
  assert.strictEqual(sanitizeUrl('  JavaScript:alert(1)'), '');
  assert.ok(sanitizeUrl('https://x.com/a.png'));
  assert.ok(sanitizeUrl('./img/a.png'));
});

await check('消毒：style 含 url()/expression() 整体丢弃', () => {
  const out = sanitizeHtml('<div style="background:url(javascript:alert(1))">x</div>');
  assert.ok(!/url\(/i.test(out), '危险 style 应丢弃，实际=' + out);
  const ok = sanitizeHtml('<div style="color:red">x</div>');
  assert.ok(ok.indexOf('color:red') >= 0, '安全 style 应保留，实际=' + ok);
});

await check('消毒：非法标签丢标签保留文本（iframe/svg）', () => {
  const out = sanitizeHtml('<iframe src="evil"></iframe><svg onload="alert(1)"></svg>安全');
  assert.ok(!/iframe|svg|onload/i.test(out), '实际=' + out);
  assert.ok(out.indexOf('安全') >= 0);
});

await check('消毒：允许白名单富文本标签', () => {
  const html = '<h2>标题</h2><p><strong>粗</strong><em>斜</em></p><ul><li>项</li></ul>';
  const out = sanitizeHtml(html);
  ['H2', 'P', 'STRONG', 'EM', 'UL', 'LI'].forEach(t => assert.ok(out.indexOf('<' + t) >= 0, '应保留 ' + t + '，实际=' + out));
});

await check('stripTags：抽出纯文本用于搜索', () => {
  assert.strictEqual(stripTags('<p>公告&nbsp;内容</p>'), '公告 内容');
  assert.strictEqual(stripTags('<script>bad()</script><p>ok</p>'), 'ok');
  assert.strictEqual(stripTags(''), '');
});

// ---------- 过期与状态 ----------
await check('过期判定：无 expireAt 永不过期；到点即过期', () => {
  assert.strictEqual(isExpired(ann({ expireAt: '' }), NOW), false);
  assert.strictEqual(isExpired(ann({ expireAt: iso(-1000) }), NOW), true);
  assert.strictEqual(isExpired(ann({ expireAt: iso(1000) }), NOW), false);
});

await check('状态文案：已发布但过期显示“已过期”', () => {
  assert.strictEqual(statusText(ann({ status: STATUS.DRAFT }), NOW), '草稿');
  assert.strictEqual(statusText(ann({ status: STATUS.PUBLISHED }), NOW), '已发布');
  assert.strictEqual(statusText(ann({ status: STATUS.PUBLISHED, expireAt: iso(-1) }), NOW), '已过期');
  assert.strictEqual(statusText(ann({ status: STATUS.ARCHIVED }), NOW), '已归档');
});

// ---------- 排序 ----------
await check('排序：置顶优先，置顶内按 pinnedAt 倒序，其余按发布时间倒序', () => {
  const list = [
    ann({ _id: '1', title: '普通新', status: STATUS.PUBLISHED, publishedAt: iso(-1000) }),
    ann({ _id: '2', title: '普通旧', status: STATUS.PUBLISHED, publishedAt: iso(-5000) }),
    ann({ _id: '3', title: '置顶早', status: STATUS.PUBLISHED, pinned: true, pinnedAt: iso(-9000), publishedAt: iso(-9000) }),
    ann({ _id: '4', title: '置顶晚', status: STATUS.PUBLISHED, pinned: true, pinnedAt: iso(-2000), publishedAt: iso(-8000) })
  ];
  const out = sortAnnouncements(list).map(x => x._id);
  assert.deepStrictEqual(out, ['4', '3', '1', '2'], '实际顺序=' + out.join(','));
});

// ---------- 置顶上限 ----------
await check('置顶上限：已达 MAX_PINNED 时拒绝新置顶', () => {
  const list = [1, 2, 3].map(i => ann({ _id: 'p' + i, status: STATUS.PUBLISHED, pinned: true, pinnedAt: iso(-i * 1000) }));
  const target = ann({ _id: 'new', status: STATUS.PUBLISHED });
  const r = canPin(target, list);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.indexOf(String(MAX_PINNED)) >= 0, '提示应含上限值，实际=' + r.reason);
});

await check('置顶校验：草稿不可置顶、已置顶不重复计数', () => {
  const list = [ann({ _id: 'p1', status: STATUS.PUBLISHED, pinned: true })];
  assert.strictEqual(canPin(ann({ _id: 'd', status: STATUS.DRAFT }), list).ok, false, '草稿不可置顶');
  assert.strictEqual(canPin(ann({ _id: 'x', status: STATUS.PUBLISHED }), list).ok, true, '未达上限应允许');
  const self = ann({ _id: 'p1', status: STATUS.PUBLISHED, pinned: true });
  assert.strictEqual(canPin(self, list).ok, false, '自身已置顶应拒绝');
});

await check('pinnedList：排除已删除与已归档', () => {
  const list = [
    ann({ _id: 'a', pinned: true, status: STATUS.PUBLISHED }),
    ann({ _id: 'b', pinned: true, status: STATUS.ARCHIVED }),
    ann({ _id: 'c', pinned: true, status: STATUS.PUBLISHED, isDeleted: true })
  ];
  assert.deepStrictEqual(pinnedList(list).map(x => x._id), ['a']);
});

// ---------- 自动归档 ----------
await check('自动归档：仅挑出“已发布且已过期”的文档', () => {
  const list = [
    ann({ _id: '1', status: STATUS.PUBLISHED, expireAt: iso(-1) }),   // 应归档
    ann({ _id: '2', status: STATUS.PUBLISHED, expireAt: iso(9999) }), // 未过期
    ann({ _id: '3', status: STATUS.DRAFT, expireAt: iso(-1) }),       // 草稿不归档
    ann({ _id: '4', status: STATUS.ARCHIVED, expireAt: iso(-1) }),    // 已归档不重复
    ann({ _id: '5', status: STATUS.PUBLISHED, expireAt: iso(-1), isDeleted: true })
  ];
  assert.deepStrictEqual(collectExpiredForArchive(list, NOW).map(x => x._id), ['1']);
});

// ---------- 权限可见性 ----------
await check('权限：canManage 仅管理员', () => {
  assert.strictEqual(canManage(admin), true);
  assert.strictEqual(canManage(normal), false);
  assert.strictEqual(canManage({ role: 'supervisor' }), false);
  assert.strictEqual(canManage(null), false);
});

await check('可见性：草稿/已归档仅管理员可见，普通用户只见已发布未过期', () => {
  const draft = ann({ _id: 'd', status: STATUS.DRAFT });
  const pub = ann({ _id: 'p', status: STATUS.PUBLISHED });
  const expired = ann({ _id: 'e', status: STATUS.PUBLISHED, expireAt: iso(-1) });
  const archived = ann({ _id: 'a', status: STATUS.ARCHIVED });
  assert.strictEqual(visibleTo(normal, draft, NOW), false);
  assert.strictEqual(visibleTo(normal, pub, NOW), true);
  assert.strictEqual(visibleTo(normal, expired, NOW), false, '过期对普通用户隐藏');
  assert.strictEqual(visibleTo(normal, archived, NOW), false);
  [draft, pub, expired, archived].forEach(a => assert.strictEqual(visibleTo(admin, a, NOW), true, '管理员应可见 ' + a._id));
});

await check('visibleAnnouncements：过滤并按置顶/时间排序', () => {
  const list = [
    ann({ _id: 'd', status: STATUS.DRAFT }),
    ann({ _id: 'p1', status: STATUS.PUBLISHED, publishedAt: iso(-1000) }),
    ann({ _id: 'p2', status: STATUS.PUBLISHED, publishedAt: iso(-9000), pinned: true, pinnedAt: iso(-9000) })
  ];
  assert.deepStrictEqual(visibleAnnouncements(normal, list, NOW).map(x => x._id), ['p2', 'p1']);
  assert.deepStrictEqual(visibleAnnouncements(admin, list, NOW).map(x => x._id), ['p2', 'p1', 'd']);
});

// ---------- 搜索筛选 ----------
await check('筛选：按状态、分类、关键词（匹配标题与正文）', () => {
  const list = [
    ann({ _id: '1', status: STATUS.PUBLISHED, category: 'safety', title: '消防演练通知', content: '<p>下周一举行</p>' }),
    ann({ _id: '2', status: STATUS.DRAFT, category: 'notice', title: '草稿标题', content: '<p>正文含消防二字</p>' })
  ];
  assert.deepStrictEqual(filterAnnouncements(list, { status: STATUS.DRAFT }, NOW).map(x => x._id), ['2']);
  assert.deepStrictEqual(filterAnnouncements(list, { category: 'safety' }, NOW).map(x => x._id), ['1']);
  assert.deepStrictEqual(filterAnnouncements(list, { keyword: '消防' }, NOW).map(x => x._id), ['1', '2'], '标题与正文都应命中');
  assert.deepStrictEqual(filterAnnouncements(list, { keyword: '不存在' }, NOW).map(x => x._id), []);
});

await check('筛选：默认排除过期，includeExpired 可包含', () => {
  const list = [ann({ _id: 'e', status: STATUS.PUBLISHED, expireAt: iso(-1) })];
  assert.strictEqual(filterAnnouncements(list, {}, NOW).length, 0);
  assert.strictEqual(filterAnnouncements(list, { includeExpired: true }, NOW).length, 1);
});

// ---------- 阅读统计 ----------
await check('阅读统计：views 为去重人数，read 判断当前用户是否已读', () => {
  const reads = [
    { announcementId: 'x', userId: 'u1' },
    { announcementId: 'x', userId: 'u2' },
    { announcementId: 'y', userId: 'u1' }
  ];
  assert.deepStrictEqual(readStats(reads, 'x', 'u1'), { views: 2, read: true });
  assert.deepStrictEqual(readStats(reads, 'x', 'u9'), { views: 2, read: false });
  assert.deepStrictEqual(readStats(reads, 'y', 'u2'), { views: 1, read: false });
  assert.deepStrictEqual(readStats([], 'z', 'u1'), { views: 0, read: false });
});

// ---------- 草稿恢复 ----------
await check('草稿：key 规则与过期失效', () => {
  assert.strictEqual(draftKey('new'), 'gz_ann_draft_new');
  assert.strictEqual(draftKey('123'), 'gz_ann_draft_123');
  const good = JSON.stringify({ savedAt: new Date(Date.now() - 1000).toISOString(), form: { title: 'a' } });
  assert.ok(parseDraft(good));
  const stale = JSON.stringify({ savedAt: new Date(Date.now() - DRAFT_MAX_AGE - 1000).toISOString(), form: { title: 'a' } });
  assert.strictEqual(parseDraft(stale), null, '超过 7 天应失效');
  assert.strictEqual(parseDraft('{bad json'), null);
  assert.strictEqual(parseDraft(JSON.stringify({ savedAt: new Date().toISOString() })), null, '缺 form 应失效');
});

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
