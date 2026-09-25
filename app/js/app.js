import { api } from './api.js';
import { store, logout, toggleSidebar, closeSidebar } from './store.js';
import { route, navigate, topPath, back } from './router.js';
import { canManageUsers } from './permission.js';
import { businessInfos, businessShortLabel } from './business.js';
import Login from './views/login.js';
import { currentDept, deptInfo, availableDepts, switchDept } from './dept.js';
import Dashboard from './views/dashboard.js';
import Hazards from './views/hazards.js';
import Users from './views/users.js';
import Departments from './views/departments.js';
import Messages from './views/messages.js';
import Announcements from './views/announcements.js';

const { createApp, computed, watch, onMounted, ref } = Vue;

const menus = [
  { path: '/', title: '仪表盘', icon: 'Odometer' },
  { path: '/announcements', title: '公告栏', icon: 'Notification' },
  { path: '/hazards', title: '隐患管理', icon: 'Warning' },
  // 仅管理员可见（权限漏洞修复：此前普通用户也能进用户管理改人/审批）
  { path: '/users', title: '用户管理', icon: 'User', adminOnly: true },
  { path: '/departments', title: '部门/车间', icon: 'OfficeBuilding' },
  { path: '/messages', title: '消息催办', icon: 'Bell' }
];

const viewMap = {
  '/': Dashboard,
  '/announcements': Announcements,
  '/hazards': Hazards,
  '/users': Users,
  '/departments': Departments,
  // 统计分析已合并到仪表盘（/statistics 自动回退到 /）
  '/messages': Messages
};

const ErrorBox = {
  props: ['title', 'detail'],
  emits: ['back'],
  template: `
    <div style="padding:40px;text-align:center;color:#f87171;background:var(--c-bg);min-height:100vh">
      <h2>{{ title || '页面加载失败' }}</h2>
      <pre style="text-align:left;background:var(--c-surface);color:var(--c-text);border:1px solid var(--c-border);padding:16px;border-radius:8px;overflow:auto">{{ detail }}</pre>
      <div style="margin-top:16px;display:flex;justify-content:center;gap:12px">
        <el-button @click="goBack">返回首页</el-button>
        <el-button type="primary" @click="reload">刷新重试</el-button>
      </div>
    </div>`,
  methods: {
    reload() { location.reload(); },
    goBack() { this.$emit('back'); }
  }
};

