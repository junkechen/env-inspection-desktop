import { api, STATUS_MAP, SEVERITY_MAP } from '../api.js';
import { store } from '../store.js';
import { uploadFiles } from '../image_upload.js';
import {
  isAdmin, canLikeSuggestion, canScoreSuggestion, canResolveSuggestion, isSafetyEnvStaff
} from '../permission.js';
import { currentDept } from '../dept.js';
import { deptOf } from '../business.js';

// 合理化建议字段与状态严格对齐 APK（suggestion.dart）：
//   category 存中文（节能降耗…）；status 存中文（待评审/已采纳/未采纳/已实施）；
//   scores[].{feasibility,benefit,innovation} 0-10；weighted = 可行*0.4 + 效益*0.4 + 创新*0.2；
//   level ∈ {一等奖,二等奖,三等奖,优秀奖}。
const CATEGORY_OPTS = ['节能降耗', '安全生产', '环境保护', '工艺优化', '设备改进', '管理提升', '其他'];
const STATUS_OPTS = [
  { value: '待评审', label: '待评审' },
  { value: '已采纳', label: '已采纳' },
  { value: '未采纳', label: '未采纳' },
  { value: '已实施', label: '已实施' }
];
const LEVEL_OPTS = ['一等奖', '二等奖', '三等奖', '优秀奖'];

function statusClass(st) {
  if (st === '已采纳' || st === '已实施') return 'tag-closed';
  if (st === '未采纳') return 'tag-overdue';
  return 'tag-pending';
}
function fmtDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }
function myId() {
  const u = store.user || {};
  return u._id || u.id || u.username || u.name || '';
}

