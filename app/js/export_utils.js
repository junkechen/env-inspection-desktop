// 导出工具：纯函数，不依赖浏览器全局，便于在 Node 下单元测试。
// - buildExcelWorkbook(XLSX, issues, meta)：生成 4 个 sheet 的台账工作簿（与 APK 一致）
// - buildPdfHtml(issues, meta)：生成图文报告 HTML（供主进程 printToPDF）
// - collectExportPhotoUrls(issues)：汇总导出涉及的照片 URL
// - fetchPhotoThumbnails(urls, opts)：并发受限地下载并缩放为缩略图
//
// 字段映射以 EXE（即云端）数据结构为准：
//   category 已存中文（废水排放…）；severity/status 存枚举，需转中文。
//   id 取 _id 或 id；照片在 photos / rectificationPhotos / rectificationHistory[].photos。
//
// v1.0.31：台账排版规范化 + 照片内嵌。SheetJS 社区版写不出样式/冻结/图片，
// 所以这里只负责「内容 + 排版计划（plan）」，由主进程 xlsx_inject.js 在 ZIP 层注入。
// 返回的工作簿上挂载 __ledgerPlan；若增强注入失败，直接落盘原始 xlsx 也能保证数据完整。

const STATUS_NAME = { pending: '待处理', processing: '整改中', reviewing: '待验收', closed: '已关闭', deleted: '已删除' };
const SEVERITY_NAME = { general: '一般', serious: '较大', critical: '重大' };

function statusName(s) { return STATUS_NAME[s] || s || '—'; }
function severityName(s) { return SEVERITY_NAME[s] || s || '一般'; }
function str(v) { return v == null ? '' : String(v); }
function idOf(h) { return str(h._id || h.id); }
function dateOnly(v) { return (str(v).slice(0, 10)) || ''; }
function dateTime(v) { return (str(v).slice(0, 19).replace('T', ' ')) || ''; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateStamp(d) {
  const x = d instanceof Date ? d : new Date();
  return `${x.getFullYear()}年${pad2(x.getMonth() + 1)}月${pad2(x.getDate())}日`;
}

// 取最新整改反馈（rectificationHistory 末条优先，fallback rectificationNote）
function latestRect(h) {
  if (h.rectificationHistory && h.rectificationHistory.length) {
    const r = h.rectificationHistory[h.rectificationHistory.length - 1];
    return { note: str(r.description), time: dateTime(r.timestamp), who: str(r.submitterName) };
  }
  return { note: str(h.rectificationNote), time: '', who: '' };
}
function rectPicCount(h) {
  if (h.rectificationHistory && h.rectificationHistory.length) {
    return h.rectificationHistory.reduce((s, r) => s + (r.photos ? r.photos.length : 0), 0);
  }
  return (h.rectificationPhotos || []).length;
}
function rejectionCount(h) {
  if (h.rejectionHistory && h.rejectionHistory.length) return h.rejectionHistory.length;
  return h.rejectionNote ? 1 : 0;
}
function isHttp(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

// 整改照片全集（按整改历史顺序展平；无历史时回退 rectificationPhotos）。
// 与 h.photos（隐患现场照）是两个不同字段，导出时必须分列展示、不能混标。
function rectPhotosOf(h) {
  if (h.rectificationHistory && h.rectificationHistory.length) {
    return h.rectificationHistory.flatMap((r) => r.photos || []);
  }
  return h.rectificationPhotos || [];
}

// ============================================================
// 照片：URL 收集 + 并发下载 + 缩略图
// ============================================================

// 汇总本次导出会用到的照片 URL（去重）。maxPerRecord 控制每张记录最多取几张，与列数一致。
export function collectExportPhotoUrls(issues, maxPerRecord = 6) {
  const set = new Set();
  (Array.isArray(issues) ? issues : []).forEach((h) => {
    (h.photos || []).slice(0, maxPerRecord).forEach((u) => { if (isHttp(u)) set.add(u); });
    if (h.rectificationHistory && h.rectificationHistory.length) {
      h.rectificationHistory.forEach((r) => {
        (r.photos || []).slice(0, maxPerRecord).forEach((u) => { if (isHttp(u)) set.add(u); });
      });
    } else {
      (h.rectificationPhotos || []).slice(0, maxPerRecord).forEach((u) => { if (isHttp(u)) set.add(u); });
    }
  });
  return [...set];
}

// 把一张 data URL 缩放为不超过 maxPx 的缩略图，返回 { base64, wPx, hPx }
function thumbnailFromDataUrl(dataUrl, maxPx) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; reject(new Error('decode timeout')); }, 15000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const iw = img.naturalWidth || img.width || maxPx;
        const ih = img.naturalHeight || img.height || maxPx;
        const scale = Math.min(1, maxPx / Math.max(iw, ih));
        const wPx = Math.max(1, Math.round(iw * scale));
        const hPx = Math.max(1, Math.round(ih * scale));
        const cv = document.createElement('canvas');
        cv.width = wPx; cv.height = hPx;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, wPx, hPx);
        ctx.drawImage(img, 0, 0, wPx, hPx);
        // JPEG：照片类图像压缩率高，可显著降低 xlsx 体积；透明通道对现场照片无意义
        const out = cv.toDataURL('image/jpeg', 0.85);
        const i = out.indexOf(',');
        resolve({ base64: i >= 0 ? out.slice(i + 1) : out, wPx, hPx });
      } catch (e) { reject(e); }
    };
    img.onerror = () => { clearTimeout(timer); reject(new Error('image decode failed')); };
    img.src = dataUrl;
  });
}

