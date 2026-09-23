import { api, setSession } from '../api.js';
import { setUser } from '../store.js';
import { navigate } from '../router.js';
import { syncDeptFromUser } from '../dept.js';

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
        <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="onLogin">登 录</el-button>
      </el-form>
      <div style="text-align:center;margin-top:14px;color:var(--c-text-soft);font-size:12px">使用云端账号登录（密码默认 123456）</div>
    </div>
  </div>`,
  setup() {
    const { ref } = Vue;
    const { ElMessage } = ElementPlus;
    const { User, Lock } = ElementPlusIconsVue;
    const username = ref('');
    const password = ref('');
    const loading = ref(false);

    async function onLogin() {
      if (!username.value || !password.value) { ElMessage.warning('请输入用户名和密码'); return; }
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
        ElMessage.success('登录成功');
        navigate('/');
      } catch (e) {
        ElMessage.error(e.message);
      } finally {
        loading.value = false;
      }
    }
    return { username, password, loading, onLogin, User, Lock };
  }
};
