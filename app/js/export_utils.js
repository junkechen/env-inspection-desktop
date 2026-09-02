// 导出工具：纯函数，不依赖浏览器全局，便于在 Node 下单元测试。
// - buildExcelWorkbook(XLSX, issues, meta)：生成 4 个 sheet 的台账工作簿（与 APK 一致）
// - buildPdfHtml(issues, meta)：生成图文报告 HTML（供主进程 printToPDF）
//
// 字段映射以 EXE（即云端）数据结构为准：
//   category 已存中文（废水排放…）；severity/status 存枚举，需转中文。
//   id 取 _id 或 id；照片在 photos / rectificationPhotos / rectificationHistory[].photos。

const STATUS_NAME = { pending: '待处理', processing: '整改中', reviewing: '待验收', closed: '已关闭', deleted: '已删除' };
const SEVERITY_NAME = { general: '一般', serious: '较重', critical: '严重' };

function statusName(s) { return STATUS_NAME[s] || s || '—'; }
function severityName(s) { return SEVERITY_NAME[s] || s || '一般'; }
function str(v) { return v == null ? '' : String(v); }
function idOf(h) { return str(h._id || h.id); }
function dateOnly(v) { return (str(v).slice(0, 10)) || ''; }
function dateTime(v) { return (str(v).slice(0, 19).replace('T', ' ')) || ''; }

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