// 并发受限地下载并缩放照片。任一张失败只跳过该张，绝不中断整体导出。
// opts: { fetchImage, concurrency = 4, maxPx = 120, timeoutMs = 20000, onProgress }
// 返回 Map<url, { base64, wPx, hPx }>
export async function fetchPhotoThumbnails(urls, opts = {}) {
  const map = new Map();
  const list = [...new Set((urls || []).filter(isHttp))];
  if (!list.length || typeof document === 'undefined') return map;
  const fetchImage = opts.fetchImage;
  if (typeof fetchImage !== 'function') return map;

  const maxPx = opts.maxPx || 120;
  const timeoutMs = opts.timeoutMs || 20000;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency || 4));

  let cursor = 0, done = 0;
  const withTimeout = (p, ms) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);

  async function worker() {
    while (cursor < list.length) {
      const url = list[cursor++];
      try {
        const r = await withTimeout(fetchImage({ url }), timeoutMs);
        if (r && r.dataUrl) {
          const t = await thumbnailFromDataUrl(r.dataUrl, maxPx);
          if (t && t.base64) map.set(url, t);
        }
      } catch (e) { /* 单张失败：跳过，保持该单元格为「无图片」占位 */ }
      done++;
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress(done, list.length); } catch (e) {}
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return map;
}

// ============================================================
// 台账排版计划（plan）构造辅助
// ============================================================
function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// 图片单元格：能取到缩略图就登记内嵌图片并返回空串（图片悬浮在单元格上），
// 取不到就返回「无图片」占位文本。任何异常都不会抛出，保证导出流程不中断。
function planPhotoCell(plan, mediaIndex, photoStore, url, row, col, rowHeightsKey) {
  if (!isHttp(url)) return '无图片';
  let t = null;
  try { t = photoStore && (photoStore.get ? photoStore.get(url) : photoStore[url]); } catch (e) { t = null; }
  if (!t || !t.base64) return '无图片';

  let mi = mediaIndex.get(url);
  if (mi == null) {
    mi = plan.media.length;
    plan.media.push({ name: `img${mi + 1}.jpg`, base64: t.base64 });
    mediaIndex.set(url, mi);
  }
  plan._sheet.images.push({
    row, col, media: mi,
    wPx: t.wPx || 120, hPx: t.hPx || 120, padEmu: 38100
  });
  plan._sheet.rowHeights[String(rowHeightsKey != null ? rowHeightsKey : row)] = 98; // ≈120px 图片 + 内边距
  return '';
}

// 统一设置一行的数据（含样式无关的纯文本）
function putRow(XLSX, sheet, rowIdx, values) {
  XLSX.utils.sheet_add_aoa(sheet, [values], { origin: { r: rowIdx, c: 0 } });
}