const App = {
  template: `
    <error-box v-if="fatalError" :title="fatalError.title" :detail="fatalError.detail" @back="go('/')" />
    <component :is="Login" v-else-if="!store.user || route.path === '/login'" />
    <div v-else class="layout">
      <aside class="sidebar" :class="{ open: store.sidebarOpen }">
        <div class="brand"><span class="logo">🌿</span><span>GZ环保巡查</span></div>
        <nav class="menu">
          <div v-for="m in visibleMenus" :key="m.path" class="menu-item"
               :class="{ active: topPath(route.path) === m.path }" @click="go(m.path)">
            <span class="ico"><component :is="iconOf(m.icon)" /></span><span>{{ m.title }}</span>
          </div>
        </nav>
      </aside>
      <div class="overlay" :class="{ show: store.sidebarOpen }" @click="closeSidebar"></div>
      <div class="main">
        <header class="topbar">
          <span class="hamburger" @click="toggleSidebar">☰</span>
          <span v-if="route.path !== '/'" class="back-btn" @click="onBack" title="返回上一级"><ArrowLeft style="width:16px;height:16px" /></span>
          <span class="crumb">{{ title }}</span>
          <span class="spacer"></span>
          <!-- 多科室用户：显示科室切换器；单科室用户：显示本人业务类型徽章（纯展示） -->
          <el-dropdown v-if="canSwitchDept" trigger="click" @command="onSwitchDept">
            <span class="dept-badge" :style="{ background: dept.color }" :title="dept.name">
              <span>{{ dept.icon }}</span><span>{{ dept.short }}</span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="d in myDepts" :key="d.code" :command="d.code" :disabled="d.code === dept.code">
                  {{ d.icon }} {{ d.name }}<span v-if="d.code === dept.code">（当前）</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <span v-else class="dept-badge static" :style="{ background: bizColor }" :title="bizTitle">
            <span>{{ bizIcon }}</span><span>{{ bizLabel }}</span>
          </span>
          <span class="bell" @click="go('/messages')" title="消息催办">🔔<span v-if="store.unread" class="dot">{{ store.unread }}</span></span>
          <el-dropdown @command="onCmd">
            <span class="user"><span class="avatar">{{ initial }}</span><span>{{ store.user && store.user.name }}</span></span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </header>
        <main class="content">
          <component :is="currentView" />
        </main>
      </div>
    </div>`,
  setup() {
    const fatalError = ref(null);
    const currentView = computed(() => viewMap[topPath(route.path)] || Dashboard);
    const title = computed(() => {
      const m = menus.find((x) => x.path === topPath(route.path));
      return m ? m.title : 'GZ环保巡查管理系统';
    });
    const initial = computed(() => ((store.user && store.user.name) || '?').slice(0, 1));
    // 菜单按角色过滤：adminOnly 项（用户管理）只对管理员显示
    const visibleMenus = computed(() => menus.filter((m) => !m.adminOnly || canManageUsers(store.user)));
    // 只在确实归属多个科室时才给切换入口 —— 单人单科室的用户不该看到选择器
    const myDepts = computed(() => availableDepts(store.user).map(deptInfo));
    const canSwitchDept = computed(() => myDepts.value.length > 1);
    // currentDept() 读 localStorage，本身不响应；切换成功后由 reload 兜底刷新界面
    const dept = computed(() => deptInfo(currentDept()));
    // 单科室用户右上角显示「业务类型」徽章（跟随 users.businessTypes，编辑用户后重新登录生效）
    const biz = computed(() => businessInfos(store.user));
    const bizLabel = computed(() => businessShortLabel(store.user));
    const bizColor = computed(() => (biz.value.length ? biz.value[0].color : '#64748b'));
    const bizIcon = computed(() => (biz.value.length ? biz.value[0].icon : '🏷'));
    const bizTitle = computed(() => (biz.value.length ? biz.value.map((b) => b.name).join(' / ') : '未分配业务类型（管理员可在用户管理中设置）'));

    async function onSwitchDept(code) {
      if (code === currentDept()) return;
      try {
        await ElementPlus.ElMessageBox.confirm(
          `切换到「${deptInfo(code).name}」后，当前页面未提交的内容会丢失，且需要重新加载数据。确定切换吗？`,
          '切换科室',
          { type: 'warning', confirmButtonText: '确定切换', cancelButtonText: '取消' }
        );
      } catch (e) {
        return; // 用户取消
      }
      if (!switchDept(code)) return;
      // 必须清缓存：缓存键虽已带科室前缀，但业务集合在切换后需要按新科室重新取
      api.clearCache();
      navigate('/');
      location.reload();
    }
    function iconOf(name) {
      const comp = ElementPlusIconsVue && ElementPlusIconsVue[name];
      if (!comp) console.warn('[app] 菜单图标不存在:', name);
      return comp;
    }
    function go(p) { navigate(p); closeSidebar(); }
    function onBack() {
      console.log('[app] back clicked, current=', route.path);
      // 如果当前视图注册了返回处理器（如关闭弹窗），优先交给它处理
      if (typeof store.backHandler === 'function' && store.backHandler()) {
        return;
      }
      back();
    }
    function onCmd(c) { if (c === 'logout') logout(); }

    watch(() => route.path, (p) => {
      console.log('[app] route.path =', p, 'user=', store.user ? store.user.username : null);
      if (store.user && p === '/login') navigate('/');
      // 路由守卫：非管理员直达 /users 时拦回首页（菜单已隐藏，这里防手输地址）
      if (store.user && topPath(p) === '/users' && !canManageUsers(store.user)) {
        ElementPlus.ElMessage.warning('用户管理仅限管理员使用');
        navigate('/');
      }
    });
    onMounted(async () => {
      console.log('[app] mounted. user=', store.user ? store.user.username : null, 'route=', route.path);
      if (store.user) {
        // 后台预热各集合：之后进入仪表盘/列表页可直接命中本地缓存，无需等待网络。
        // 不 await、失败静默，绝不阻塞首屏。
        api.warmCache();
        try {
          const r = await api.messages({ read: 'false' });
          store.unread = r.unread;
          console.log('[app] unread messages:', r.unread);
        } catch (e) { console.error('[app] 拉取未读消息失败:', e.message); }
      } else if (route.path !== '/login') {
        navigate('/login');
      }
    });

    // 登录成功（store.user 由 null 变为用户）时同样预热，
    // 否则本次会话第一个页面仍要等网络。
    watch(() => store.user, (u) => { if (u) api.warmCache(); });

    window.__setFatalError = (title, detail) => { fatalError.value = { title, detail }; };

    return {
      Login, store, route, menus, visibleMenus, currentView, title, initial, fatalError, topPath,
      iconOf, go, onBack, onCmd, toggleSidebar, closeSidebar,
      dept, myDepts, canSwitchDept, onSwitchDept,
      bizLabel, bizColor, bizIcon, bizTitle,
      ArrowLeft: ElementPlusIconsVue.ArrowLeft
    };
  }
};

const app = createApp(App);
app.config.errorHandler = (err, vm, info) => {
  console.error('[Vue error]', err, info);
  if (window.__setFatalError) window.__setFatalError('渲染出错', err && (err.stack || err.message) ? (err.stack || err.message) : String(err));
};
app.config.warnHandler = (msg) => { console.warn('[Vue warn]', msg); };
window.onerror = (msg, url, line, col, err) => {
  console.error('[window.onerror]', msg, url, line, col, err);
};
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
});

try { app.use(ElementPlus, { locale: (window.ElementPlusLocaleZhCn || {}) }); } catch (e) { app.use(ElementPlus); }
app.component('ErrorBox', ErrorBox);
if (typeof ElementPlusIconsVue !== 'undefined') {
  for (const [k, comp] of Object.entries(ElementPlusIconsVue)) app.component(k, comp);
} else {
  console.error('[app] ElementPlusIconsVue 未加载，图标将不可用');
}
app.mount('#app');
console.log('[app] mount done');