// 把照片 URL 列表写入某行的照片列（超链接），与 APK 行为一致
function writePhotoLinks(ws, XLSX, rowIdx, startCol, photoUrls, maxPhotos) {
  for (let i = 0; i < maxPhotos; i++) {
    const ref = XLSX.utils.encode_cell({ r: rowIdx, c: startCol + i });
    if (i < photoUrls.length && photoUrls[i] && /^https?:\/\//.test(photoUrls[i])) {
      const url = photoUrls[i].replace(/"/g, '""');
      ws[ref] = { t: 's', v: '照片' + (i + 1) };
      ws[ref].l = { Target: url, Tooltip: '照片' + (i + 1) };
      ws[ref].s = { font: { color: { rgb: '0563C1' }, underline: true } };
    } else {
      ws[ref] = { t: 's', v: (i < photoUrls.length ? '(链接失效)' : '') };
      if (i < photoUrls.length) ws[ref].s = { font: { color: { rgb: '999999' } } };
    }
  }
}

function headerStyle(XLSX, hex) {
  return { font: { bold: true }, fill: { fgColor: { rgb: hex.replace('#', '') } } };
}

export function buildExcelWorkbook(XLSX, issues, meta) {
  const list = Array.isArray(issues) ? issues : [];
  const now = meta && meta.generatedAt ? new Date(meta.generatedAt) : new Date();

  // 预统计最大照片数（动态列头，与 APK 一致，限制 1..6）
  let maxIssuePics = 1, maxRectPics = 1;
  for (const h of list) {
    const ip = (h.photos || []).length;
    if (ip > maxIssuePics) maxIssuePics = Math.min(ip, 6);
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
  const picHeaders1 = Array.from({ length: maxIssuePics }, (_, i) => '问题照片' + (i + 1));
  const headers1 = [...headers1Base, ...picHeaders1];

  const sheet1 = XLSX.utils.aoa_to_sheet([headers1]);
  for (let c = 0; c < headers1.length; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    sheet1[ref].s = headerStyle(XLSX, '#D9EAD3');
  }
  list.forEach((h, idx) => {
    const lr = latestRect(h);
    const rowBase = [
      idx + 1, idOf(h), str(h.title) || str(h.description).slice(0, 24), str(h.description),
      str(h.location), str(h.category), severityName(h.severity), str(h.department),
      str(h.reporterName), str(h.assigneeName), dateOnly(h.dueDate || h.deadline),
      statusName(h.status), lr.note, lr.time, str(h.acceptanceNote), dateTime(h.closedAt),
      rectPicCount(h), rejectionCount(h), dateTime(h.createdAt), dateTime(h.updatedAt)
    ];
    const rowIdx = idx + 1;
    const aoaRow = [...rowBase, ...Array(maxIssuePics).fill('')];
    XLSX.utils.sheet_add_aoa(sheet1, [aoaRow], { origin: { r: rowIdx, c: 0 } });
    writePhotoLinks(sheet1, XLSX, rowIdx, rowBase.length, (h.photos || []), maxIssuePics);
  });
  sheet1['!cols'] = headers1.map((h, i) => ({ wch: i === 2 || i === 3 ? 28 : 14 }));
  XLSX.utils.book_append_sheet(wb, sheet1, '问题闭环台账');

  // ---------- 工作表2：整改过程记录 ----------
  const headers2Base = ['序号', '问题编号', '问题标题', '所属部门', '整改责任人', '整改次数', '整改时间', '整改反馈内容', '整改照片数量'];
  const picHeaders2 = Array.from({ length: maxRectPics }, (_, i) => '整改照片' + (i + 1));
  const headers2 = [...headers2Base, ...picHeaders2];
  const sheet2 = XLSX.utils.aoa_to_sheet([headers2]);
  for (let c = 0; c < headers2.length; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    sheet2[ref].s = headerStyle(XLSX, '#CFE2F3');
  }
  let rectSeq = 0, rectRow = 1;
  list.forEach((h) => {
    if (h.rectificationHistory && h.rectificationHistory.length) {
      h.rectificationHistory.forEach((r, i) => {
        rectSeq++;
        const rowBase = [
          rectSeq, idOf(h), str(h.title), str(h.department),
          str(r.submitterName) || str(h.assigneeName), i + 1, dateTime(r.timestamp),
          str(r.description), (r.photos || []).length
        ];
        const aoaRow = [...rowBase, ...Array(maxRectPics).fill('')];
        XLSX.utils.sheet_add_aoa(sheet2, [aoaRow], { origin: { r: rectRow, c: 0 } });
        writePhotoLinks(sheet2, XLSX, rectRow, rowBase.length, (r.photos || []), maxRectPics);
        rectRow++;
      });
    } else if (str(h.rectificationNote)) {
      rectSeq++;
      const rowBase = [rectSeq, idOf(h), str(h.title), str(h.department), str(h.assigneeName), 1, dateTime(h.updatedAt), str(h.rectificationNote), (h.rectificationPhotos || []).length];
      const aoaRow = [...rowBase, ...Array(maxRectPics).fill('')];
      XLSX.utils.sheet_add_aoa(sheet2, [aoaRow], { origin: { r: rectRow, c: 0 } });
      writePhotoLinks(sheet2, XLSX, rectRow, rowBase.length, (h.rectificationPhotos || []), maxRectPics);
      rectRow++;
    }
  });
  XLSX.utils.book_append_sheet(wb, sheet2, '整改过程记录');

  // ---------- 工作表3：驳回记录 ----------
  const headers3 = ['序号', '问题编号', '问题标题', '所属部门', '整改责任人', '驳回次数', '驳回时间', '驳回人', '驳回意见'];
  const sheet3 = XLSX.utils.aoa_to_sheet([headers3]);
  for (let c = 0; c < headers3.length; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    sheet3[ref].s = headerStyle(XLSX, '#FCE5CD');
  }
  let rejSeq = 0, rejRow = 1;
  list.forEach((h) => {
    if (h.rejectionHistory && h.rejectionHistory.length) {
      h.rejectionHistory.forEach((r, i) => {
        rejSeq++;
        const row = [rejSeq, idOf(h), str(h.title), str(h.department), str(h.assigneeName), i + 1, dateTime(r.timestamp), str(r.reviewerName), str(r.note)];
        XLSX.utils.sheet_add_aoa(sheet3, [row], { origin: { r: rejRow, c: 0 } });
        rejRow++;
      });
    } else if (str(h.rejectionNote)) {
      rejSeq++;
      const row = [rejSeq, idOf(h), str(h.title), str(h.department), str(h.assigneeName), 1, dateTime(h.updatedAt), str(h.reporterName), str(h.rejectionNote)];
      XLSX.utils.sheet_add_aoa(sheet3, [row], { origin: { r: rejRow, c: 0 } });
      rejRow++;
    }
  });
  XLSX.utils.book_append_sheet(wb, sheet3, '驳回记录');

  // ---------- 工作表4：统计汇总 ----------
  const sheet4 = XLSX.utils.aoa_to_sheet([['']]);
  const setCell = (col, row, text, bold) => {
    const ref = XLSX.utils.encode_cell({ r: row, c: col });
    sheet4[ref] = { t: 's', v: str(text) };
    if (bold) sheet4[ref].s = { font: { bold: true } };
  };
  const closed = list.filter((h) => h.status === 'closed').length;
  const processing = list.filter((h) => h.status === 'processing').length;
  const pending = list.filter((h) => h.status === 'pending').length;
  const reviewing = list.filter((h) => h.status === 'reviewing').length;
  const overdue = list.filter((h) => h.status === 'pending' && h.dueDate && new Date(h.dueDate).getTime() < now.getTime()).length;
  const closedRate = list.length ? ((closed / list.length) * 100).toFixed(1) + '%' : '0.0%';

  setCell(0, 0, 'GZ 环保巡查整改管理统计报表', true);
  setCell(0, 1, '统计范围:'); setCell(1, 1, (meta && meta.period) || '全部数据');
  setCell(0, 2, '生成时间:'); setCell(1, 2, dateTime(meta && meta.generatedAt));
  setCell(0, 3, '导出人:'); setCell(1, 3, (meta && meta.exportUser) || '管理员');

  setCell(0, 5, '【总体统计】', true);
  const summary = [
    ['问题总数', list.length], ['已完成', closed], ['完成率', closedRate],
    ['待处理', pending], ['整改中/待验收', processing + reviewing], ['已超期未整改', overdue],
    ['累计整改记录数', rectSeq], ['累计驳回记录数', rejSeq]
  ];
  summary.forEach((kv, i) => { setCell(0, 6 + i, kv[0]); setCell(1, 6 + i, kv[1]); });

  let r = 6 + summary.length + 1;
  setCell(0, r, '【问题类型分布】', true); r++;
  const catCount = {};
  list.forEach((h) => { const k = str(h.category) || '其他'; catCount[k] = (catCount[k] || 0) + 1; });
  Object.entries(catCount).forEach(([k, v]) => { setCell(0, r, k); setCell(1, r, v); r++; });

  r += 1;
  setCell(0, r, '【部门问题统计】', true); r++;
  const deptCount = {};
  list.forEach((h) => { const k = str(h.department) || '未分配'; deptCount[k] = (deptCount[k] || 0) + 1; });
  Object.entries(deptCount).forEach(([k, v]) => { setCell(0, r, k); setCell(1, r, v); r++; });

  XLSX.utils.book_append_sheet(wb, sheet4, '统计汇总');

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
