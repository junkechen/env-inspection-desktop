// 权限模块单元测试：严格对齐 APK（env_inspection_v370）的角色规则
import assert from 'node:assert';
import {
  isAdmin, isViewer, isReporter, isAssignee, isRelated,
  filterIssuesByRole, canCreate, canRectify, canReview, canManageUsers,
  canUrge, canOperateIssue, canStartRectify, canSubmitRectify,
  canUrgeIssue, canReviewIssue, canFlow, filterMessagesByUser
} from '../app/js/permission.js';

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  OK  ' + name); }
  else { failed++; console.error('  FAIL ' + name); }
}

const admin = { _id: 'u_admin', username: 'admin', name: '系统管理员', role: 'admin' };
const admin2 = { _id: 'u_a2', username: 'Administrator', name: '管理员', role: 'inspector' };
const inspector = { _id: 'u_i1', username: 'insp1', name: '张检查', role: 'inspector' };
const rectifier = { _id: 'u_r1', username: 'rect1', name: '王整改', role: 'rectifier' };
const supervisor = { _id: 'u_s1', username: 'sup1', name: '李督查', role: 'supervisor' };
const viewer = { _id: 'u_v1', username: 'view1', name: '只读', role: 'viewer' };
const stranger = { _id: 'u_x1', username: 'other', name: '路人', role: 'rectifier' };

const issues = [
  // 分配给 inspector 的
  { _id: 'h1', title: '分配给我', assigneeId: 'u_i1', assigneeName: '张检查', reporterId: 'u_s1', reporterName: '李督查', status: 'pending' },
  // inspector 发起的（reporterName 匹配）
  { _id: 'h2', title: '我发起的', assigneeId: 'u_r1', assigneeName: '王整改', reporterId: 'u_i1', reporterName: '张检查', status: 'reviewing' },
  // 别人的问题（reporterId 为空、assigneeId 是 u_r1）
  { _id: 'h3', title: '别人的', assigneeId: 'u_r1', assigneeName: '王整改', reporterId: 'u_s1', reporterName: '李督查', status: 'processing' },
  // 关键陷阱：assigneeName 是“张检查”但 assigneeId 不是 u_i1 —— 不得误匹配（APK 特意不匹配 assigneeName）
  { _id: 'h4', title: '名字撞车', assigneeId: 'u_r1', assigneeName: '张检查', reporterId: 'u_s1', reporterName: '李督查', status: 'pending' },
];

console.log('— 角色基础判断 —');
ok('isAdmin(role=admin)', isAdmin(admin) === true);
ok('isAdmin(username=Administrator)', isAdmin(admin2) === true);
ok('isAdmin(inspector)=false', isAdmin(inspector) === false);
ok('isViewer(viewer)', isViewer(viewer) === true);
ok('isViewer(inspector)=false', isViewer(inspector) === false);

console.log('— 相关方判断 —');
ok('isAssignee: assigneeId 匹配', isAssignee(inspector, issues[0]) === true);
ok('isAssignee: assigneeId 不匹配（即使 assigneeName 相同）', isAssignee(inspector, issues[3]) === false);
ok('isReporter: reporterId 匹配', isReporter(inspector, issues[1]) === true);
ok('isReporter: reporterName 匹配', isReporter(inspector, issues[1]) === true);
ok('isReporter: 无关问题=false', isReporter(inspector, issues[0]) === false);
ok('isRelated(admin)=true（无条件）', isRelated(admin, issues[2]) === true);
ok('isRelated(viewer)=false（无条件）', isRelated(viewer, issues[0]) === false);

console.log('— 列表过滤 —');
ok('admin 看全部', filterIssuesByRole(admin, issues).length === 4);
ok('viewer 空列表', filterIssuesByRole(viewer, issues).length === 0);
ok('inspector 只看相关（2条，不含 assigneeName 撞车）', filterIssuesByRole(inspector, issues).map(i => i._id).sort().join(',') === 'h1,h2');
ok('stranger 看不到任何（0条）', filterIssuesByRole(stranger, issues).length === 0);
ok('rectifier 是 h2/h3/h4 的整改人（3条，含撞车那条因为 assigneeId=u_r1）', filterIssuesByRole(rectifier, issues).length === 3);
ok('非数组兜底', filterIssuesByRole(inspector, null).length === 0);

console.log('— 操作权限 —');
ok('canCreate: admin/inspector', canCreate(admin) === true && canCreate(inspector) === true);
ok('canCreate: rectifier=false', canCreate(rectifier) === false);
ok('canRectify: admin/rectifier', canRectify(admin) === true && canRectify(rectifier) === true);
ok('canRectify: inspector=false', canRectify(inspector) === false);
ok('canReview: admin/supervisor', canReview(admin) === true && canReview(supervisor) === true);
ok('canReview: inspector=false', canReview(inspector) === false);
ok('canManageUsers: 仅 admin', canManageUsers(admin) === true && canManageUsers(supervisor) === false);
ok('canUrge: admin/supervisor/inspector', canUrge(admin) === true && canUrge(supervisor) === true && canUrge(inspector) === true);
ok('canUrge: rectifier=false', canUrge(rectifier) === false);

console.log('— 单问题操作 —');
ok('canOperateIssue: 分配给自己 && 非viewer', canOperateIssue(inspector, issues[0]) === true);
ok('canOperateIssue: viewer=false', canOperateIssue(viewer, issues[0]) === false);
ok('canStartRectify: 我的 pending', canStartRectify(inspector, issues[0]) === true);
ok('canStartRectify: 别人的 pending=false', canStartRectify(rectifier, issues[0]) === false);
ok('canSubmitRectify: 我的 processing', canSubmitRectify(rectifier, issues[2]) === true);
ok('canSubmitRectify: pending 状态=false', canSubmitRectify(inspector, issues[0]) === false);
ok('canUrgeIssue: supervisor 催办别人的 pending', canUrgeIssue(supervisor, issues[0]) === true);
ok('canUrgeIssue: rectifier 不能催办', canUrgeIssue(rectifier, issues[2]) === false);
ok('canUrgeIssue: 自己的问题不能催办', canUrgeIssue(inspector, issues[0]) === false);
ok('canReviewIssue: supervisor 可验收', canReviewIssue(supervisor, issues[1]) === true);
ok('canReviewIssue: 发起人可验收', canReviewIssue(inspector, issues[1]) === true);
ok('canReviewIssue: 无关 rectifier 不可验收', canReviewIssue(rectifier, issues[1]) === false);
ok('canFlow: viewer=false', canFlow(viewer, issues[0]) === false);
ok('canFlow: 相关方=true', canFlow(inspector, issues[0]) === true);

console.log('— 消息过滤 —');
const msgs = [
  { _id: 'm1', toUserId: 'u_i1', toUserName: '张检查', title: '给你' },
  { _id: 'm2', toUserId: 'u_r1', title: '给整改人' },
  { _id: 'm3', toUser: '张检查', title: '给你2' },
  { _id: 'm4', title: '群发无收件人' },
];
ok('admin 看全部消息', filterMessagesByUser(admin, msgs).length === 4);
ok('inspector 只看发给自己的（m1/m3）', filterMessagesByUser(inspector, msgs).map(m => m._id).sort().join(',') === 'm1,m3');
ok('rectifier 只看 m2', filterMessagesByUser(rectifier, msgs).map(m => m._id).join(',') === 'm2');
ok('无关用户看不到', filterMessagesByUser(stranger, msgs).length === 0);

console.log(`\npermission.test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
