// 权限模块：严格对齐 APK（env_inspection_v370/lib）的角色规则
// - 角色：admin(管理员) / inspector(检查员) / rectifier(整改负责人) / supervisor(督查员) / viewer(只读查看员)
// - 数据可见性（issue_provider.dart）：
//     admin（含用户名 admin/Administrator）→ 全部
//     viewer → 不显示任何问题
//     其他角色 → 只显示“自己发起 + 分配给自己的”
//     匹配字段：reporterId / reporterName（发起人）或 assigneeId（整改人）；
//     特意不匹配 assigneeName（APK 注释：assigneeName 可能与 assigneeId 不一致，会误匹配）
// - 操作权限（user.dart）：
//     canCreateIssue = admin | inspector
//     canRectify     = admin | rectifier
//     canReview      = admin | supervisor
//     canManageUsers = admin
// - 列表操作（issue_list_screen.dart）：
//     开始整改/提交反馈 = 非 viewer && 问题分配给自己
//     催办             = admin | supervisor | inspector && 问题未处理 && 不是自己的

// 当前登录用户的候选标识（_id/id/username/name 去重）
function userKeys(user) {
  const u = user || {};
  const set = new Set();
  [u._id, u.id, u.username, u.name].forEach(v => { if (v != null && v !== '') set.add(String(v)); });
  return set;
}

export function isAdmin(user) {
  const u = user || {};
  return u.role === 'admin' || u.username === 'admin' || u.username === 'Administrator';
}

export function isViewer(user) {
  return !!(user && user.role === 'viewer');
}

// 是否该问题的发起人（对齐 APK _isCurrentUserReporter）
export function isReporter(user, issue) {
  if (!user || !issue) return false;
  const keys = userKeys(user);
  const rid = issue.reporterId != null ? String(issue.reporterId) : '';
  const rname = issue.reporterName != null ? String(issue.reporterName) : '';
  return keys.has(rid) || keys.has(rname);
}

// 是否该问题的整改人（对齐 APK _isCurrentUserAssignee：只匹配 assigneeId）
export function isAssignee(user, issue) {
  if (!user || !issue) return false;
  const keys = userKeys(user);
  const aid = issue.assigneeId != null ? String(issue.assigneeId) : '';
  return keys.has(aid);
}

// 是否相关方（发起人或整改人）
export function isRelated(user, issue) {
  if (isAdmin(user)) return true;
  if (isViewer(user)) return false;
  return isReporter(user, issue) || isAssignee(user, issue);
}

// 【多科室/业务隔离】角色 + 业务双层过滤
//
// 之所以在 filterIssuesByRole 这一个函数里同时套两层，而不是让各页面自己加过滤：
//   dashboard（统计/排名）、hazards（列表、导出）共 4 处调用点都走这里，
//   漏一处就会出现「列表干净、但导出文件里混着无权数据」这类事故。
//
// ⚠️ 这是**前端兜底**，不是安全边界。真正的边界在云函数
//    （cloudfunction_security/index.js 的 scopeQuery 强制注入 deptCode）。
//
// v1.0.28：隔离口径改为「按业务隔离」（inDeptScope → visibleBizCodes）。
// 此处曾是 inCurrentDept（按当前科室徽章过滤）——v1.0.25 起外部调用点都改成了
// 授权口径，唯独漏了这一层，导致「徽章在 JN 时安全业务恒为空、切徽章才能查到」
// 的诡异现象（v1.0.24~v1.0.27 连续回归的真根因）。
import { inDeptScope } from './dept.js';

// 按角色 + 业务范围过滤隐患列表（对齐 APK issues getter）
export function filterIssuesByRole(user, issues) {
  const list = Array.isArray(issues) ? issues : [];
  const scoped = list.filter(i => inDeptScope(i, user));
  if (isAdmin(user)) return scoped;
  // 【D-7 修复】只读查看员：按业务范围可见全部数据，但不参与整改/验收。
  // 原实现直接 return []，导致只读账号形同虚设。
  if (isViewer(user)) return scoped;
  return scoped.filter(i => isRelated(user, i));
}

// ---------- 操作权限 ----------
export function canCreate(user) {
  const u = user || {};
  return u.role === 'admin' || u.role === 'inspector';
}
export function canRectify(user) {
  const u = user || {};
  return u.role === 'admin' || u.role === 'rectifier';
}
export function canReview(user) {
  const u = user || {};
  return u.role === 'admin' || u.role === 'supervisor';
}
export function canManageUsers(user) {
  return !!(user && user.role === 'admin');
}
/**
 * 【动态字典】业务类型 / 隐患类别的「字典维护」权限 —— 仅管理员。
 *
 * 两个层面必须分清（本次权限设计的边界）：
 *   1. 字典维护（新增/编辑/停用/删除某一项）：canManageConfig，仅 admin；
 *   2. 字典使用（查看、按业务筛选、填报时选已有类别）：所有角色照常。
 * 新增项默认不赋权给任何人，必须在【用户管理】里显式勾选后才对该用户可见，
 * 规则见 business.js 的 businessesForDept 注释。
 */