export default {
  template: `
  <div>
    <h2 class="page-title neon-title">合理化建议</h2>
    <p class="page-sub">全员提案 · 点赞 · 专家加权评分 · 安环部决议定级 · 与移动端同源</p>

    <div class="toolbar">
      <el-input v-model="kw" placeholder="标题/提报人/部门/建议内容" clearable style="width:260px" @keyup.enter="search" />
      <el-select v-model="filterStatus" placeholder="状态" clearable style="width:130px">
        <el-option v-for="o in STATUS_OPTS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="filterCategory" placeholder="类别" clearable style="width:140px">
        <el-option v-for="c in CATEGORY_OPTS" :key="c" :label="c" :value="c" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="search">查询</el-button>
      <el-button :icon="Refresh" @click="reset">重置</el-button>
      <span class="spacer"></span>
      <el-button type="success" :icon="Plus" @click="openCreate">提报建议</el-button>
      <el-button type="warning" :icon="Download" :loading="exporting" @click="exportExcel">导出Excel</el-button>
    </div>

    <div class="card" style="min-width:0">
      <div class="table-wrap">
      <el-table :data="list" v-loading="loading" size="default" stripe>
        <el-table-column label="编号" width="160">
          <template #default="{row}">{{ row.id || row._id }}</template>
        </el-table-column>
        <el-table-column label="标题" min-width="180" show-overflow-tooltip>
          <template #default="{row}">{{ row.title || '—' }}</template>
        </el-table-column>
        <el-table-column prop="name" label="提报人" width="100" />
        <el-table-column prop="department" label="部门" width="120" />
        <el-table-column prop="category" label="类别" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="{row}"><span :class="statusClass(row.status)">{{ row.status || '待评审' }}</span></template>
        </el-table-column>
        <el-table-column label="点赞" width="70">
          <template #default="{row}"><span style="color:#f59e0b">{{ (row.likedBy||[]).length }}</span></template>
        </el-table-column>
        <el-table-column label="均分" width="80">
          <template #default="{row}"><span>{{ avgScore(row) || '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="level" label="获奖等级" width="90" />
        <el-table-column label="提报时间" width="150">
          <template #default="{row}">{{ fmtDate(row.date || row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{row}">
            <el-button text type="primary" :icon="View" @click="openDetail(row)">详情</el-button>
            <el-button v-if="canLikeSuggestion(me) && !isLiked(row)" text type="warning" :icon="Pointer" @click="toggleLike(row)">点赞</el-button>
            <el-button v-if="canLikeSuggestion(me) && isLiked(row)" text type="info" :icon="Pointer" @click="toggleLike(row)">取消赞</el-button>
            <el-button v-if="canScoreSuggestion(me) && row.status==='待评审'" text type="success" :icon="Star" @click="openScore(row)">评分</el-button>
            <el-button v-if="canResolveSuggestion(me) && row.status==='待评审'" text type="danger" :icon="Settlement" @click="openResolve(row)">决议</el-button>
            <el-button v-if="canEdit(row)" text type="info" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="isAdmin(me)" text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end;align-items:center;gap:12px">
        <el-pagination background layout="total, sizes, prev, pager, next, jumper" :total="total" :page-size="size" :page-sizes="[10,20,50,100]" :current-page="page" @current-change="onPage" @size-change="onSize" />
      </div>
    </div>

    <!-- 详情 -->
    <el-dialog v-model="detailVisible" width="820px" top="5vh" :close-on-click-modal="false">
      <template #header>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="back-inline" @click="detailVisible=false" title="返回"><ArrowLeft style="width:16px;height:16px" /></span>
          <span style="font-weight:600">建议详情</span>
        </div>
      </template>
      <div v-if="current" style="max-height:70vh;overflow:auto;padding-right:6px">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="编号" :span="2">{{ current.id || current._id }}</el-descriptions-item>
          <el-descriptions-item label="标题" :span="2">{{ current.title || '—' }}</el-descriptions-item>
          <el-descriptions-item label="提报人">{{ current.name }}</el-descriptions-item>
          <el-descriptions-item label="工号">{{ current.employeeNo || '—' }}</el-descriptions-item>
          <el-descriptions-item label="部门">{{ current.department }}</el-descriptions-item>
          <el-descriptions-item label="联系电话">{{ current.phone || '—' }}</el-descriptions-item>
          <el-descriptions-item label="类别">{{ current.category }}</el-descriptions-item>
          <el-descriptions-item label="状态"><span :class="statusClass(current.status)">{{ current.status || '待评审' }}</span></el-descriptions-item>
          <el-descriptions-item label="提报日期">{{ fmtDate(current.date || current.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="获奖等级">{{ current.level || '—' }}</el-descriptions-item>
        </el-descriptions>

        <h3 style="margin:14px 0 8px;color:#fff">现状/问题描述</h3>
        <div style="color:var(--c-text-soft);font-size:13px;line-height:1.6;white-space:pre-wrap">{{ current.currentSituation || '—' }}</div>
        <h3 style="margin:14px 0 8px;color:#fff">改进建议</h3>
        <div style="color:var(--c-text-soft);font-size:13px;line-height:1.6;white-space:pre-wrap">{{ current.proposal || '—' }}</div>
        <h3 style="margin:14px 0 8px;color:#fff">预期效果/效益</h3>
        <div style="color:var(--c-text-soft);font-size:13px;line-height:1.6;white-space:pre-wrap">{{ current.expectedBenefit || '—' }}</div>

        <h3 style="margin:14px 0 8px;color:#fff">现场照片</h3>
        <div v-if="current.attachments && current.attachments.length" style="display:flex;gap:8px;flex-wrap:wrap">
          <el-image v-for="(img,i) in current.attachments" :key="i" :src="img" :preview-src-list="current.attachments" style="width:90px;height:90px;border-radius:8px;border:1px solid var(--c-border)" fit="cover" />
        </div>
        <span v-else style="color:var(--c-text-soft);font-size:13px">暂无图片</span>

        <h3 style="margin:14px 0 8px;color:#fff">评审与评分</h3>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:8px">
          <span>点赞 <b style="color:#f59e0b">{{ (current.likedBy||[]).length }}</b> 人</span>
          <span>加权均分 <b style="color:#38bdf8">{{ avgScore(current) || '—' }}</b></span>
          <el-button v-if="canLikeSuggestion(me) && !isLiked(current)" size="small" type="warning" :icon="Pointer" @click="toggleLike(current)">点赞</el-button>
          <el-button v-if="canLikeSuggestion(me) && isLiked(current)" size="small" type="info" :icon="Pointer" @click="toggleLike(current)">取消赞</el-button>
          <el-button v-if="canScoreSuggestion(me) && current.status==='待评审'" size="small" type="success" :icon="Star" @click="openScore(current)">评分</el-button>
          <el-button v-if="canResolveSuggestion(me) && current.status==='待评审'" size="small" type="danger" :icon="Settlement" @click="openResolve(current)">决议</el-button>
        </div>
        <el-table v-if="current.scores && current.scores.length" :data="current.scores" size="small" border style="--el-table-bg-color:transparent;margin-bottom:12px">
          <el-table-column label="评审人" prop="reviewerName" width="120" />
          <el-table-column label="可行性" width="80"><template #default="{row}">{{ row.feasibility }}</template></el-table-column>
          <el-table-column label="效益" width="80"><template #default="{row}">{{ row.benefit }}</template></el-table-column>
          <el-table-column label="创新性" width="80"><template #default="{row}">{{ row.innovation }}</template></el-table-column>
          <el-table-column label="加权得分" width="100"><template #default="{row}"><b style="color:#38bdf8">{{ weighted(row) }}</b></template></el-table-column>
          <el-table-column label="时间" min-width="150"><template #default="{row}">{{ fmtDate(row.at) }}</template></el-table-column>
        </el-table>
        <span v-else style="color:var(--c-text-soft);font-size:13px">暂无评分</span>

        <template v-if="current.reviewNote">
          <h3 style="margin:14px 0 8px;color:#fff">决议意见</h3>
          <div style="color:var(--c-text-soft);font-size:13px">{{ current.reviewerName }}（{{ fmtDate(current.reviewedAt) }}）：{{ current.reviewNote }}</div>
        </template>
      </div>
      <template #footer>
        <el-button @click="detailVisible=false"><ArrowLeft style="width:14px;height:14px;margin-right:4px" />返 回</el-button>
      </template>
    </el-dialog>

    <!-- 评分 -->
    <el-dialog v-model="scoreVisible" title="专家评分（0-10 分）" width="460px" :close-on-click-modal="false">
      <el-form label-width="90px">
        <el-form-item label="可行性"><el-slider v-model="scoreForm.feasibility" :min="0" :max="10" :step="0.5" show-input /></el-form-item>
        <el-form-item label="预期效益"><el-slider v-model="scoreForm.benefit" :min="0" :max="10" :step="0.5" show-input /></el-form-item>
        <el-form-item label="创新性"><el-slider v-model="scoreForm.innovation" :min="0" :max="10" :step="0.5" show-input /></el-form-item>
        <el-alert type="info" :closable="false" title="加权得分 = 可行性×0.4 + 效益×0.4 + 创新性×0.2" />
      </el-form>
      <template #footer>
        <el-button @click="scoreVisible=false">取消</el-button>
        <el-button type="success" :loading="saving" @click="submitScore">提交评分</el-button>
      </template>
    </el-dialog>

    <!-- 决议 -->
    <el-dialog v-model="resolveVisible" title="安环部决议" width="480px" :close-on-click-modal="false">
      <el-form label-width="90px">
        <el-form-item label="决议" required>
          <el-radio-group v-model="resolveForm.status">
            <el-radio-button label="已采纳" />
            <el-radio-button label="未采纳" />
            <el-radio-button label="已实施" />
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="resolveForm.status==='已采纳' || resolveForm.status==='已实施'" label="获奖等级">
          <el-select v-model="resolveForm.level" style="width:100%"><el-option v-for="l in LEVEL_OPTS" :key="l" :label="l" :value="l" /></el-select>
        </el-form-item>
        <el-form-item label="决议意见"><el-input v-model="resolveForm.note" type="textarea" :rows="3" placeholder="填写采纳/未采纳理由" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resolveVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitResolve">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑 -->
    <el-dialog v-model="createVisible" :title="editId ? '编辑建议' : '提报建议'" width="640px" :close-on-click-modal="false">
      <el-form :model="form" label-width="100px">
        <el-form-item label="标题" required><el-input v-model="form.title" placeholder="建议标题" /></el-form-item>
        <el-form-item label="提报人" required><el-input v-model="form.name" placeholder="姓名" /></el-form-item>
        <el-form-item label="工号"><el-input v-model="form.employeeNo" /></el-form-item>
        <el-form-item label="部门" required><el-input v-model="form.department" /></el-form-item>
        <el-form-item label="联系电话"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="提报日期"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="类别" required><el-select v-model="form.category" style="width:100%"><el-option v-for="c in CATEGORY_OPTS" :key="c" :label="c" :value="c" /></el-select></el-form-item>
        <el-form-item label="现状/问题" required><el-input v-model="form.currentSituation" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="改进建议" required><el-input v-model="form.proposal" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="预期效益"><el-input v-model="form.expectedBenefit" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="现场照片">
          <input type="file" accept="image/*" multiple @change="onCreateUpload" :disabled="uploading" />
          <div v-if="uploading" style="color:var(--c-text-soft);font-size:12px;margin-top:4px">上传中...</div>
          <div v-if="form.attachments.length" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <div v-for="(p,i) in form.attachments" :key="i" style="position:relative">
              <el-image :src="p" style="width:60px;height:60px;border-radius:6px;border:1px solid var(--c-border)" fit="cover" />
              <el-button circle size="small" style="position:absolute;top:-6px;right:-6px" @click="form.attachments.splice(i,1)">×</el-button>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>`,
  setup() {
    const { ref, reactive, onMounted, watch, computed } = Vue;
    const { ElMessage } = ElementPlus;
    const { Search, Refresh, Plus, View, Download, ArrowLeft, Edit, Delete, Pointer, Star, Settlement } = ElementPlusIconsVue;

    const me = computed(() => store.user || {});
    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const size = ref(10);
    const loading = ref(false);
    const kw = ref('');
    const filterStatus = ref('');
    const filterCategory = ref('');

    const detailVisible = ref(false);
    const current = ref(null);
    const scoreVisible = ref(false);
    const scoreForm = reactive({ feasibility: 5, benefit: 5, innovation: 5 });
    const resolveVisible = ref(false);
    const resolveForm = reactive({ status: '已采纳', level: '优秀奖', note: '' });
    const createVisible = ref(false);
    const editId = ref(null);
    const saving = ref(false);
    const uploading = ref(false);
    const exporting = ref(false);
    const form = reactive({
      title: '', name: '', employeeNo: '', department: '', phone: '',
      date: '', category: '其他', currentSituation: '', proposal: '', expectedBenefit: '', attachments: []
    });

    function avgScore(row) {
      const s = (row && row.scores) || [];
      if (!s.length) return '';
      const sum = s.reduce((a, x) => a + weighted(x), 0);
      return (sum / s.length).toFixed(1);
    }
    function weighted(x) {
      const f = Number(x.feasibility) || 0, b = Number(x.benefit) || 0, i = Number(x.innovation) || 0;
      return (f * 0.4 + b * 0.4 + i * 0.2).toFixed(1);
    }
    function isLiked(row) {
      const liked = (row && row.likedBy) || [];
      return liked.includes(myId());
    }
    function canEdit(row) {
      if (!row) return false;
      if (isAdmin(me.value)) return true;
      // 提案人本人且尚未进入决议（待评审）可编辑
      return (row.name === (me.value.name || me.value.username)) && row.status === '待评审';
    }

    function closeTopDialog() {
      if (detailVisible.value) { detailVisible.value = false; return true; }
      if (scoreVisible.value) { scoreVisible.value = false; return true; }
      if (resolveVisible.value) { resolveVisible.value = false; return true; }
      if (createVisible.value) { createVisible.value = false; return true; }
      return false;
    }
    watch([detailVisible, scoreVisible, resolveVisible, createVisible], (vals) => {
      store.backHandler = vals.some(v => v) ? closeTopDialog : null;
    });

    async function load() {
      loading.value = true;
      try {
        const r = await api.suggestions({ status: filterStatus.value, category: filterCategory.value, keyword: kw.value, page: 1, size: 0 });
        let all = (r.list || []);
        // 安环部/管理员可见全部；被审核人/普通用户可见全部（建议是公开征集，全员可读）
        const start = (page.value - 1) * size.value;
        list.value = all.slice(start, start + size.value);
        total.value = all.length;
      } finally { loading.value = false; }
    }
    function search() { page.value = 1; load(); }
    function onSize(v) { size.value = v; page.value = 1; load(); }
    function onPage(p) { page.value = p; load(); }
    function reset() {
      kw.value = ''; filterStatus.value = ''; filterCategory.value = '';
      api.refreshCache('suggestions');
      search();
    }

    async function openDetail(row) {
      const r = await api.suggestions({});
      current.value = (r.list || []).find(x => (x._id || x.id) === (row._id || row.id)) || row;
      detailVisible.value = true;
    }

    async function toggleLike(row) {
      try {
        const liked = isLiked(row);
        const likedBy = (row.likedBy || []).slice();
        if (liked) {
          const i = likedBy.indexOf(myId());
          if (i >= 0) likedBy.splice(i, 1);
        } else {
          if (!likedBy.includes(myId())) likedBy.push(myId());
        }
        const id = row._id || row.id;
        await api.updateSuggestion(id, { likedBy, updatedAt: new Date().toISOString() });
        row.likedBy = likedBy;
        if (current.value && (current.value._id || current.value.id) === id) current.value.likedBy = likedBy;
        ElMessage.success(liked ? '已取消点赞' : '点赞成功');
      } catch (e) { ElMessage.error(e.message); }
    }

    function openScore(row) {
      current.value = row;
      scoreForm.feasibility = 5; scoreForm.benefit = 5; scoreForm.innovation = 5;
      scoreVisible.value = true;
    }
    async function submitScore() {
      saving.value = true;
      try {
        const u = store.user || {};
        const row = current.value;
        const scores = (row.scores || []).slice();
        // 同一评审人重复评分覆盖旧分（对齐 APK）
        const idx = scores.findIndex(s => (s.reviewerId || s.reviewerName) === (u._id || u.username || u.name));
        const entry = {
          reviewerId: u._id || u.username || u.name || '',
          reviewerName: u.name || u.username || '',
          feasibility: scoreForm.feasibility,
          benefit: scoreForm.benefit,
          innovation: scoreForm.innovation,
          at: new Date().toISOString()
        };
        if (idx >= 0) scores[idx] = entry; else scores.push(entry);
        const id = row._id || row.id;
        await api.updateSuggestion(id, { scores, updatedAt: new Date().toISOString() });
        row.scores = scores;
        if (current.value) current.value.scores = scores;
        scoreVisible.value = false;
        ElMessage.success('评分已提交');
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    function openResolve(row) {
      current.value = row;
      resolveForm.status = '已采纳';
      resolveForm.level = '优秀奖';
      resolveForm.note = '';
      resolveVisible.value = true;
    }
    async function submitResolve() {
      saving.value = true;
      try {
        const u = store.user || {};
        const row = current.value;
        const id = row._id || row.id;
        const update = {
          status: resolveForm.status,
          reviewerId: u._id || u.username || '',
          reviewerName: u.name || u.username || '',
          reviewNote: resolveForm.note,
          reviewedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        if (resolveForm.status === '已采纳' || resolveForm.status === '已实施') update.level = resolveForm.level;
        await api.updateSuggestion(id, update);
        row.status = update.status;
        row.level = update.level || '';
        if (current.value) { current.value.status = update.status; current.value.level = update.level || ''; }
        resolveVisible.value = false;
        ElMessage.success('决议已保存');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    async function onCreateUpload(e) {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      uploading.value = true;
      try {
        const urls = await uploadFiles(files, api, { targetKb: 80, maxFiles: 9 });
        form.attachments.push(...urls);
        ElMessage.success(`已添加 ${urls.length} 张图片`);
      } catch (err) { ElMessage.error(err.message); }
      finally { uploading.value = false; e.target.value = ''; }
    }
    function openCreate() {
      const u = store.user || {};
      Object.assign(form, {
        title: '', name: u.name || u.username || '', employeeNo: '', department: u.department || '', phone: '',
        date: new Date().toISOString().slice(0, 10), category: '其他', currentSituation: '', proposal: '', expectedBenefit: '', attachments: []
      });
      editId.value = null;
      createVisible.value = true;
    }
    function openEdit(row) {
      Object.assign(form, {
        title: row.title || '', name: row.name || '', employeeNo: row.employeeNo || '', department: row.department || '', phone: row.phone || '',
        date: (row.date || row.createdAt || '').slice(0, 10) || '', category: row.category || '其他',
        currentSituation: row.currentSituation || '', proposal: row.proposal || '', expectedBenefit: row.expectedBenefit || '',
        attachments: Array.isArray(row.attachments) ? row.attachments.slice() : []
      });
      editId.value = row._id || row.id;
      createVisible.value = true;
    }
    async function save() {
      if (!form.title || !form.name || !form.department || !form.category) { ElMessage.warning('请填写标题、提报人、部门和类别'); return; }
      if (!form.currentSituation || !form.proposal) { ElMessage.warning('请填写现状问题和改进建议'); return; }
      saving.value = true;
      try {
        const u = store.user || {};
        const now = new Date().toISOString();
        if (editId.value) {
          await api.updateSuggestion(editId.value, {
            title: form.title, name: form.name, employeeNo: form.employeeNo, department: form.department, phone: form.phone,
            date: form.date ? new Date(form.date).toISOString() : now, category: form.category,
            currentSituation: form.currentSituation, proposal: form.proposal, expectedBenefit: form.expectedBenefit,
            attachments: form.attachments, updatedAt: now
          });
          ElMessage.success('建议已更新');
        } else {
          await api.createSuggestion({
            title: form.title, name: form.name, employeeNo: form.employeeNo, department: form.department, phone: form.phone,
            date: form.date ? new Date(form.date).toISOString() : now, category: form.category,
            currentSituation: form.currentSituation, proposal: form.proposal, expectedBenefit: form.expectedBenefit,
            attachments: form.attachments, status: '待评审', likedBy: [], scores: [], level: '',
            deptCode: deptOf('ENV') || 'JN', createdAt: now, updatedAt: now
          });
          ElMessage.success('建议已提报');
        }
        createVisible.value = false;
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('删除后将从列表移除（软删除，可在云端恢复）。确定删除吗？', '删除建议', { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' });
      } catch (e) { return; }
      saving.value = true;
      try {
        await api.deleteSuggestion(row._id || row.id);
        ElMessage.success('建议已删除');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    function ts() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }
    async function exportExcel() {
      if (!window.XLSX) { ElMessage.error('Excel 组件未加载，请重启客户端'); return; }
      if (!window.electronAPI) { ElMessage.error('本地导出能力不可用'); return; }
      exporting.value = true;
      try {
        const r = await api.suggestions({ status: filterStatus.value, category: filterCategory.value, keyword: kw.value, page: 1, size: 0 });
        const all = r.list || [];
        if (!all.length) { ElMessage.warning('当前筛选无数据可导出'); return; }
        const headers = ['编号', '标题', '提报人', '工号', '部门', '电话', '类别', '状态', '点赞数', '加权均分', '获奖等级', '提报日期', '现状描述', '改进建议', '预期效益'];
        const rows = all.map((x, i) => [
          x.id || x._id, x.title, x.name, x.employeeNo, x.department, x.phone, x.category, x.status || '待评审',
          (x.likedBy || []).length, avgScore(x), x.level || '', (x.date || x.createdAt || '').slice(0, 10),
          x.currentSituation, x.proposal, x.expectedBenefit
        ]);
        const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, '合理化建议');
        const b64 = window.XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const res = await window.electronAPI.saveXlsxEnhanced({ defaultName: 'GZ合理化建议_' + ts() + '.xlsx', buffer: b64, plan: {} });
        if (res && res.error) ElMessage.error('导出失败：' + res.error);
        else if (res && !res.canceled) ElMessage.success('Excel 已保存：' + res.filePath);
      } catch (e) { ElMessage.error(e.message || '导出失败'); }
      finally { exporting.value = false; }
    }

    onMounted(load);

    return {
      CATEGORY_OPTS, STATUS_OPTS, LEVEL_OPTS, list, total, page, size, loading, kw, filterStatus, filterCategory, me,
      canLikeSuggestion, canScoreSuggestion, canResolveSuggestion, isAdmin, isSafetyEnvStaff, canEdit,
      detailVisible, current, scoreVisible, scoreForm, resolveVisible, resolveForm, createVisible, editId, saving, uploading, exporting, form,
      search, reset, onPage, onSize, openDetail, toggleLike, isLiked, openScore, submitScore, openResolve, submitResolve,
      onCreateUpload, openCreate, openEdit, save, remove, exportExcel,
      avgScore, weighted, statusClass, fmtDate,
      Search, Refresh, Plus, View, Download, ArrowLeft, Edit, Delete, Pointer, Star, Settlement, STATUS_MAP, SEVERITY_MAP
    };
  }
};
