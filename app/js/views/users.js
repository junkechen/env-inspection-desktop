import { api, ROLE_MAP } from '../api.js';
import { BUSINESS_OPTS, businessNames } from '../business.js';
import { canManageUsers } from '../permission.js';
import { store } from '../store.js';

const ROLE_OPTS = Object.entries(ROLE_MAP).map(([value, label]) => ({ value, label }));

export default {
  template: `
  <div v-if="allowed">
    <h2 class="page-title">用户管理</h2>
    <p class="page-sub">巡检人员与管理人员账户维护</p>

    <div class="toolbar">
      <el-input v-model="kw" placeholder="姓名/用户名/手机号" clearable style="width:220px" @keyup.enter="search" />
      <el-select v-model="filterStatus" placeholder="状态" clearable style="width:120px">
        <el-option label="启用" value="active" />
        <el-option label="待审核" value="pending" />
        <el-option label="禁用" value="disabled" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="search">查询</el-button>
      <el-button :icon="Refresh" @click="reset">重置</el-button>
      <span class="spacer"></span>
      <el-button type="success" :icon="Plus" @click="openCreate">新增用户</el-button>
    </div>

    <div class="card">
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column prop="username" label="用户名" width="140" />
        <el-table-column prop="phone" label="手机号" width="140" />
        <el-table-column label="角色" width="120">
          <template #default="{row}">{{ roleLabel(row.role) }}</template>
        </el-table-column>
        <el-table-column prop="department" label="部门" width="120" />
        <!-- 业务类型：用户负责的业务领域（安全/能源环保/现场/设备），可单选或多选 -->
        <el-table-column label="业务类型" width="170">
          <template #default="{row}">{{ businessLabels(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{row}">
            <!-- pending = APP 端注册后等待管理员审核 -->
            <span v-if="row.status==='pending'" class="tag-pending">待审核</span>
            <span v-else-if="row.status==='active'" class="tag-closed">启用</span>
            <span v-else class="tag-overdue">禁用</span>
          </template>
        </el-table-column>
        <!-- 用下拉菜单收纳所有操作，避免固定右列宽度不足把「删除」裁掉（此前 300px 仍不够宽） -->
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{row}">
            <el-dropdown @command="(c) => onCmd(c, row)">
              <el-button text type="primary" size="small">
                操作<el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit">编辑</el-dropdown-item>
                  <el-dropdown-item command="reset">重置密码</el-dropdown-item>
                  <el-dropdown-item v-if="row.status==='pending'" command="approve">通过审核</el-dropdown-item>
                  <el-dropdown-item v-else :command="row.status==='active' ? 'disable' : 'enable'">
                    {{ row.status==='active' ? '禁用' : '启用' }}
                  </el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>
      <div style="margin-top:14px;text-align:right">
        <el-pagination background layout="total, prev, pager, next" :total="total" :page-size="size" :current-page="page" @current-change="onPage" />
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑用户' : '新增用户'" width="480px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="用户名" required>
          <el-input v-model="form.username" :disabled="editing" />
        </el-form-item>
        <el-form-item label="姓名" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%">
            <el-option v-for="r in ROLE_OPTS" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="部门"><el-input v-model="form.department" /></el-form-item>
        <el-form-item label="业务类型">
          <el-select v-model="form.businessTypes" multiple style="width:100%" placeholder="可单选或多选">
            <el-option v-for="b in BUSINESS_OPTS" :key="b.value" :label="b.label" :value="b.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="密码" v-if="!editing"><el-input v-model="form.password" placeholder="默认123456" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
  <div v-else style="padding:60px;text-align:center">
    <el-result icon="warning" title="无访问权限" sub-title="用户管理仅限管理员使用，请联系管理员" />
  </div>`,
  setup() {
    const { ref, reactive } = Vue;
    const { ElMessage, ElMessageBox } = ElementPlus;
    const { Search, Refresh, Plus, Edit, Delete, Key, ArrowDown } = ElementPlusIconsVue;

    // 视图守卫（第二道防线）：菜单/路由已拦截非管理员，这里兜底防止直达
    const allowed = canManageUsers(store.user);

    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const size = ref(10);
    const loading = ref(false);
    const kw = ref('');
    const filterStatus = ref('');
    const dialogVisible = ref(false);
    const editing = ref(false);
    const saving = ref(false);
    const editingId = ref(null);
    const form = reactive({ username: '', name: '', phone: '', role: 'inspector', department: '', businessTypes: [], password: '123456' });

    function roleLabel(r) { return (ROLE_OPTS.find((x) => x.value === r) || {}).label || r; }

    async function load() {
      loading.value = true;
      try {
        const r = await api.users({ page: page.value, size: size.value, keyword: kw.value, status: filterStatus.value });
        list.value = r.list; total.value = r.total;
      } finally { loading.value = false; }
    }
    function search() { page.value = 1; load(); }
    // 「重置」由用户主动触发，先失效缓存再取数，
    // 否则 TTL 内点击会命中缓存、看起来像没生效。
    function reset() { kw.value = ''; filterStatus.value = ''; api.refreshCache('users'); search(); }
    function onPage(p) { page.value = p; load(); }

    function openCreate() {
      editing.value = false; editingId.value = null;
      Object.assign(form, { username: '', name: '', phone: '', role: 'inspector', department: '', businessTypes: [], password: '123456' });
      dialogVisible.value = true;
    }
    function openEdit(row) {
      editing.value = true; editingId.value = row._id;
      const bt = Array.isArray(row.businessTypes) ? row.businessTypes : [];
      Object.assign(form, { username: row.username, name: row.name, phone: row.phone, role: row.role, department: row.department, businessTypes: bt });
      dialogVisible.value = true;
    }
    async function save() {
      if (!form.username || !form.name) { ElMessage.warning('用户名和姓名必填'); return; }
      saving.value = true;
      try {
        if (editing.value) {
          const { username, ...rest } = form;
          await api.updateUser(editingId.value, rest);
        } else {
          await api.createUser({ ...form });
        }
        ElMessage.success('已保存');
        dialogVisible.value = false;
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }
    async function toggle(row) {
      const next = row.status === 'active' ? 'disabled' : 'active';
      try {
        await api.updateUser(row._id, { status: next });
        ElMessage.success(next === 'active' ? '已启用' : '已禁用');
        load();
      } catch (e) { ElMessage.error(e.message); }
    }
    // 审核通过：APP 端注册的用户初始 status='pending'、isActive=false，
    // 通过后置为启用，账号才可登录
    async function approve(row) {
      try {
        await api.updateUser(row._id, { status: 'active', isActive: true });
        ElMessage.success('已通过审核，账号已启用');
        load();
      } catch (e) { ElMessage.error(e.message); }
    }
    async function resetPwd(row) {
      try {
        await api.resetPassword(row._id);
        ElMessage.success('密码已重置为 123456');
      } catch (e) { ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElMessageBox.confirm('确认删除该用户？', '提示', { type: 'warning' });
      } catch (e) { return; }
      try {
        await api.deleteUser(row._id);
        ElMessage.success('已删除');
        load();
      } catch (e) { ElMessage.error(e.message); }
    }
    // 下拉菜单分发：编辑/重置密码/通过审核/禁用或启用/删除
    function onCmd(cmd, row) {
      if (cmd === 'edit') return openEdit(row);
      if (cmd === 'reset') return resetPwd(row);
      if (cmd === 'approve') return approve(row);
      if (cmd === 'delete') return remove(row);
      if (cmd === 'disable') return toggle(row);
      if (cmd === 'enable') return toggle(row);
    }

    load();
    return {
      allowed, ROLE_OPTS, BUSINESS_OPTS, list, total, page, size, loading, kw, filterStatus, dialogVisible, editing, saving, form,
      roleLabel, businessLabels: businessNames, search, reset, onPage, openCreate, openEdit, save, toggle, approve, resetPwd, remove, onCmd,
      Search, Refresh, Plus, Edit, Delete, Key, ArrowDown
    };
  }
};