// ============================================================
// 主入口：生成工作簿（内容） + 排版计划（样式/冻结/图片）
// ============================================================
export function buildExcelWorkbook(XLSX, issues, meta) {
  const list = Array.isArray(issues) ? issues : [];
  const m = meta || {};
  const photoStore = m.photoStore || null;
  const now = m.generatedAt ? new Date(m.generatedAt) : new Date();
  const exportUser = m.exportUser || '管理员';
  const period = m.period || '全部数据';
  const titleText = m.title || 'GZ 环保巡查整改台账';

  const plan = { media: [], sheets: [] };
  const mediaIndex = new Map();

  const closed = list.filter((h) => h.status === 'closed').length;
  const unclosed = list.length - closed;

  // 预统计最大照片数（动态列头，与 APK 一致，限制 1..6）
  let maxIssuePics = 1, maxRectPics = 1, maxRectPics1 = 1;
  for (const h of list) {
    const ip = (h.photos || []).length;
    if (ip > maxIssuePics) maxIssuePics = Math.min(ip, 6);
    // 台账「整改照片」列：按整改历史展平后的总数
    const rpAll = Math.min(rectPhotosOf(h).length, 6);
    if (rpAll > maxRectPics1) maxRectPics1 = rpAll;
    if (h.rectificationHistory && h.rectificationHistory.length) {
      for (const r of h.rectificationHistory) {
        const rp = (r.photos || []).length;
        if (rp > maxRectPics) maxRectPics = Math.min(rp, 6);
      }
    } else {
      const rp = (h.rectificationPhotos || []).length;
      if (rp > maxRectPics) maxRectPics = Math.min(rp, 6);
    }
  }

  const wb = XLSX.utils.book_new();

  // ---------- 工作表1：问题闭环台账 ----------
  const headers1Base = [
    '序号', '问题编号', '问题标题', '问题详情描述', '问题位置', '问题类型', '严重程度',
    '所属部门', '上报人', '整改责任人', '整改截止日期', '当前状态', '最新整改反馈',
    '整改反馈时间', '验收意见', '完成时间', '整改照片数量', '驳回次数', '创建时间', '最后更新时间'
  ];
  // 照片按类型分列：隐患照片 ← h.photos；整改照片 ← rectificationHistory/rectificationPhotos
  const picHeaders1 = Array.from({ length: maxIssuePics }, (_, i) => '隐患照片' + (i + 1));
  const rectHeaders1 = Array.from({ length: maxRectPics1 }, (_, i) => '整改照片' + (i + 1));
  const headers1 = [...headers1Base, ...picHeaders1, ...rectHeaders1];
  const colCount1 = headers1.length;
  const lastCol1 = colLetter(colCount1 - 1);
  const rectColStart1 = headers1Base.length + maxIssuePics; // 整改照片列起始下标

  const sheet1 = XLSX.utils.aoa_to_sheet([[]]);
  const p1 = {
    file: 'xl/worksheets/sheet1.xml', name: '问题闭环台账', localSheetId: 0,
    rowCount: 0, colCount: colCount1,
    widths: [6, 22, 26, 34, 18, 14, 10, 12, 10, 10, 13, 10, 30, 18, 24, 18, 8, 8, 18, 18]
      .concat(Array(maxIssuePics + maxRectPics1).fill(19)),
    rowHeights: { '0': 34, '1': 22, '2': 34 },
    rowRole: { '0': 'title', '1': 'subtitle', '2': 'header' },
    colRole: { '6': 'severity', '11': 'status' },
    sevText: {}, stText: {},
    centerCols: [0, 1, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17, 18, 19],
    imageCols: Array.from({ length: maxIssuePics + maxRectPics1 }, (_, i) => headers1Base.length + i),
    images: [], merges: [],
    freezeRows: 3, landscape: true,
    headerFooter: {
      left: titleText, center: '', right: dateStamp(now),
      footerLeft: '导出人：' + exportUser,
      footerCenter: '第 &P 页 / 共 &N 页',
      footerRight: '统计范围：' + period
    }
  };
  plan._sheet = p1;
  plan.sheets.push(p1);

  // 标题行（合并居中）+ 副标题（导出日期与统计）
  putRow(XLSX, sheet1, 0, [titleText]);
  const subtitle1 = `统计范围：${period}　｜　导出时间：${dateTime(m.generatedAt)}　｜　导出人：${exportUser}`
    + `　｜　隐患总数：${list.length}　｜　已整改：${closed}　｜　未整改：${unclosed}`;
  putRow(XLSX, sheet1, 1, [subtitle1]);
  putRow(XLSX, sheet1, 2, headers1);
  p1.merges.push({ s: [0, 0], e: [0, colCount1 - 1] }, { s: [1, 0], e: [1, colCount1 - 1] });

  list.forEach((h, idx) => {
    const lr = latestRect(h);
    const rowIdx = idx + 3;
    const sev = severityName(h.severity);
    const stt = statusName(h.status);
    p1.sevText[String(rowIdx)] = sev;
    p1.stText[String(rowIdx)] = stt;

    const rowBase = [
      idx + 1, idOf(h), str(h.title) || str(h.description).slice(0, 24), str(h.description),
      str(h.location), str(h.category), sev, str(h.department),
      str(h.reporterName), str(h.assigneeName), dateOnly(h.dueDate || h.deadline),
      stt, lr.note, lr.time, str(h.acceptanceNote), dateTime(h.closedAt),
      rectPicCount(h), rejectionCount(h), dateTime(h.createdAt), dateTime(h.updatedAt)
    ];
    const photos = (h.photos || []).slice(0, maxIssuePics);
    const rphotos = rectPhotosOf(h).slice(0, maxRectPics1);
    const picCells = [];
    for (let i = 0; i < maxIssuePics; i++) {
      picCells.push(i < photos.length
        ? planPhotoCell(plan, mediaIndex, photoStore, photos[i], rowIdx, headers1Base.length + i, rowIdx)
        : '');
    }
    for (let i = 0; i < maxRectPics1; i++) {
      picCells.push(i < rphotos.length
        ? planPhotoCell(plan, mediaIndex, photoStore, rphotos[i], rowIdx, rectColStart1 + i, rowIdx)
        : '');
    }
    putRow(XLSX, sheet1, rowIdx, [...rowBase, ...picCells]);
  });

  const rowCount1 = 3 + list.length;
  p1.rowCount = rowCount1;
  if (list.length) p1.autoFilterRef = `A3:${lastCol1}${rowCount1}`;
  p1.printArea = `A1:${lastCol1}${Math.max(rowCount1, 3)}`;

  // 兼容：即使增强注入失败退回原始 xlsx，也保留列宽与合并
  sheet1['!cols'] = p1.widths.map((w) => ({ wch: w }));
  sheet1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: colCount1 - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: colCount1 - 1 } }];
  XLSX.utils.book_append_sheet(wb, sheet1, '问题闭环台账');

  // ---------- 工作表2：整改过程记录 ----------
  const headers2Base = ['序号', '问题编号', '问题标题', '所属部门', '整改责任人', '整改次数', '整改时间', '整改反馈内容', '整改照片数量'];
  const picHeaders2 = Array.from({ length: maxRectPics }, (_, i) => '整改照片' + (i + 1));
  const headers2 = [...headers2Base, ...picHeaders2];
  const colCount2 = headers2.length;
  const lastCol2 = colLetter(colCount2 - 1);

  const sheet2 = XLSX.utils.aoa_to_sheet([[]]);
  const p2 = {
    file: 'xl/worksheets/sheet2.xml', name: '整改过程记录', localSheetId: 1,
    rowCount: 0, colCount: colCount2,
    widths: [6, 22, 26, 12, 12, 9, 18, 34, 9].concat(Array(maxRectPics).fill(19)),
    rowHeights: { '0': 34, '1': 34 },
    rowRole: { '0': 'title', '1': 'header' },
    colRole: {}, sevText: {}, stText: {},
    centerCols: [0, 1, 4, 5, 6, 8],
    imageCols: Array.from({ length: maxRectPics }, (_, i) => headers2Base.length + i),
    images: [], merges: [],
    freezeRows: 2, landscape: true,
    headerFooter: {
      left: titleText + ' · 整改过程记录', center: '', right: dateStamp(now),
      footerLeft: '导出人：' + exportUser, footerCenter: '第 &P 页 / 共 &N 页', footerRight: ''
    }
  };
  plan._sheet = p2;
  plan.sheets.push(p2);

  putRow(XLSX, sheet2, 0, [titleText + ' · 整改过程记录']);
  putRow(XLSX, sheet2, 1, headers2);
  p2.merges.push({ s: [0, 0], e: [0, colCount2 - 1] });

  let rectSeq = 0, rectRow = 2;
  list.forEach((h) => {
    const emit = (rowBase, photos) => {
      rectSeq++;
      const pics = (photos || []).slice(0, maxRectPics);
      const picCells = [];
      for (let i = 0; i < maxRectPics; i++) {
        picCells.push(i < pics.length
          ? planPhotoCell(plan, mediaIndex, photoStore, pics[i], rectRow, headers2Base.length + i, rectRow)
          : '');
      }
      putRow(XLSX, sheet2, rectRow, [...rowBase, ...picCells]);
      rectRow++;
    };
    if (h.rectificationHistory && h.rectificationHistory.length) {
      h.rectificationHistory.forEach((r, i) => {
        emit([
          rectSeq + 1, idOf(h), str(h.title), str(h.department),
          str(r.submitterName) || str(h.assigneeName), i + 1, dateTime(r.timestamp),
          str(r.description), (r.photos || []).length
        ], r.photos);
      });
    } else if (str(h.rectificationNote)) {
      emit([
        rectSeq + 1, idOf(h), str(h.title), str(h.department), str(h.assigneeName), 1,
        dateTime(h.updatedAt), str(h.rectificationNote), (h.rectificationPhotos || []).length
      ], h.rectificationPhotos);
    }
  });
  p2.rowCount = Math.max(rectRow, 2);
  if (rectSeq) p2.autoFilterRef = `A2:${lastCol2}${p2.rowCount}`;
  p2.printArea = `A1:${lastCol2}${p2.rowCount}`;
  sheet2['!cols'] = p2.widths.map((w) => ({ wch: w }));
  sheet2['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: colCount2 - 1 } }];
  XLSX.utils.book_append_sheet(wb, sheet2, '整改过程记录');

  // ---------- 工作表3：驳回记录 ----------
  const headers3 = ['序号', '问题编号', '问题标题', '所属部门', '整改责任人', '驳回次数', '驳回时间', '驳回人', '驳回意见'];
  const colCount3 = headers3.length;
  const colCount4 = 2;
  const lastCol3 = colLetter(colCount3 - 1);
  const sheet3 = XLSX.utils.aoa_to_sheet([[]]);
  const p3 = {
    file: 'xl/worksheets/sheet3.xml', name: '驳回记录', localSheetId: 2,
    rowCount: 0, colCount: colCount3,
    widths: [6, 22, 26, 12, 12, 9, 18, 12, 34],
    rowHeights: { '0': 34, '1': 34 },
    rowRole: { '0': 'title', '1': 'header' },
    colRole: {}, sevText: {}, stText: {},
    centerCols: [0, 1, 4, 5, 6, 7],
    imageCols: [], images: [], merges: [],
    freezeRows: 2, landscape: false,
    headerFooter: {
      left: titleText + ' · 驳回记录', center: '', right: dateStamp(now),
      footerLeft: '导出人：' + exportUser, footerCenter: '第 &P 页 / 共 &N 页', footerRight: ''
    }
  };
  plan._sheet = p3;
  plan.sheets.push(p3);

  putRow(XLSX, sheet3, 0, [titleText + ' · 驳回记录']);
  putRow(XLSX, sheet3, 1, headers3);
  p3.merges.push({ s: [0, 0], e: [0, colCount3 - 1] });

  let rejSeq = 0, rejRow = 2;
  list.forEach((h) => {
    if (h.rejectionHistory && h.rejectionHistory.length) {
      h.rejectionHistory.forEach((r, i) => {
        rejSeq++;
        putRow(XLSX, sheet3, rejRow, [rejSeq, idOf(h), str(h.title), str(h.department), str(h.assigneeName), i + 1, dateTime(r.timestamp), str(r.reviewerName), str(r.note)]);
        rejRow++;
      });
    } else if (str(h.rejectionNote)) {
      rejSeq++;
      putRow(XLSX, sheet3, rejRow, [rejSeq, idOf(h), str(h.title), str(h.department), str(h.assigneeName), 1, dateTime(h.updatedAt), str(h.reporterName), str(h.rejectionNote)]);
      rejRow++;
    }
  });
  p3.rowCount = Math.max(rejRow, 2);
  if (rejSeq) p3.autoFilterRef = `A2:${lastCol3}${p3.rowCount}`;
  p3.printArea = `A1:${lastCol3}${p3.rowCount}`;
  sheet3['!cols'] = p3.widths.map((w) => ({ wch: w }));
  sheet3['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: colCount3 - 1 } }];
  XLSX.utils.book_append_sheet(wb, sheet3, '驳回记录');

  // ---------- 工作表4：统计汇总 ----------
  const sheet4 = XLSX.utils.aoa_to_sheet([['']]);
  const p4 = {
    file: 'xl/worksheets/sheet4.xml', name: '统计汇总', localSheetId: 3,
    rowCount: 0, colCount: 2,
    widths: [22, 26],
    rowHeights: { '0': 34 },
    rowRole: { '0': 'title' },
    colRole: { '0': 'statLabel', '1': 'statValue' },
    sevText: {}, stText: {}, centerCols: [], imageCols: [], images: [], merges: [],
    freezeRows: 0, landscape: false,
    headerFooter: {
      left: titleText + ' · 统计汇总', center: '', right: dateStamp(now),
      footerLeft: '导出人：' + exportUser, footerCenter: '第 &P 页 / 共 &N 页', footerRight: ''
    }
  };
  plan._sheet = p4;
  plan.sheets.push(p4);

  const setCell = (col, row, text) => {
    const ref = XLSX.utils.encode_cell({ r: row, c: col });
    sheet4[ref] = { t: 's', v: str(text) };
  };
  const pending = list.filter((h) => h.status === 'pending').length;
  const processing = list.filter((h) => h.status === 'processing').length;
  const reviewing = list.filter((h) => h.status === 'reviewing').length;
  const overdue = list.filter((h) => h.status === 'pending' && h.dueDate && new Date(h.dueDate).getTime() < now.getTime()).length;
  const closedRate = list.length ? ((closed / list.length) * 100).toFixed(1) + '%' : '0.0%';

  setCell(0, 0, 'GZ 环保巡查整改管理统计报表');
  p4.merges.push({ s: [0, 0], e: [0, 1] });
  setCell(0, 1, '统计范围:'); setCell(1, 1, period);
  setCell(0, 2, '生成时间:'); setCell(1, 2, dateTime(m.generatedAt));
  setCell(0, 3, '导出人:'); setCell(1, 3, exportUser);

  setCell(0, 5, '【总体统计】'); p4.rowRole['5'] = 'section';
  const summary = [
    ['问题总数', list.length], ['已完成（已整改）', closed], ['完成率', closedRate],
    ['未整改合计', unclosed], ['待处理', pending], ['整改中/待验收', processing + reviewing],
    ['已超期未整改', overdue], ['累计整改记录数', rectSeq], ['累计驳回记录数', rejSeq]
  ];
  summary.forEach((kv, i) => { setCell(0, 6 + i, kv[0]); setCell(1, 6 + i, kv[1]); });

  let r = 6 + summary.length + 1;
  setCell(0, r, '【问题类型分布】'); p4.rowRole[String(r)] = 'section'; r++;
  const catCount = {};
  list.forEach((h) => { const k = str(h.category) || '其他'; catCount[k] = (catCount[k] || 0) + 1; });
  Object.entries(catCount).forEach(([k, v]) => { setCell(0, r, k); setCell(1, r, v); r++; });

  r += 1;
  setCell(0, r, '【部门问题统计】'); p4.rowRole[String(r)] = 'section'; r++;
  const deptCount = {};
  list.forEach((h) => { const k = str(h.department) || '未分配'; deptCount[k] = (deptCount[k] || 0) + 1; });
  Object.entries(deptCount).forEach(([k, v]) => { setCell(0, r, k); setCell(1, r, v); r++; });

  p4.rowCount = Math.max(r, 6);
  p4.printArea = `A1:B${p4.rowCount}`;
  // aoa_to_sheet 会把 !ref 固定在 A1，手工写入的单元格若不更新范围会被 write 丢弃
  sheet4['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: p4.rowCount - 1, c: colCount4 - 1 } });
  sheet4['!cols'] = p4.widths.map((w) => ({ wch: w }));
  sheet4['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  XLSX.utils.book_append_sheet(wb, sheet4, '统计汇总');

  delete plan._sheet;
  // 挂载计划：调用方取出后随 buffer 一起交给主进程注入
  wb.__ledgerPlan = plan;
  return wb;
}

// ---------- PDF 报告 HTML ----------
function escapeHtml(s) {
  return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function photoImgs(photos, label) {
  const arr = (photos || []).filter((u) => /^https?:\/\//.test(u));
  if (!arr.length) return `<div class="muted">${escapeHtml(label)}：无</div>`;
  const imgs = arr.map((u) => `<img src="${escapeHtml(u)}" />`).join('');
  return `<div class="muted">${escapeHtml(label)}（${arr.length}张）：</div><div class="photos">${imgs}</div>`;
}

export function buildPdfHtml(issues, meta) {
  const list = Array.isArray(issues) ? issues : [];
  const now = (meta && meta.generatedAt) ? new Date(meta.generatedAt) : new Date();
  const closed = list.filter((h) => h.status === 'closed').length;
  const processing = list.filter((h) => h.status === 'processing').length;
  const pending = list.filter((h) => h.status === 'pending').length;
  const reviewing = list.filter((h) => h.status === 'reviewing').length;
  const overdue = list.filter((h) => h.status === 'pending' && h.dueDate && new Date(h.dueDate).getTime() < now.getTime()).length;
  const closedRate = list.length ? ((closed / list.length) * 100).toFixed(1) + '%' : '0.0%';
  let totalRect = 0, totalRej = 0;
  list.forEach((h) => {
    if (h.rectificationHistory && h.rectificationHistory.length) totalRect += h.rectificationHistory.length;
    else if (str(h.rectificationNote)) totalRect += 1;
    if (h.rejectionHistory && h.rejectionHistory.length) totalRej += h.rejectionHistory.length;
    else if (str(h.rejectionNote)) totalRej += 1;
  });

  const sections = list.map((h, idx) => {
    const lr = latestRect(h);
    const metaRows = [
      ['问题编号', idOf(h)], ['问题类型', str(h.category)], ['严重程度', severityName(h.severity)],
      ['所属部门', str(h.department)], ['上报人', str(h.reporterName)], ['整改责任人', str(h.assigneeName)],
      ['问题位置', str(h.location)], ['当前状态', statusName(h.status)],
      ['整改截止', dateOnly(h.dueDate || h.deadline)], ['创建时间', dateTime(h.createdAt)],
      ['更新时间', dateTime(h.updatedAt)], ['完成时间', dateTime(h.closedAt)]
    ].map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');

    const rectBlocks = (h.rectificationHistory && h.rectificationHistory.length)
      ? h.rectificationHistory.map((r, i) => `
        <div class="sub">
          <b>第${i + 1}次整改 · ${escapeHtml(r.submitterName || h.assigneeName || '整改人')} · ${escapeHtml(dateTime(r.timestamp))}</b>
          <div class="muted">${escapeHtml(r.description)}</div>
          ${photoImgs(r.photos, '整改照片')}
        </div>`).join('')
      : (str(h.rectificationNote) ? `<div class="sub"><b>整改反馈</b><div class="muted">${escapeHtml(h.rectificationNote)}</div>${photoImgs(h.rectificationPhotos, '整改照片')}</div>` : '<div class="muted">暂无整改记录</div>');

    const rejBlocks = (h.rejectionHistory && h.rejectionHistory.length)
      ? h.rejectionHistory.map((r, i) => `<div class="sub rej"><b>第${i + 1}次驳回 · ${escapeHtml(r.reviewerName || '验收人')} · ${escapeHtml(dateTime(r.timestamp))}</b><div class="muted">${escapeHtml(r.note)}</div></div>`).join('')
      : (str(h.rejectionNote) ? `<div class="sub rej"><b>驳回意见</b><div class="muted">${escapeHtml(h.rejectionNote)}</div></div>` : '<div class="muted">暂无驳回记录</div>');

    return `
    <section class="issue">
      <h2>${idx + 1}. ${escapeHtml(str(h.title) || str(h.description).slice(0, 24) || '未命名问题')}</h2>
      <table class="meta">${metaRows}</table>
      <div class="field"><b>问题描述：</b>${escapeHtml(h.description)}</div>
      ${h.acceptanceNote ? `<div class="field"><b>验收意见：</b>${escapeHtml(h.acceptanceNote)}</div>` : ''}
      ${lr.note ? `<div class="field"><b>最新整改反馈：</b>${escapeHtml(lr.note)}${lr.time ? '（' + escapeHtml(lr.time) + '）' : ''}</div>` : ''}
      ${photoImgs(h.photos, '现场照片')}
      <h3>整改记录</h3>${rectBlocks}
      <h3>驳回记录</h3>${rejBlocks}
    </section>`;
  }).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: "Microsoft YaHei","SimSun",sans-serif; color:#1f2d28; margin:24px; font-size:13px; }
    h1 { font-size:20px; border-bottom:3px solid #1f8a4c; padding-bottom:8px; }
    .subtitle { color:#666; margin:6px 0 18px; }
    .summary { width:100%; border-collapse:collapse; margin-bottom:18px; }
    .summary td { border:1px solid #d6e4dd; padding:8px 12px; }
    .summary td.k { background:#eef6f0; font-weight:bold; width:160px; }
    .issue { border:1px solid #d6e4dd; border-radius:8px; padding:14px 16px; margin-bottom:16px; page-break-inside:avoid; }
    .issue h2 { font-size:15px; margin:0 0 10px; color:#0f5a32; }
    .issue h3 { font-size:13px; margin:14px 0 6px; color:#1f8a4c; border-left:4px solid #1f8a4c; padding-left:8px; }
    table.meta { border-collapse:collapse; width:100%; margin-bottom:8px; }
    table.meta th, table.meta td { border:1px solid #e3ece7; padding:5px 8px; text-align:left; vertical-align:top; }
    table.meta th { background:#f4f9f6; width:110px; font-weight:bold; }
    .field { margin:6px 0; }
    .sub { border-top:1px dashed #e3ece7; padding-top:6px; margin-top:6px; }
    .sub.rej { background:#fdf0f0; padding:6px 8px; border-radius:6px; }
    .muted { color:#666; font-size:12px; margin:4px 0; }
    .photos { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
    .photos img { width:150px; height:150px; object-fit:cover; border:1px solid #ddd; border-radius:4px; }
  </style></head><body>
    <h1>GZ 环保巡查整改管理报告</h1>
    <div class="subtitle">统计范围：${escapeHtml((meta && meta.period) || '全部数据')} ｜ 生成时间：${escapeHtml(dateTime(meta && meta.generatedAt))} ｜ 导出人：${escapeHtml((meta && meta.exportUser) || '管理员')}</div>
    <table class="summary">
      <tr><td class="k">问题总数</td><td>${list.length}</td><td class="k">已完成</td><td>${closed}（${closedRate}）</td></tr>
      <tr><td class="k">待处理</td><td>${pending}</td><td class="k">整改中/待验收</td><td>${processing + reviewing}</td></tr>
      <tr><td class="k">已超期未整改</td><td>${overdue}</td><td class="k">累计整改/驳回记录</td><td>${totalRect} / ${totalRej}</td></tr>
    </table>
    ${sections}
  </body></html>`;
}
