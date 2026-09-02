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

// 按角色过滤隐患列表（对齐 APK issues getter）
export function filterIssuesByRole(user, issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (isAdmin(user)) return list;
  if (isViewer(user)) return [];
  return list.filter(i => isRelated(user, i));
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