export function canManageConfig(user) {
  return !!(user && user.role === 'admin');
}
/**
 * 【赋权边界】能否给账号分配业务类型。
 * 字典里新增一项，不等于任何用户获得使用权 —— 只有这道权限允许改写 user.businessTypes。
 */
export function canAssignBusiness(user) {
  return !!(user && user.role === 'admin');
}
// 公告管理（发布/编辑/删除/置顶）：严格限定管理员，其他角色一律只读
export function canManageAnnouncement(user) {
  return !!(user && user.role === 'admin');
}
// 催办：admin/supervisor/inspector（APK isSupervisor）
export function canUrge(user) {
  const u = user || {};
  return u.role === 'admin' || u.role === 'supervisor' || u.role === 'inspector';
}

// 列表行：非 viewer 且问题分配给自己 → 可整改操作
export function canOperateIssue(user, issue) {
  if (isViewer(user)) return false;
  return isAssignee(user, issue);
}
// 可开始整改：分配给自己 && pending
export function canStartRectify(user, issue) {
  return canOperateIssue(user, issue) && issue && issue.status === 'pending';
}
// 可提交整改反馈：分配给自己 && processing
export function canSubmitRectify(user, issue) {
  return canOperateIssue(user, issue) && issue && issue.status === 'processing';
}
// 可催办该问题：admin/supervisor/inspector && 未处理 && 不是自己的
export function canUrgeIssue(user, issue) {
  if (!issue) return false;
  return canUrge(user) && !isAssignee(user, issue) && (issue.status === 'pending' || issue.status === 'processing');
}
// 可验收/驳回（流转 reviewing）：admin/supervisor 或该问题的发起人（APK reviewingCount 语义：发起人验收）
export function canReviewIssue(user, issue) {
  if (isViewer(user)) return false;
  if (canReview(user)) return true;
  return isReporter(user, issue);
}
// 详情页“变更状态/上传图片”整体是否可用（至少有一种流转权限）
export function canFlow(user, issue) {
  if (isViewer(user)) return false;
  return canStartRectify(user, issue) || canSubmitRectify(user, issue) || canReviewIssue(user, issue);
}

// ---------- 日常管理模块权限（合理化建议 / 模块考核落实单） ----------
// 与 APK lib/services/mgmt_permission.dart 同口径。
// 安环部人员：部门名称含「安环 / 安全环保」，或平台管理员（admin 视为安环部管理岗）。
export function isSafetyEnvStaff(user) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const dept = user.department || '';
  return dept.indexOf('安环') >= 0 || dept.indexOf('安全环保') >= 0;
}
// 合理化建议：点赞（全体登录用户，一人一票，可取消）
export function canLikeSuggestion(user) {
  return !!(user && (user.isActive !== false));
}
// 评分（专家评审组）：安环部 + 督查员 + 管理员
export function canScoreSuggestion(user) {
  if (!user) return false;
  return isSafetyEnvStaff(user) || user.role === 'supervisor';
}
// 决议（采纳/未采纳/实施 + 获奖定级）：安环部（含管理员）
export function canResolveSuggestion(user) {
  return isSafetyEnvStaff(user);
}
// 模块考核落实单：可见 —— 仅安环部人员与被审核人
export function canViewAssessment(user, a) {
  if (!user) return false;
  if (isSafetyEnvStaff(user)) return true;
  return (user.name || '') === (a && a.auditedPerson);
}
// 发起落实单：安环部人员
export function canCreateAssessment(user) { return isSafetyEnvStaff(user); }
// 签字确认（受审核部门认可意见）：被审核人本人
export function canSignAssessment(user, a) {
  if (!user || (a && a.isSigned)) return false;
  return (user.name || '') === (a && a.auditedPerson);
}
// 填写纠正措施：被审核人 或 安环部
export function canFillCorrective(user, a) {
  if (!user || (a && a.isClosed)) return false;
  return isSafetyEnvStaff(user) || (user.name || '') === (a && a.auditedPerson);
}
// 审核员意见 / 闭环：安环部 或 审核员本人
export function canReviewAssessment(user, a) {
  if (!user || (a && a.isClosed)) return false;
  return isSafetyEnvStaff(user) || (user.name || '') === (a && a.auditor);
}

// ---------- 消息可见性（dashboard 最新消息，按当前用户过滤） ----------
// APK 中消息按人推送；这里匹配消息接收人字段（toUser/toUserId/receiver/fromUser 含当前用户）
export function filterMessagesByUser(user, messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (isAdmin(user)) return list;
  const keys = userKeys(user);
  return list.filter(m => {
    const vals = [m.toUser, m.toUserName, m.toUserId, m.receiver, m.receiverName, m.receiverId, m.fromUser, m.fromUserName];
    return vals.some(v => v != null && keys.has(String(v)));
  });
}
