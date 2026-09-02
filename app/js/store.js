// 全局状态（Vue reactive）+ localStorage 持久化
import { getStoredUser, clearSession } from './api.js';

const { reactive } = Vue;

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
  store.user = null;
  location.hash = '#/login';
}
export function toggleSidebar() { store.sidebarOpen = !store.sidebarOpen; }
export function closeSidebar() { store.sidebarOpen = false; }
