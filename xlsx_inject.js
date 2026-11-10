// xlsx 增强注入器（主进程专用，CommonJS，仅依赖 Node 内置 zlib）
//
// 背景：项目使用的 SheetJS 社区版（app/vendor/xlsx.full.min.js，0.18.5）只能"写数据"，
// 不支持以下能力（实测确认）：
//   · 单元格样式（font/fill/border/alignment）—— 社区版 write 时会被丢弃
//   · 冻结窗格（!freeze 不生效）
//   · 打印区域 / 页眉页脚
//   · 内嵌图片
// 因此本模块在 SheetJS 产出的 xlsx（本质是 ZIP）之上做一次"部件注入"：
//   1. 解开 ZIP，取出 sheetData（数据部分仍完全由 SheetJS 生成，字段名/结构零改动）
//   2. 重建 styles.xml，并按规则给 <c> 打上 s="N" 样式索引
//   3. 写入 xl/media/* 图片 + xl/drawings/* 锚定到单元格
//   4. 补冻结窗格、打印区域、页眉页脚、列宽行高、合并单元格
//   5. 重新打包成 ZIP
//
// 这样既保留了 SheetJS 的数据生成，又让成品在 Excel / WPS 中都有完整排版。
//
// 依赖说明：electron-builder 的 files 只打包 main.js/preload.js/static_server.js/app/**，
// 运行时没有 node_modules，故这里不引入任何第三方库，ZIP 读写全部基于 zlib 自行实现。

const zlib = require('zlib');

// ============================================================
// CRC32（ZIP 必需）
// ============================================================
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

