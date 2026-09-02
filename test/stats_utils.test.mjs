// 统计聚合模块单元测试：computeStats 纯函数
import assert from 'node:assert';
import { computeStats } from '../app/js/stats_utils.js';

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  OK  ' + name); }
  else { failed++; console.error('  FAIL ' + name); }
}

const today = new Date();
const d = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
// 注意：d(-1)=明天、d(0)=今天、d(1)=昨天

const hazards = [
  { title: 'A', status: 'pending', severity: 'general', department: '一车间', category: 'wastewater', location: '东门', dueDate: d(1), createdAt: d(0), closedAt: '' },   // 昨天到期 → 逾期
  { title: 'B', status: 'processing', severity: 'serious', department: '一车间', category: 'wastegas', location: '东门', dueDate: d(1), createdAt: d(1), closedAt: '' }, // 昨天到期 → 逾期
  { title: 'C', status: 'reviewing', severity: 'critical', department: '二车间', category: 'solidWaste', location: '西门', dueDate: d(-1), createdAt: d(2), closedAt: '' }, // 明天到期 → 未逾期
  { title: 'D', status: 'closed', severity: 'general', department: '二车间', category: 'wastewater', location: '东门', dueDate: d(-2), createdAt: d(3), closedAt: d(0) },
];

console.log('— computeStats 基本聚合 —');
const s = computeStats(hazards);
ok('counts.total=4', s.counts.total === 4);
ok('counts.pending=1 / processing=1 / reviewing=1 / closed=1', s.counts.pending === 1 && s.counts.processing === 1 && s.counts.reviewing === 1 && s.counts.closed === 1);
ok('counts.overdue=2（A、B 已逾期，C 未逾期，D 已关闭不算）', s.counts.overdue === 2);
ok('byDepartment 含一车间=2', s.byDepartment.find(x => x.name === '一车间')?.value === 2);
ok('byDepartmentDetail 字段完整', s.byDepartmentDetail.find(x => x.name === '一车间')?.total === 2);
ok('bySeverity.general=2 / critical=1', s.bySeverity.general === 2 && s.bySeverity.critical === 1);
ok('byCategory 含 废水排放=2', s.byCategory.find(x => x.name === '废水排放')?.value === 2);
ok('repeatLocations: 东门出现3次', s.repeatLocations.find(x => x.name === '东门')?.value === 3);
ok('trend 30 项', s.trend.length === 30);
ok('trend 今天 created≥1（A 今天创建）', s.trend[s.trend.length - 1].created >= 1);
ok('trend 今天 closed=1（D 今天闭环）', s.trend[s.trend.length - 1].closed === 1);
ok('comparison 含 mom/yoy', typeof s.comparison.mom === 'string' && typeof s.comparison.yoy === 'string');
ok('alerts 含逾期预警', s.alerts.some(a => a.text.includes('逾期')));

console.log('— computeStats 空数据兜底 —');
const e = computeStats([]);
ok('空数据 counts 全 0', e.counts.total === 0 && e.counts.overdue === 0 && e.counts.pending === 0);
ok('空数据 byDepartment=[]', Array.isArray(e.byDepartment) && e.byDepartment.length === 0);
ok('空数据 trend 30 项且 created=0', e.trend.length === 30 && e.trend.every(x => x.created === 0 && x.closed === 0));
ok('空数据 alerts=[]', e.alerts.length === 0);

console.log('— computeStats 非数组兜底 —');
const n = computeStats(null);
ok('null → counts.total=0', n.counts.total === 0);

// 与 api.js 的 stats 一致性由 api.test 覆盖（admin 全量路径仍走 api.stats → computeStats）

console.log(`\nstats_utils.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
