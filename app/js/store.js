// 全局状态（Vue reactive）+ localStorage 持久化
import { getStoredUser, clearSession } from './api.js';
import { resetDept } from './dept.js';

// node 环境（test/*.mjs）没有全局 Vue，降级为普通对象：
// 行为一致，只是失去响应式 —— 否则测试链路里任何一处 import 本文件都会整片崩。
const reactive = (typeof Vue !== 'undefined' && Vue.reactive) ? Vue.reactive : (s) => s;

export const store = reactive({
  user: getStoredUser(),
  sidebarOpen: false,
  // 当前视图可注册一个返回处理器：返回 true 表示已处理（如关闭弹窗），不再执行路由返回
  backHandler: null,
  pendingHazardFilter: null,
  // 仪表盘点击某条催办「详情」时，记录 id，跳转催办页后自动打开详情
  pendingMessageId: null
});

export function setUser(u) { store.user = u; }
export function logout() {
  clearSession();
  // 清掉当前科室，否则下一个人登录会先落到上一个用户的科室视图
  resetDept();
  store.user = null;
  location.hash = '#/login';
}
export function toggleSidebar() { store.sidebarOpen = !store.sidebarOpen; }
export function closeSidebar() { store.sidebarOpen = false; }