// ============================================================
// 最小 ZIP 读 / 写
// ============================================================
const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function readZip(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let eocd = -1;
  const floor = Math.max(0, b.length - 65558);
  for (let i = b.length - 22; i >= floor; i--) {
    if (b.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（ZIP）文件：未找到结束记录');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== SIG_CEN) break;
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    if (csize === 0xFFFFFFFF) throw new Error('暂不支持 ZIP64 条目：' + name);
    const lnlen = b.readUInt16LE(lho + 26);
    const lelen = b.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    let data = b.slice(start, start + csize);
    if (method === 8) data = zlib.inflateRawSync(data);
    else if (method !== 0) throw new Error('不支持的压缩方法 ' + method + '：' + name);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOC, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CEN, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);

    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// ============================================================
// 样式表：索引常量（与 buildStylesXml 中的 cellXfs 顺序一一对应）
// ============================================================
const S = {
  DEFAULT: 0,
  TITLE: 1,
  SUBTITLE: 2,
  HEADER: 3,
  TEXT: 4,
  CENTER: 5,
  SEV_LOW: 6,
  SEV_MID: 7,
  SEV_HIGH: 8,
  ST_PENDING: 9,
  ST_PROCESSING: 10,
  ST_REVIEWING: 11,
  ST_CLOSED: 12,
  PLACEHOLDER: 13,
  STAT_LABEL: 14,
  STAT_VALUE: 15,
  SECTION: 16
};

const SEVERITY_STYLE = { 一般: S.SEV_LOW, 较大: S.SEV_MID, 重大: S.SEV_HIGH };
const STATUS_STYLE = {
  待处理: S.ST_PENDING, 整改中: S.ST_PROCESSING,
  待验收: S.ST_REVIEWING, 已关闭: S.ST_CLOSED
};

const FONT_SPEC = [
  '<font><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/></font>',                                   // 0 默认
  '<font><b/><sz val="16"/><color rgb="FF0F5A32"/><name val="微软雅黑"/></font>',                                        // 1 台账标题
  '<font><sz val="10"/><color rgb="FF555555"/><name val="微软雅黑"/></font>',                                            // 2 副标题/导出信息
  '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>',                                        // 3 表头
  '<font><sz val="10"/><color rgb="FF1A1A1A"/><name val="宋体"/></font>',                                                // 4 正文
  '<font><sz val="10"/><color rgb="FF999999"/><name val="宋体"/></font>',                                                // 5 占位（无图片）
  '<font><b/><sz val="11"/><color rgb="FF0F5A32"/><name val="微软雅黑"/></font>',                                        // 6 分组小标题
  '<font><b/><sz val="10"/><color rgb="FF1A1A1A"/><name val="宋体"/></font>'                                             // 7 统计项名
];

const FILL_SPEC = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F8A4C"/><bgColor indexed="64"/></patternFill></fill>',        // 2 表头绿
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>',        // 3 等级-一般
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/><bgColor indexed="64"/></patternFill></fill>',        // 4 等级-较大
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>',        // 5 等级-重大
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>',        // 6 状态-待处理
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill>',        // 7 状态-整改中
  '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>',        // 8 状态-待验收
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill>',        // 9 状态-已关闭
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF3EE"/><bgColor indexed="64"/></patternFill></fill>',        // 10 副标题底
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>'         // 11 统计项名底
];

const BORDER_NONE = '<border><left/><right/><top/><bottom/><diagonal/></border>';
const BORDER_THIN = (() => {
  const c = 'rgb="FFB7C4BC"';
  return `<border><left style="thin"><color ${c}/></left><right style="thin"><color ${c}/></right>` +
    `<top style="thin"><color ${c}/></top><bottom style="thin"><color ${c}/></bottom><diagonal/></border>`;
})();

// [fontId, fillId, borderId, alignmentXml]
const XF_SPEC = [
  [0, 0, 0, ''],
  [1, 0, 0, '<alignment horizontal="center" vertical="center"/>'],
  [2, 10, 0, '<alignment horizontal="left" vertical="center"/>'],
  [3, 2, 1, '<alignment horizontal="center" vertical="center" wrapText="1"/>'],
  [4, 0, 1, '<alignment horizontal="left" vertical="top" wrapText="1"/>'],
  [4, 0, 1, '<alignment horizontal="center" vertical="center" wrapText="1"/>'],
  [4, 3, 1, '<alignment horizontal="center" vertical="center"/>'],
  [4, 4, 1, '<alignment horizontal="center" vertical="center"/>'],
  [4, 5, 1, '<alignment horizontal="center" vertical="center"/>'],
  [4, 6, 1, '<alignment horizontal="center" vertical="center"/>'],
  [4, 7, 1, '<alignment horizontal="center" vertical="center"/>'],
  [4, 8, 1, '<alignment horizontal="center" vertical="center"/>'],
  [4, 9, 1, '<alignment horizontal="center" vertical="center"/>'],
  [5, 0, 1, '<alignment horizontal="center" vertical="center"/>'],
  [7, 11, 1, '<alignment horizontal="left" vertical="center"/>'],
  [4, 0, 1, '<alignment horizontal="left" vertical="center"/>'],
  [6, 10, 0, '<alignment horizontal="left" vertical="center"/>']
];

function buildStylesXml() {
  const xfs = XF_SPEC.map(([f, fl, b, al]) => {
    const apply = `applyFont="1" applyFill="1" applyBorder="1"` + (al ? ' applyAlignment="1"' : '');
    return `<xf numFmtId="0" fontId="${f}" fillId="${fl}" borderId="${b}" xfId="0" ${apply}>${al}</xf>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<fonts count="${FONT_SPEC.length}">${FONT_SPEC.join('')}</fonts>` +
    `<fills count="${FILL_SPEC.length}">${FILL_SPEC.join('')}</fills>` +
    `<borders count="2">${BORDER_NONE}${BORDER_THIN}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${XF_SPEC.length}">${xfs}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

// ============================================================
// 单元格 / 行处理
// ============================================================
function colLetterToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function indexToColLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// 给 sheetData 内所有 <c> 打样式，并给 <row> 设置行高
function decorateSheetData(xml, ctx) {
  const { rowHeight, styleOf } = ctx;

  // 1) 行级：补 ht / customHeight
  xml = xml.replace(/<row\b([^>]*?)(\/?)>/g, (m, attrs, selfClose) => {
    const rm = /r="(\d+)"/.exec(attrs);
    if (!rm) return m;
    const r = parseInt(rm[1], 10) - 1;
    const h = rowHeight(r);
    if (!h) return m;
    let a = attrs.replace(/\s*(ht|customHeight)="[^"]*"/g, '');
    return `<row${a} ht="${h}" customHeight="1"${selfClose}>`;
  });

  // 2) 单元格级：加 s="N"
  xml = xml.replace(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g, (m, selfAttrs, openAttrs, inner) => {
    const isSelf = selfAttrs !== undefined;
    const attrs = isSelf ? selfAttrs : openAttrs;
    const rm = /r="([A-Z]+)(\d+)"/.exec(attrs);
    if (!rm) return m;
    const col = colLetterToIndex(rm[1]);
    const row = parseInt(rm[2], 10) - 1;
    const st = styleOf(row, col);
    if (st == null || st === S.DEFAULT) return m;
    const a = attrs.replace(/\s*s="[^"]*"/g, '') + ` s="${st}"`;
    return isSelf ? `<c${a}/>` : `<c${a}>${inner}</c>`;
  });

  return xml;
}

function styleForCell(row, col, sheet) {
  const role = sheet.rowRole && sheet.rowRole[String(row)];
  if (role === 'title') return S.TITLE;
  if (role === 'subtitle') return S.SUBTITLE;
  if (role === 'section') return S.SECTION;
  if (role === 'statLabel') return S.STAT_LABEL;
  if (role === 'statValue') return S.STAT_VALUE;
  if (role === 'header') return S.HEADER;
  if (role === 'blank') return null;

  // 语义列（隐患等级 / 整改状态）：按该行对应文本着色
  const cr = sheet.colRole || {};
  const kind = cr[String(col)];
  if (kind === 'statLabel') return S.STAT_LABEL;
  if (kind === 'statValue') return S.STAT_VALUE;
  if (kind === 'severity') {
    const text = (sheet.sevText || {})[String(row)];
    return SEVERITY_STYLE[text] != null ? SEVERITY_STYLE[text] : S.CENTER;
  }
  if (kind === 'status') {
    const text = (sheet.stText || {})[String(row)];
    return STATUS_STYLE[text] != null ? STATUS_STYLE[text] : S.CENTER;
  }

  // 图片列：图片占位
  if (sheet.imageCols && sheet.imageCols.indexOf(col) !== -1) {
    const has = sheet.imageAt && sheet.imageAt[row + ',' + col];
    return has ? null : S.PLACEHOLDER;
  }

  // 默认正文：短字段居中，长文本左对齐
  if (sheet.centerCols && sheet.centerCols.indexOf(col) !== -1) return S.CENTER;
  return S.TEXT;
}

// ============================================================
// 工作表 XML 重建
// ============================================================
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 页眉页脚专用转义：保留 &P / &N / &D / &T 等页码日期控制码（Excel/WPS 会解析）
function escHF(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSheetXml(sheetDataXml, sheet) {
  const colCount = sheet.colCount;
  const rowCount = sheet.rowCount;
  const dim = `A1:${indexToColLetter(colCount - 1)}${rowCount}`;

  const cols = (sheet.widths || []).map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');

  // 冻结窗格：冻结前 N 行（顶部标题 + 表头）
  let pane = '';
  if (sheet.freezeRows > 0) {
    pane = `<pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${sheet.freezeRows + 1}" sqref="A${sheet.freezeRows + 1}"/>`;
  } else {
    pane = '<selection activeCell="A1" sqref="A1"/>';
  }

  const merges = (sheet.merges || []).map((m) =>
    `<mergeCell ref="${indexToColLetter(m.s[1])}${m.s[0] + 1}:${indexToColLetter(m.e[1])}${m.e[0] + 1}"/>`).join('');

  const hf = sheet.headerFooter || {};
  const headerFooter =
    `<headerFooter differentFirst="0" differentOddEven="0">` +
    `<oddHeader>&amp;L${escHF(hf.left || '')}&amp;C${escHF(hf.center || '')}&amp;R${escHF(hf.right || '')}</oddHeader>` +
    `<oddFooter>&amp;L${escHF(hf.footerLeft || '')}&amp;C${escHF(hf.footerCenter || '')}&amp;R${escHF(hf.footerRight || '')}</oddFooter>` +
    `</headerFooter>`;

  const autoFilter = sheet.autoFilterRef ? `<autoFilter ref="${sheet.autoFilterRef}"/>` : '';
  const drawing = sheet.drawingId ? `<drawing r:id="${sheet.drawingId}"/>` : '';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="${dim}"/>` +
    `<sheetViews><sheetView tabSelected="1" workbookViewId="0"${sheet.showGridLines === false ? ' showGridLines="0"' : ''}>${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="16"/>' +
    `<cols>${cols}</cols>` +
    sheetDataXml +
    autoFilter +
    (merges ? `<mergeCells count="${(sheet.merges || []).length}">${merges}</mergeCells>` : '') +
    '<printOptions horizontalCentered="1"/>' +
    '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    `<pageSetup orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0" paperSize="9"/>` +
    headerFooter +
    drawing +
    '</worksheet>';
}

// ============================================================
// Drawing（图片锚定）
// ============================================================
const EMU_PER_PX = 9525;

function buildDrawingXml(images) {
  const anchors = images.map((im, i) => {
    const cx = Math.round(im.wPx * EMU_PER_PX);
    const cy = Math.round(im.hPx * EMU_PER_PX);
    return `<xdr:oneCellAnchor>` +
      `<xdr:from><xdr:col>${im.col}</xdr:col><xdr:colOff>${im.padEmu || 38100}</xdr:colOff>` +
      `<xdr:row>${im.row}</xdr:row><xdr:rowOff>${im.padEmu || 38100}</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${cx}" cy="${cy}"/>` +
      `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="照片 ${i + 1}"/>` +
      `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${im.rid}"/>` +
      `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `<a:ln><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></xdr:spPr></xdr:pic>` +
      `<xdr:clientData/></xdr:oneCellAnchor>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    anchors + '</xdr:wsDr>';
}

function buildRelsXml(rels) {
  const items = rels.map((r) =>
    `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"${r.mode ? ` TargetMode="${r.mode}"` : ''}/>`
  ).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    items + '</Relationships>';
}

const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

function nextRid(relsXml) {
  let max = 0;
  const re = /Id="rId(\d+)"/g;
  let m;
  while ((m = re.exec(relsXml))) max = Math.max(max, parseInt(m[1], 10));
  return `rId${max + 1}`;
}

// ============================================================
// 主入口
// ============================================================
function enhanceXlsx(buffer, plan) {
  const zip = readZip(buffer);
  const media = plan.media || [];

  // 1) 写入图片部件
  media.forEach((m, i) => {
    const data = Buffer.isBuffer(m.data) ? m.data
      : Buffer.from(String(m.base64 || '').replace(/^data:[^;]*;base64,/, ''), 'base64');
    zip.set(`xl/media/${m.name || ('image' + (i + 1) + '.png')}`, data);
  });

  // 2) 覆盖样式表
  zip.set('xl/styles.xml', Buffer.from(buildStylesXml(), 'utf8'));

  // 3) 逐表重建
  let drawingSeq = 0;
  const printAreas = [];

  (plan.sheets || []).forEach((sheet) => {
    const file = sheet.file;
    const src = zip.get(file);
    if (!src) return;
    const xml = src.toString('utf8');

    const sdMatch = /<sheetData[\s\S]*?<\/sheetData>/.exec(xml);
    if (!sdMatch) return;
    let sheetData = sdMatch[0];

    // 统计真实行数（取 <row r="N"> 最大值，至少用 rowCount）
    let maxRow = 0;
    const rowRe = /<row\b[^>]*?\br="(\d+)"/g;
    let rm;
    while ((rm = rowRe.exec(xml))) maxRow = Math.max(maxRow, parseInt(rm[1], 10));
    const rowCount = Math.max(sheet.rowCount || 0, maxRow);

    const imageAt = {};
    (sheet.images || []).forEach((im) => { imageAt[im.row + ',' + im.col] = true; });

    const cfg = Object.assign({}, sheet, { rowCount, imageAt });
    sheetData = decorateSheetData(sheetData, {
      rowHeight: (r) => (sheet.rowHeights || {})[String(r)],
      styleOf: (r, c) => styleForCell(r, c, cfg)
    });

    // drawing
    let drawingId = '';
    if (sheet.images && sheet.images.length) {
      drawingSeq++;
      const dName = `xl/drawings/drawing${drawingSeq}.xml`;
      const relsName = `xl/drawings/_rels/drawing${drawingSeq}.xml.rels`;
      const images = sheet.images.map((im, i) => Object.assign({}, im, { rid: i + 1 }));
      zip.set(dName, Buffer.from(buildDrawingXml(images), 'utf8'));
      zip.set(relsName, Buffer.from(buildRelsXml(images.map((im, i) => ({
        id: `rId${i + 1}`, type: REL_IMAGE,
        target: `../media/${(media[im.media] || {}).name || ('image' + (im.media + 1) + '.png')}`
      }))), 'utf8'));

      const relFile = file.replace('xl/worksheets/', 'xl/worksheets/_rels/').replace('.xml', '.xml.rels');
      let relsXml = zip.has(relFile) ? zip.get(relFile).toString('utf8') : buildRelsXml([]);
      drawingId = nextRid(relsXml);
      relsXml = relsXml.replace('</Relationships>',
        `<Relationship Id="${drawingId}" Type="${REL_DRAWING}" Target="../drawings/drawing${drawingSeq}.xml"/></Relationships>`);
      zip.set(relFile, Buffer.from(relsXml, 'utf8'));

      // Content_Types 追加 drawing 部件
      addOverride(zip, `/xl/drawings/drawing${drawingSeq}.xml`,
        'application/vnd.openxmlformats-officedocument.drawing+xml');
    }

    zip.set(file, Buffer.from(buildSheetXml(sheetData, Object.assign({}, cfg, { drawingId, rowCount })), 'utf8'));

    if (sheet.printArea) {
      printAreas.push({
        sheetName: sheet.name,
        ref: sheet.printArea,
        localSheetId: sheet.localSheetId != null ? sheet.localSheetId : (plan.sheets.indexOf(sheet))
      });
    }
  });

  // 4) Content_Types：图片扩展名
  if (media.length) {
    const ctFile = '[Content_Types].xml';
    let ct = zip.get(ctFile).toString('utf8');
    const exts = new Set(media.map((m) => {
      const n = (m.name || 'image.png').toLowerCase();
      return n.endsWith('.jpg') || n.endsWith('.jpeg') ? 'jpeg' : n.endsWith('.gif') ? 'gif' : 'png';
    }));
    for (const ext of exts) {
      if (!ct.includes(`Extension="${ext}"`)) {
        ct = ct.replace('</Types>', `<Default Extension="${ext}" ContentType="image/${ext}"/></Types>`);
      }
    }
    zip.set(ctFile, Buffer.from(ct, 'utf8'));
  }

  // 5) workbook.xml：打印区域
  if (printAreas.length) {
    const wbXml = zip.get('xl/workbook.xml').toString('utf8');
    const dn = printAreas.map((p) =>
      `<definedName name="_xlnm.Print_Area" localSheetId="${p.localSheetId}">'${p.sheetName}'!${p.ref}</definedName>`).join('');
    const updated = wbXml.includes('</sheets>')
      ? wbXml.replace('</sheets>', `</sheets><definedNames>${dn}</definedNames>`)
      : wbXml.replace('</workbook>', `<definedNames>${dn}</definedNames></workbook>`);
    zip.set('xl/workbook.xml', Buffer.from(updated, 'utf8'));
  }

  // 6) 重新打包（[Content_Types].xml 置于首位，兼容严格一点的解析器）
  const names = [...zip.keys()];
  names.sort((a, b) => {
    if (a === '[Content_Types].xml') return -1;
    if (b === '[Content_Types].xml') return 1;
    if (a === '_rels/.rels') return -1;
    if (b === '_rels/.rels') return 1;
    return 0;
  });
  return writeZip(names.map((n) => ({ name: n, data: zip.get(n) })));
}

function addOverride(zip, partName, contentType) {
  const ctFile = '[Content_Types].xml';
  let ct = zip.get(ctFile).toString('utf8');
  if (ct.includes(`PartName="${partName}"`)) return;
  ct = ct.replace('</Types>', `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`);
  zip.set(ctFile, Buffer.from(ct, 'utf8'));
}

module.exports = { enhanceXlsx, readZip, writeZip, crc32, S };
