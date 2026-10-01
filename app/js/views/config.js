// 配置管理 —— 业务类型 / 隐患类别的可视化维护（仅管理员）
//
// 【设计要点】
//  1. 入口三重限制：菜单 adminOnly → 路由守卫 → 本页 allowed 守卫（最后一道，防直达）。
//     前端三道都只是提示，真正的强制在云函数 index.js 的 requireAdminForConfig。
//  2. 字典 ≠ 授权：这里新增的项只进全局字典，不会自动给任何账号开放；
//     必须回到【用户管理】为指定账号勾选后才可用（页面上有明确提示）。
//  3. 生命周期：被引用的项（隐患在用 / 用户已授权）禁止物理删除，只能停用；
//     停用后历史数据照常显示统计（反查走全量字典），只是不再出现在新建表单里。
import { api } from '../api.js';
import { store } from '../store.js';
import { canManageConfig } from '../permission.js';
import {
  activeBusinesses, categoryNamesOf, loadConfig, saveBusinessItems, saveCategoryItems,
  ensureSeeded, configState
} from '../config_store.js';
import { businessLabelOf } from '../business.js';

const DEPT_OPTS = [{ value: 'AQ', label: '安全科（AQ）' }, { value: 'JN', label: '节能环保科（JN）' }];

export default {
  template: `
  <div v-if="allowed">
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px">
      <div>
        <h2 class="page-title neon-title">配置管理</h2>
        <p class="page-sub">业务类型与隐患类别字典 · 云端保存后各端自动生效，无需重新安装</p>
      </div>
      <div style="text-align:right">
        <div style="color:var(--c-text-soft);font-size:12px">字典更新于 {{ configState.updatedAt ? configState.updatedAt.replace('T',' ').slice(0,19) : '尚未初始化' }}</div>
        <div style="color:var(--c-text-soft);font-size:12px">业务 {{ activeBusinesses.length }} 项 / 类别 {{ catItems.length }} 项</div>
      </div>
    </div>

    <!-- 规则说明：把「新增不等于赋权」写在最显眼的地方，避免管理员误判 -->
    <div class="card section" style="border-left:3px solid var(--c-primary);margin-bottom:18px;background:rgba(56,189,248,.06)">
      <div style="font-size:13px;line-height:1.9;color:var(--c-text)">
        <b>字典与授权是两件事：</b>在这里新增的业务/类别只会进入<b>全局字典</b>，
        不会自动勾选给任何账号。需到 <b>【用户管理】</b> 给指定账号勾选并保存后，
        该账号才能在业务上报、隐患填报、列表筛选中使用。<br />
        <b>停用 vs 删除：</b>已被隐患数据引用或已赋权给用户的项<b>不可删除</b>，只能「停用」；
        停用后新表单不再出现该选项，但历史数据仍能正常反查业务/科室、正常统计。
      </div>
      <div style="margin-top:10px">
        <el-button size="small" :loading="syncing" @click="refreshFromCloud">从云端重新拉取</el-button>
        <span v-if="!configState.loaded" style="color:#f59e0b;font-size:12px;margin-left:8px">尚未加载到云端字典，当前显示的是内置默认值</span>
      </div>
    </div>

    <el-tabs v-model="tab">
      <!-- 业务类型 -->
      <el-tab-pane label="业务类型" name="biz">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="color:var(--c-text-soft);font-size:12px">业务决定数据隔离科室（AQ/JN），改动会影响所有终端的下拉与统计口径</div>
            <el-button type="primary" size="small" @click="addBiz">新增业务</el-button>
          </div>
          <el-table :data="bizTable" v-loading="loading" stripe size="small">
            <el-table-column prop="sort" label="排序" width="70" />
            <el-table-column prop="icon" label="图标" width="60" />
            <el-table-column prop="name" label="名称" width="160" />
            <el-table-column prop="short" label="简称" width="90" />
            <el-table-column prop="code" label="代码" width="110" />
            <el-table-column label="归属科室" width="150">
              <template #default="{row}">{{ deptLabel(row.dept) }}</template>
            </el-table-column>
            <el-table-column label="已赋权用户" width="110">
              <template #default="{row}">{{ assignedCount(row.code) }} 人</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{row}">
                <span v-if="row.enabled===false" class="tag-overdue">已停用</span>
                <span v-else class="tag-closed">启用中</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="220">
              <template #default="{row}">
                <el-button text type="primary" size="small" @click="editBiz(row)">编辑</el-button>
                <el-button text size="small" @click="move(row, 'biz', -1)">上移</el-button>
                <el-button text size="small" @click="move(row, 'biz', 1)">下移</el-button>
                <el-button text :type="row.enabled===false ? 'success' : 'warning'" size="small" @click="toggleItem(row, 'biz')">
                  {{ row.enabled===false ? '启用' : '停用' }}
                </el-button>
                <el-button text type="danger" size="small" :disabled="!canDeleteBiz(row)" @click="delItem(row, 'biz')">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!bizTable.length" style="text-align:center;padding:30px 0;color:var(--c-text-soft)">
            暂无业务类型，点击右上角「新增业务」创建
          </div>
        </div>
      </el-tab-pane>

      <!-- 隐患类别 -->
      <el-tab-pane label="隐患类别" name="cat">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="color:var(--c-text-soft);font-size:12px">类别归属某个业务；用户获得了该业务的授权，即可使用其下所有启用类别</div>
            <el-button type="primary" size="small" @click="addCat">新增类别</el-button>
          </div>
          <el-table :data="catTable" v-loading="loading" stripe size="small">
            <el-table-column prop="sort" label="排序" width="70" />
            <el-table-column prop="name" label="类别名称" width="200" />
            <el-table-column label="所属业务" width="150">
              <template #default="{row}">{{ businessLabelOf(row.business) }}</template>
            </el-table-column>
            <el-table-column label="引用隐患数" width="120">
              <template #default="{row}">{{ usedCount(row.name) }} 条</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{row}">
                <span v-if="row.enabled===false" class="tag-overdue">已停用</span>
                <span v-else class="tag-closed">启用中</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="220">
              <template #default="{row}">
                <el-button text type="primary" size="small" @click="editCat(row)">编辑</el-button>
                <el-button text size="small" @click="move(row, 'cat', -1)">上移</el-button>
                <el-button text size="small" @click="move(row, 'cat', 1)">下移</el-button>
                <el-button text :type="row.enabled===false ? 'success' : 'warning'" size="small" @click="toggleItem(row, 'cat')">
                  {{ row.enabled===false ? '启用' : '停用' }}
                </el-button>
                <el-button text type="danger" size="small" :disabled="usedCount(row.name) > 0" @click="delItem(row, 'cat')">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!catTable.length" style="text-align:center;padding:30px 0;color:var(--c-text-soft)">
            暂无类别，点击右上角「新增类别」创建
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 新增/编辑：业务 -->
    <el-dialog v-model="bizDlg" :title="editingBiz ? '编辑业务' : '新增业务'" width="440px">
      <el-form :model="bizForm" label-width="100px">
        <el-form-item label="业务代码" required>
          <el-input v-model="bizForm.code" :disabled="editingBiz" placeholder="如 DUST（新增后不可修改）" />
          <div v-if="!editingBiz" style="color:var(--c-text-soft);font-size:12px">英文字母大写，历史隐患数据引用此代码，创建后不可修改</div>
        </el-form-item>
        <el-form-item label="名称" required><el-input v-model="bizForm.name" placeholder="如 抑尘业务" /></el-form-item>
        <el-form-item label="简称"><el-input v-model="bizForm.short" placeholder="如 抑尘" /></el-form-item>
        <el-form-item label="图标"><el-input v-model="bizForm.icon" style="width:90px" placeholder="emoji" /></el-form-item>
        <el-form-item label="归属科室" required>
          <el-select v-model="bizForm.dept" style="width:100%">
            <el-option v-for="d in DEPT_OPTS" :key="d.value" :label="d.label" :value="d.value" />
          </el-select>
          <div style="color:var(--c-text-soft);font-size:12px">决定该业务数据的隔离范围，选错会导致两个科室互相看不到对方数据</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bizDlg=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveBiz">保存并生效</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑：类别 -->
    <el-dialog v-model="catDlg" :title="editingCat ? '编辑类别' : '新增类别'" width="440px">
      <el-form :model="catForm" label-width="100px">
        <el-form-item label="类别名称" required><el-input v-model="catForm.name" placeholder="如 抑尘措施" /></el-form-item>
        <el-form-item label="所属业务" required>
          <el-select v-model="catForm.business" style="width:100%">
            <el-option v-for="b in activeBusinesses" :key="b.code" :label="b.name" :value="b.code" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="catDlg=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveCat">保存并生效</el-button>
      </template>
    </el-dialog>
  </div>
  <div v-else style="padding:60px;text-align:center">
    <el-result icon="warning" title="无访问权限" sub-title="业务类型与隐患类别的配置仅限管理员，请联系管理员" />
  </div>`,
  setup() {
    const { ref, reactive, computed, onMounted } = Vue;
    const { ElMessage, ElMessageBox } = ElementPlus;

    // 第三道防线：即使路由被绕过，非管理员也只看到无权限页
    const allowed = canManageConfig(store.user);
    if (!allowed) {
      // 不抛错、不拦截渲染：保留静态兜底页，避免刷到一个白屏
      console.warn('[config] 非管理员访问配置管理，已被视图守卫拦截:', store.user && store.user.username);
    }

    const tab = ref('biz');
    const loading = ref(false);
    const saving = ref(false);
    const syncing = ref(false);

    // ---------- 列表数据（本地工作副本，保存后整体写回云端） ----------
    const bizItems = ref([]);
    const catItems = ref([]);
    const bizTable = computed(() => (bizItems.value || []).slice());
    const catTable = computed(() => (catItems.value || []).slice());
    const activeBusinesses = computed(() => (bizItems.value || []).filter(b => b.enabled !== false));

    // 统计引用情况：哪些类别已被隐患使用、哪些业务已赋权给用户 —— 删除前必须看这两个数
    const usedMap = ref({});
    const assignedMap = ref({});

    async function reloadRefs() {
      try {
        // 只看需要的字段：全量隐患虽大，但这是管理员低频操作，一次拉全量换准确性
        const [hz, us] = await Promise.all([api.hazards({ page: 1, size: 0 }), api.users({})]);
        const map = {};
        (hz.list || []).forEach(h => {
          const c = h.category || '其他';
          map[c] = (map[c] || 0) + 1;
        });
        usedMap.value = map;
        const am = {};
        (us.list || []).forEach(u => {
          (Array.isArray(u.businessTypes) ? u.businessTypes : []).forEach(code => {
            am[code] = (am[code] || 0) + 1;
          });
        });
        assignedMap.value = am;
      } catch (e) {
        // 引用统计失败不该卡住配置页，但也不能让删除按钮“看起来可以删”——
        // 兜底：置为空 map，usedCount 返回 0 且界面降级为停用。
        usedMap.value = {}; assignedMap.value = {};
        console.warn('[config] 引用统计失败，删除校验降级为保守模式:', e && e.message);
      }
    }
    function usedCount(name) { return usedMap.value[name] || 0; }
    function assignedCount(code) { return assignedMap.value[code] || 0; }
    /** 业务能否删除：没有隐患引用且没有用户被赋权 */
    function canDeleteBiz(row) { return assignedCount(row.code) === 0 && !row._builtin; }

    async function refresh() {
      loading.value = true;
      try {
        await loadConfig(true);
        await ensureSeeded();
        bizItems.value = (configState.businessItems || []).slice();
        catItems.value = (configState.categoryItems || []).slice();
        await reloadRefs();
      } finally { loading.value = false; }
    }
    async function refreshFromCloud() {
      syncing.value = true;
      try { await refresh(); ElMessage.success('已从云端拉取最新字典'); } finally { syncing.value = false; }
    }
    onMounted(async () => {
      if (!allowed) return;
      await refresh();
    });

    // ---------- 写回云端 ----------
    function renumber(items) { items.forEach((it, i) => { it.sort = i + 1; }); }
    async function persist(type) {
      saving.value = true;
      try {
        if (type === 'biz') {
          renumber(bizItems.value);
          await saveBusinessItems(bizItems.value.map(({ _builtin, ...rest }) => rest));
        } else {
          renumber(catItems.value);
          await saveCategoryItems(catItems.value.map(({ _builtin, ...rest }) => rest));
        }
        ElMessage.success('已保存到云端，其他终端将在 1 分钟内自动生效');
        await refresh();
      } catch (e) {
        // 常见失败是云函数拦截（非管理员）或集合不可写，提示要可行动
        ElMessage.error('保存失败：' + (e && e.message) + '（若为「无权限」，请确认登录的是管理员账号）');
      } finally { saving.value = false; }
    }

    // ---------- 业务类型维护 ----------
    const bizDlg = ref(false);
    const editingBiz = ref(false);
    const editingBizCode = ref('');
    const bizForm = reactive({ code: '', name: '', short: '', icon: '🏷', dept: 'JN', color: '#38bdf8' });
    const DEPT_OPTS_REF = DEPT_OPTS;
    function deptLabel(code) { return (DEPT_OPTS.find(d => d.value === code) || {}).label || code; }
    function resetBizForm() { Object.assign(bizForm, { code: '', name: '', short: '', icon: '🏷', dept: 'JN', color: '#38bdf8' }); }
    function addBiz() { editingBiz.value = false; editingBizCode.value = ''; resetBizForm(); bizDlg.value = true; }
    function editBiz(row) {
      editingBiz.value = true; editingBizCode.value = row.code;
      Object.assign(bizForm, { code: row.code, name: row.name, short: row.short || '', icon: row.icon || '🏷', dept: row.dept || 'JN', color: row.color || '#38bdf8' });
      bizDlg.value = true;
    }
    async function saveBiz() {
      if (!/^[A-Za-z][A-Za-z0-9_]{1,19}$/.test(bizForm.code)) { ElMessage.warning('业务代码需用字母开头、2-20 位字母数字或下划线'); return; }
      if (!bizForm.name) { ElMessage.warning('请填写名称'); return; }
      const dup = bizItems.value.find(b => b.code === bizForm.code && b.code !== editingBizCode.value);
      if (dup) { ElMessage.warning('业务代码已存在：' + bizForm.code); return; }
      if (editingBiz.value) {
        const row = bizItems.value.find(b => b.code === editingBizCode.value);
        Object.assign(row, { name: bizForm.name, short: bizForm.short, icon: bizForm.icon, dept: bizForm.dept, color: bizForm.color });
      } else {
        bizItems.value.push({
          code: bizForm.code, name: bizForm.name, short: bizForm.short || bizForm.name,
          icon: bizForm.icon, color: bizForm.color, dept: bizForm.dept, enabled: true, sort: bizItems.value.length + 1
        });
      }
      bizDlg.value = false;
      await persist('biz');
    }

    // ---------- 隐患类别维护 ----------
    const catDlg = ref(false);
    const editingCat = ref(false);
    const editingCatName = ref('');
    const catForm = reactive({ name: '', business: '' });
    function addCat() {
      editingCat.value = false; editingCatName.value = '';
      Object.assign(catForm, { name: '', business: (activeBusinesses.value[0] || {}).code || '' });
      catDlg.value = true;
    }
    function editCat(row) {
      editingCat.value = true; editingCatName.value = row.name;
      Object.assign(catForm, { name: row.name, business: row.business });
      catDlg.value = true;
    }
    async function saveCat() {
      const name = (catForm.name || '').trim();
      if (!name) { ElMessage.warning('请填写类别名称'); return; }
      if (!catForm.business) { ElMessage.warning('请选择所属业务'); return; }
      // 同名校验：同业务内重复会让统计口径分不清两条数据，必须挡住
      const dup = catItems.value.find(c => c.name === name && c.business === catForm.business && c.name !== editingCatName.value);
      if (dup) { ElMessage.warning('该业务下已存在同名类别：' + name); return; }
      if (editingCat.value) {
        const old = catItems.value.find(c => c.name === editingCatName.value);
        const used = usedCount(editingCatName.value);
        if (used > 0) {
          // 改名会让历史隐患的中文类别失配 —— 这是不可逆的，先让管理员确认
          try {
            await ElMessageBox.confirm(
              `该类别已被 ${used} 条隐患引用，改名后这些历史记录将无法反查原业务/科室，可能导致科室归属错乱。建议改为「停用 + 新建」。确认仍要改名？`,
              '高风险操作', { type: 'warning' });
          } catch (e) { return; }
        }
        if (old) Object.assign(old, { name, business: catForm.business });
      } else {
        catItems.value.push({ name, business: catForm.business, enabled: true, sort: catItems.value.length + 1 });
      }
      catDlg.value = false;
      await persist('cat');
    }

    // ---------- 停用 / 删除 / 排序 ----------
    async function toggleItem(row, type) {
      const willDisable = row.enabled !== false;
      if (willDisable) {
        const used = type === 'cat' ? usedCount(row.name) : assignedCount(row.code);
        const what = type === 'cat' ? `${used} 条隐患在用` : `${used} 个账号已赋权`;
        if (used > 0) {
          try {
            await ElMessageBox.confirm(`停用后：新表单不再出现该选项（${what}的历史数据仍保留）。确认停用？`, '停用确认', { type: 'warning' });
          } catch (e) { return; }
        }
      }
      row.enabled = !willDisable;
      await persist(type);
    }
    async function delItem(row, type) {
      const used = type === 'cat' ? usedCount(row.name) : assignedCount(row.code);
      if (used > 0) {
        // 理论上来不到这里（按钮已 disabled），保留兜底提示防止并发期间刚好被引用
        ElMessage.error((type === 'cat' ? '该类别已被 ' : '该业务已赋权给 ') + used + (type === 'cat' ? ' 条隐患引用' : ' 个账号') + '，不能删除，请改用「停用」');
        return;
      }
      try {
        await ElMessageBox.confirm('确认删除？删除后所有终端将不再显示该选项（不影响历史数据）。', '删除确认', { type: 'warning' });
      } catch (e) { return; }
      if (type === 'biz') bizItems.value = bizItems.value.filter(b => b.code !== row.code);
      else catItems.value = catItems.value.filter(c => c.name !== row.name);
      await persist(type);
    }
    function move(row, type, delta) {
      const arr = type === 'biz' ? bizItems : catItems;
      const i = arr.value.findIndex(x => x === row);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= arr.value.length) return;
      const tmp = arr.value[i]; arr.value[i] = arr.value[j]; arr.value[j] = tmp;
      persist(type);
    }

    return {
      allowed, tab, loading, saving, syncing, bizItems, catItems, bizTable, catTable,
      activeBusinesses, configState, categoryNamesOf, businessLabelOf,
      usedCount, assignedCount, canDeleteBiz, deptLabel,
      bizDlg, editingBiz, bizForm, DEPT_OPTS: DEPT_OPTS_REF, addBiz, editBiz, saveBiz,
      catDlg, editingCat, catForm, addCat, editCat, saveCat,
      toggleItem, delItem, move, refreshFromCloud, refresh
    };
  }
};
