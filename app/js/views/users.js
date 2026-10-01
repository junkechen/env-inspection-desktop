import { api, ROLE_MAP } from '../api.js';
import { businessOptions, businessCodes, businessNames, UNAUTH_MODE } from '../business.js';
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
      <!-- 批量赋权：字典里新增业务后，用它给一批账号补授，避免逐个点开编辑 -->
      <el-button type="warning" :icon="Key" :disabled="!selection.length" @click="openBatch">
        批量赋权<template v-if="selection.length">（{{ selection.length }}）</template>
      </el-button>
    </div>

    <div class="card">
      <el-table :data="list" v-loading="loading" stripe @selection-change="onSelectionChange">
        <el-table-column type="selection" width="46" />
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column prop="username" label="用户名" width="140" />
        <el-table-column prop="phone" label="手机号" width="140" />
        <el-table-column label="角色" width="120">
          <template #default="{row}">{{ roleLabel(row.role) }}</template>
        </el-table-column>
        <el-table-column prop="department" label="部门" width="120" />
        <!-- 业务类型：用户负责的业务领域（安全/节能/环保），可单选或多选 -->
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
          <el-select v-model="form.businessTypes" multiple style="width:100%" placeholder="未勾选 = 未显式授权">
            <el-option v-for="b in BUSINESS_OPTS" :key="b.value" :label="b.label" :value="b.value" />
          </el-select>
          <!-- 赋权语义必须写在界面上：字典里新增一项 ≠ 该用户获得使用权 -->
          <div style="color:var(--c-text-soft);font-size:12px;margin-top:4px">
            在【配置管理】新增的业务/类别只会进入全局字典，<b>不会自动给任何账号加权限</b>；
            必须在这里勾选并保存后，该账号才能在业务上报、隐患填报、列表筛选中使用。
            <span v-if="unauthInherit">未勾选的账号当前按「继承所在科室业务」处理（兼容模式）。</span>
          </div>
        </el-form-item>
        <el-form-item label="密码" v-if="!editing"><el-input v-model="form.password" placeholder="默认123456" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量赋权：给选中的一批账号追加/覆盖业务授权 -->
    <el-dialog v-model="batchVisible" title="批量赋权" width="440px">
      <div style="color:var(--c-text-soft);font-size:13px;margin-bottom:12px">
        已选中 <b style="color:#fff">{{ selection.length }}</b> 个账号：{{ previewNames }}
      </div>
      <el-form label-width="90px">
        <el-form-item label="业务类型" required>
          <el-select v-model="batchForm.businessTypes" multiple style="width:100%" placeholder="请选择要授予的业务">
            <el-option v-for="b in BUSINESS_OPTS" :key="b.value" :label="b.label" :value="b.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="赋权方式">
          <el-radio-group v-model="batchForm.mode">
            <el-radio-button value="merge">追加（保留原有）</el-radio-button>
            <el-radio-button value="replace">覆盖（替换为本次选择）</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <div style="color:var(--c-text-soft);font-size:12px">
        赋权结果对该账号下次打开（或 60 秒内）生效，无需重新登录。
      </div>
      <template #footer>
        <el-button @click="batchVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="applyBatch">确认赋权</el-button>
      </template>
    </el-dialog>
  </div>
  <div v-else style="padding:60px;text-align:center">
    <el-result icon="warning" title="无访问权限" sub-title="用户管理仅限管理员使用，请联系管理员" />
  </div>`,
  setup() {
    const { ref, reactive, computed } = Vue;
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
    // 新建账号默认「不勾选任何业务」—— 字典新增与赋权解耦：
    // 使用权必须由管理员在本页显式授予，不给一堆默认选中制造“谁都能用”的错觉。
    const form = reactive({ username: '', name: '', phone: '', role: 'inspector', department: '', businessTypes: [], password: '123456' });

    function roleLabel(r) { return (ROLE_OPTS.find((x) => x.value === r) || {}).label || r; }

    // 业务下拉用动态字典：配置管理里新增的业务会立刻出现在这里
    const bizOpts = computed(() => businessOptions());
    // 兼容模式提示：UNAUTH_MODE='inherit' 时未勾选的账号仍能继承科室业务，
    // 界面必须把这件事说出来，否则管理员会以为自己已经把权限收住了。
    const unauthInherit = UNAUTH_MODE === 'inherit';

    // ---------- 批量赋权 ----------
    const selection = ref([]);
    // 事件处理放在函数里，而不是模板内联 `selection = v`：
    // setup 返回的 ref 在模板中被自动解包，直接赋值会写到解包后的普通值上。
    function onSelectionChange(v) { selection.value = v; }
    const batchVisible = ref(false);
    const batchForm = reactive({ businessTypes: [], mode: 'merge' });
    const previewNames = computed(() => selection.value.slice(0, 6).map((u) => u.name || u.username).join('、')
      + (selection.value.length > 6 ? ' 等' : ''));
    function openBatch() {
      batchForm.businessTypes = [];
      batchForm.mode = 'merge';
      batchVisible.value = true;
    }
    /**
     * 逐个提交（不用 updateMany）：
     *   1. merge 模式下每个人的原有业务集合都不同，无法用一条 where 表达；
     *   2. 逐个写可以让失败账号精确定位并继续，不会因为一条脏数据整批回滚。
     * 失败不中断，最后统一汇报成功/失败数。
     */
    async function applyBatch() {
      if (!Array.isArray(batchForm.businessTypes) || !batchForm.businessTypes.length) {
        ElMessage.warning('请至少选择一个业务'); return;
      }
      saving.value = true;
      let ok = 0, fail = 0;
      try {
        for (const u of selection.value) {
          try {
            const cur = Array.isArray(u.businessTypes) ? u.businessTypes : [];
            const next = batchForm.mode === 'replace'
              ? [...batchForm.businessTypes]
              : [...new Set([...cur, ...batchForm.businessTypes])];
            await api.updateUser(u._id, { businessTypes: next });
            ok++;
          } catch (e) { fail++; }
        }
        ElMessage[fail ? 'warning' : 'success'](`赋权完成：成功 ${ok} 个${fail ? '，失败 ' + fail + ' 个' : ''}`);
        batchVisible.value = false;
        load();
      } finally { saving.value = false; }
    }

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
      // 存量账号若从未设置过业务，这里如实显示为“未勾选”，
      // 由管理员决定是否补授 —— 不能偷偷按全选回填，否则等于静默给权限。
      const bt = Array.isArray(row.businessTypes) ? [...row.businessTypes] : [];
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
      allowed, UNAUTH_MODE, ROLE_OPTS, BUSINESS_OPTS: bizOpts, list, total, page, size, loading, kw, filterStatus, dialogVisible, editing, saving, form,
      selection, onSelectionChange, batchVisible, batchForm, previewNames, openBatch, applyBatch, unauthInherit,
      roleLabel, businessLabels: businessNames, search, reset, onPage, openCreate, openEdit, save, toggle, approve, resetPwd, remove, onCmd,
      Search, Refresh, Plus, Edit, Delete, Key, ArrowDown
    };
  }
};
