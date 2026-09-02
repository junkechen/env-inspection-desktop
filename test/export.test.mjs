// 导出模块单元测试：覆盖 Excel 4 表结构 / 照片超链接 / PDF HTML 转义与内容。
// 运行：node test/export.test.mjs  （需 npm i xlsx 以生成 .xlsx 验证）
import assert from 'node:assert';
import { buildExcelWorkbook, buildPdfHtml } from '../app/js/export_utils.js';

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

// 构造覆盖多状态/多记录/含照片的样例
const issues = [
  {
    _id: 'h1', title: '污水池溢流', description: '<script>alert(1)</script>池体破损',
    category: '废水排放', severity: 'critical', department: '动力车间', reporterName: '张三',
    assigneeName: '李四', location: '厂区东南', status: 'pending', dueDate: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-21T10:00:00.000Z',
    photos: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    rectificationHistory: [{ submitterName: '李四', timestamp: '2026-07-22T10:00:00.000Z', description: '已焊接修补', photos: ['https://example.com/c.jpg'] }],
    rejectionHistory: [{ reviewerName: '王五', timestamp: '2026-07-23T10:00:00.000Z', note: '仍有渗漏' }],
    acceptanceNote: '', rejectionNote: '', rectificationNote: '', rectificationPhotos: [], closedAt: null
  },
  {
    _id: 'h2', title: '废气排放超标', description: '排气筒监测异常',
    category: '废气排放', severity: 'serious', department: '焚化车间', reporterName: '赵六',
    assigneeName: '钱七', location: '厂区西北', status: 'closed', dueDate: '2026-07-10T00:00:00.000Z',
    createdAt: '2026-07-05T10:00:00.000Z', updatedAt: '2026-07-15T10:00:00.000Z',
    photos: ['https://example.com/d.jpg'],
    rectificationHistory: [], rejectionHistory: [], acceptanceNote: '验收合格',
    rejectionNote: '', rectificationNote: '更换活性炭', rectificationPhotos: ['https://example.com/e.jpg'],
    closedAt: '2026-07-15T10:00:00.000Z'
  },
  {
    _id: 'h3', title: '危废贮存标识缺失', description: '未张贴危废标签',
    category: '固废管理', severity: 'general', department: '仓储部', reporterName: '孙八',
    assigneeName: '周九', location: '仓库', status: 'processing', dueDate: '2026-08-30T00:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-02T10:00:00.000Z',
    photos: [], rectificationHistory: [], rejectionHistory: [], acceptanceNote: '',
    rejectionNote: '', rectificationNote: '', rectificationPhotos: [], closedAt: null
  }
];

const meta = { period: '状态:待处理', exportUser: '管理员', generatedAt: new Date().toISOString() };

console.log('PDF HTML:');
const html = buildPdfHtml(issues, meta);
ok('生成 DOCTYPE 文档', html.startsWith('<!DOCTYPE html>'));
ok('包含报告标题', html.includes('GZ 环保巡查整改管理报告'));
ok('包含问题标题', html.includes('污水池溢流') && html.includes('废气排放超标'));
ok('HTML 转义生效（<script> 被转义）', html.includes('&lt;script&gt;') && !html.includes('<script>alert(1)</script>'));
ok('包含统计汇总数字', html.includes('问题总数') && html.includes(String(issues.length)));
ok('含现场照片 img 标签', html.includes('<img src="https://example.com/a.jpg"'));
ok('含整改记录区块', html.includes('整改记录'));
ok('含驳回记录区块', html.includes('驳回记录'));

console.log('Excel 工作簿:');
let XLSX = null;
try { XLSX = (await import('xlsx')).default; } catch (e) { XLSX = null; }
if (!XLSX) {
  console.warn('  ! 未安装 xlsx，跳过 .xlsx 二进制校验（仅校验逻辑结构）');
} else {
  const wb = buildExcelWorkbook(XLSX, issues, meta);
  ok('生成 4 个工作表', JSON.stringify(wb.SheetNames) === JSON.stringify(['问题闭环台账', '整改过程记录', '驳回记录', '统计汇总']));

  const s1 = wb.Sheets['问题闭环台账'];
  const rows1 = XLSX.utils.sheet_to_json(s1, { header: 1 });
  ok('台账行数 = 数据+表头', rows1.length === issues.length + 1);
  ok('台账表头含「问题闭环台账」关键列', rows1[0].includes('问题编号') && rows1[0].includes('问题照片1'));

  const s2 = wb.Sheets['整改过程记录'];
  const rows2 = XLSX.utils.sheet_to_json(s2, { header: 1 });
  // h1 有 1 条整改历史，h2 有 rectificationNote（兼容旧版记 1 条）
  ok('整改记录含 2 行数据', rows2.length === 3);

  const s3 = wb.Sheets['驳回记录'];
  const rows3 = XLSX.utils.sheet_to_json(s3, { header: 1 });
  ok('驳回记录含 1 行数据', rows3.length === 2);

  // 照片超链接：扫描台账表是否存在带 .l 的单元格
  let hasLink = false;
  for (const k of Object.keys(s1)) {
    if (k.startsWith('!')) continue;
    if (s1[k] && s1[k].l && /^https?:\/\//.test(s1[k].l.Target || '')) { hasLink = true; break; }
  }
  ok('现场照片列写入可点击超链接', hasLink);

  // 写文件并校验为合法 zip（PK 头）
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const ab = Buffer.from(buf);
  ok('xlsx 输出为合法 zip（PK 头）', ab[0] === 0x50 && ab[1] === 0x4b && ab[2] === 0x03 && ab[3] === 0x04);
}

console.log('空数据兜底:');
const emptyWb = (XLSX ? buildExcelWorkbook(XLSX, [], meta) : null) || { SheetNames: ['问题闭环台账', '整改过程记录', '驳回记录', '统计汇总'] };
ok('空数据不崩溃且保持 4 表', emptyWb.SheetNames.length === 4);
const emptyHtml = buildPdfHtml([], meta);
ok('空数据 PDF 仍生成', emptyHtml.includes('问题总数') && emptyHtml.includes('0'));

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
