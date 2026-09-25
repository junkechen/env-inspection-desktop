import { api, setSession } from '../api.js';
import { setUser } from '../store.js';
import { navigate } from '../router.js';
import { syncDeptFromUser } from '../dept.js';

// 记住密码：凭据保存在本机 localStorage（桌面端单用户场景），
// base64 仅做简单混淆，避免明文直接可见；勾选取消时立即清除
const REMEMBER_KEY = 'gz_remember';

function loadRemember() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.u || !saved.p) return null;
    return { u: atob(saved.u), p: atob(saved.p) };
  } catch (e) { return null; }
}
function saveRemember(u, p) {
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ u: btoa(u), p: btoa(p) })); } catch (e) { /* 忽略存储失败 */ }
}
function clearRemember() {
  try { localStorage.removeItem(REMEMBER_KEY); } catch (e) { /* 忽略 */ }
}

export default {
  template: `
  <div class="login-wrap">
    <div class="login-card">
      <div class="logo">
        <div class="em">🌿</div>
        <div class="t">GZ环保巡查管理系统</div>
        <div class="s">桌面客户端</div>
      </div>
      <el-form label-position="top" @submit.prevent="onLogin">
        <el-form-item label="用户名">
          <el-input v-model="username" size="large" placeholder="请输入用户名" :prefix-icon="User" @keyup.enter="onLogin" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" size="large" placeholder="请输入密码" show-password :prefix-icon="Lock" @keyup.enter="onLogin" />
        </el-form-item>
        <el-checkbox v-model="remember" style="margin-bottom:14px">记住密码并自动登录</el-checkbox>
        <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="onLogin">登 录</el-button>
      </el-form>
      <div style="text-align:center;margin-top:14px;color:var(--c-text-soft);font-size:12px">使用云端账号登录（密码默认 123456）</div>
    </div>
  </div>`,
  setup() {
    const { ref, onMounted } = Vue;
    const { ElMessage } = ElementPlus;
    const { User, Lock } = ElementPlusIconsVue;
    const username = ref('');
    const password = ref('');
    const remember = ref(false);
    const loading = ref(false);
    // 自动登录只尝试一次，失败后不循环重试
    let autoTried = false;

    async function doLogin(silent) {
      if (!username.value || !password.value) {
        if (!silent) ElMessage.warning('请输入用户名和密码');
        return;
      }
      loading.value = true;
      try {
        const res = await api.login(username.value, password.value);
        // deptCodes 由服务端在登录时算好，这里补到 user 上一起持久化，
        // 供科室切换入口判断"这个人能进哪些科室"。
        const user = Object.assign({}, res.user, {
          deptCodes: res.deptCodes || (res.user && res.user.deptCodes) || []
        });
        setSession(res.token, user);
        setUser(user);
        // 登录时不让用户选科室；只在当前值越界时才纠正（单人单科室不会被动改写）
        syncDeptFromUser(user);
        // 勾选则记住凭据（下次启动自动登录）；取消勾选则清除已保存的凭据
        if (remember.value) saveRemember(username.value, password.value);
        else clearRemember();
        if (!silent) ElMessage.success('登录成功');
        navigate('/');
      } catch (e) {
        // 自动登录失败（如网络未就绪、密码已被重置）静默留在登录页，表单已填充可直接手点
        if (!silent) ElMessage.error(e.message);
      } finally {
        loading.value = false;
      }
    }

    function onLogin() { doLogin(false); }

    onMounted(() => {
      const saved = loadRemember();
      if (saved) {
        username.value = saved.u;
        password.value = saved.p;
        remember.value = true;
        autoTried = true;
        doLogin(true);
      }
    });

    return { username, password, remember, loading, onLogin, User, Lock };
  }
};
