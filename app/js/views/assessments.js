import { api, STATUS_MAP, SEVERITY_MAP } from '../api.js';
import { store } from '../store.js';
import { uploadFiles } from '../image_upload.js';
import {
  isAdmin, isSafetyEnvStaff, canViewAssessment, canCreateAssessment, canSignAssessment, canFillCorrective, canReviewAssessment
} from '../permission.js';
import { currentDept } from '../dept.js';
import { deptOf } from '../business.js';
import { showExportResult } from '../export_utils.js';

// 模块考核落实单：严格对齐 APK（module_assessment.dart）与纸质模板
//   status：待确认(issued) → 已确认(confirmed) → 整改中(rectifying) → 已闭环(closed)
//   nature：一般不符合 / 严重不符合
//   可见性：安环部 或 被审核人
const BASIS_OPTS = ['GB/T19001-2000 idt ISO9001:2000', '冠洲股份管理模块考核评价标准', '公司、部门制度流程类文件规定', '管理体系程序/文件'];
const CATEGORY_OPTS = ['安全管理', '环保管理', '节能管理', '工艺管理', '设备管理', '现场管理', '台账记录', '其他'];
const STATUS_OPTS = [
  { value: '待确认', label: '待确认' },
  { value: '已确认', label: '已确认' },
  { value: '整改中', label: '整改中' },
  { value: '已闭环', label: '已闭环' }
];

function statusClass(st) {
  if (st === '已闭环') return 'tag-closed';
  if (st === '已确认') return 'tag-pending';
  if (st === '整改中') return 'tag-processing';
  return 'tag-reviewing';
}
function fmtDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }
function myName() { const u = store.user || {}; return u.name || u.username || ''; }

export default {
  template: `
  <div>
    <h2 class="page-title neon-title">模块考核落实单</h2>
    <p class="page-sub">管理模块不符合项报告与纠正措施流转 · 签字确认 · 审核闭环 · 与移动端同源</p>

    <div class="toolbar">
      <el-input v-model="kw" placeholder="编号/受审核部门/受审核人" clearable style="width:260px" @keyup.enter="search" />
      <el-select v-model="filterStatus" placeholder="状态" clearable style="width:130px">
        <el-option v-for="o in STATUS_OPTS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="filterCategory" placeholder="归纳分类" clearable style="width:140px">
        <el-option v-for="c in CATEGORY_OPTS" :key="c" :label="c" :value="c" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="search">查询</el-button>
      <el-button :icon="Refresh" @click="reset">重置</el-button>
      <span class="spacer"></span>
      <el-button v-if="canCreateAssessment(me)" type="success" :icon="Plus" @click="openCreate">下发落实单</el-button>
      <el-button type="warning" :icon="Printer" :loading="exporting" @click="exportPdf">导出PDF</el-button>
      <el-button type="warning" :icon="Download" :loading="exporting" @click="exportExcel">导出Excel</el-button>
    </div>

    <div class="card" style="min-width:0">
      <div class="table-wrap">
      <el-table :data="list" v-loading="loading" size="default" stripe>
        <el-table-column label="编号" width="170"><template #default="{row}">{{ row.reportNo || row._id }}</template></el-table-column>
        <el-table-column prop="auditedDept" label="受审核部门" width="130" />
        <el-table-column prop="auditedPerson" label="受审核人" width="100" />
        <el-table-column prop="auditor" label="审核员" width="100" />
        <el-table-column prop="category" label="归纳分类" width="110" />
        <el-table-column label="性质" width="110"><template #default="{row}">{{ row.nature || '一般不符合' }}</template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{row}"><span :class="statusClass(row.status)">{{ row.status || '待确认' }}</span></template></el-table-column>
        <el-table-column label="创建时间" width="150"><template #default="{row}">{{ fmtDate(row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{row}">
            <el-button text type="primary" :icon="View" @click="openDetail(row)">详情</el-button>
            <el-button v-if="canSignAssessment(me,row)" text type="success" :icon="EditPen" @click="openSign(row)">签字确认</el-button>
            <el-button v-if="canFillCorrective(me,row)" text type="warning" :icon="Edit" @click="openCorrective(row)">纠正措施</el-button>
            <el-button v-if="canReviewAssessment(me,row)" text type="danger" :icon="CircleCheck" @click="openReview(row)">审核闭环</el-button>
            <el-button v-if="isAdmin(me) || isSafetyEnvStaff(me)" text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end;align-items:center;gap:12px">
        <el-pagination background layout="total, sizes, prev, pager, next, jumper" :total="total" :page-size="size" :page-sizes="[10,20,50,100]" :current-page="page" @current-change="onPage" @size-change="onSize" />
      </div>
    </div>

    <!-- 详情：报告单 + 纠正措施表 -->
    <el-dialog v-model="detailVisible" width="880px" top="4vh" :close-on-click-modal="false">
      <template #header>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="back-inline" @click="detailVisible=false" title="返回"><ArrowLeft style="width:16px;height:16px" /></span>
          <span style="font-weight:600">落实单详情 · {{ current && (current.reportNo||current._id) }}</span>
        </div>
      </template>
      <div v-if="current" style="max-height:72vh;overflow:auto;padding-right:6px">
        <h3 style="color:#fff;margin:4px 0 10px">一、管理模块检查不符合项报告单</h3>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="受审核部门">{{ current.auditedDept }}</el-descriptions-item>
          <el-descriptions-item label="受审核人">{{ current.auditedPerson }}</el-descriptions-item>
          <el-descriptions-item label="审核员">{{ current.auditor }}</el-descriptions-item>
          <el-descriptions-item label="其他参与人员">{{ current.participants || '—' }}</el-descriptions-item>
          <el-descriptions-item label="性质">{{ current.nature || '一般不符合' }}</el-descriptions-item>
          <el-descriptions-item label="请于 N 日内反馈">{{ current.feedbackDays || 7 }} 天</el-descriptions-item>
          <el-descriptions-item label="归纳分类">{{ current.category || '其他' }}</el-descriptions-item>
          <el-descriptions-item label="审核依据">{{ (current.basis||[]).join('、') || '—' }}<span v-if="current.basisOther">（其他：{{ current.basisOther }}）</span></el-descriptions-item>
        </el-descriptions>
        <div style="margin:10px 0 16px">
          <b style="color:#fff">不符合项陈述：</b>
          <div style="color:var(--c-text-soft);font-size:13px;line-height:1.6;white-space:pre-wrap;margin-top:4px">{{ current.statement || '—' }}</div>
        </div>
        <div class="card" style="padding:12px;margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span>受审核部门认可意见：<b :style="{color: current.accepted==null?'var(--c-text-soft)':(current.accepted?'#34d399':'#f87171')}">{{ current.accepted==null?'待签':(current.accepted?'同意':'不同意') }}</b></span>
          <span v-if="current.acceptSignatureName">签字人：{{ current.acceptSignatureName }}</span>
          <span v-if="current.acceptSignedAt">签字时间：{{ fmtDate(current.acceptSignedAt) }}</span>
          <el-image v-if="current.acceptSignatureUrl" :src="current.acceptSignatureUrl" style="width:120px;height:60px;object-fit:contain;border:1px solid var(--c-border);border-radius:6px;background:#fff" />
          <span v-if="canSignAssessment(me,current)"><el-button size="small" type="success" :icon="EditPen" @click="openSign(current)">签字确认</el-button></span>
        </div>

        <h3 style="color:#fff;margin:4px 0 10px">二、管理模块纠正措施表</h3>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="不符合项原因分析">{{ current.causeAnalysis || '—' }}</el-descriptions-item>
          <el-descriptions-item label="纠正措施">{{ current.correctiveActions || '—' }}</el-descriptions-item>
          <el-descriptions-item label="纠正措施完成情况">{{ current.completionStatus || '—' }}</el-descriptions-item>
          <el-descriptions-item label="审核员意见">{{ current.auditorOpinion || '—' }}</el-descriptions-item>
          <el-descriptions-item v-if="current.correctiveFilledBy" label="填写人/时间">{{ current.correctiveFilledBy }} · {{ fmtDate(current.correctiveFilledAt) }}</el-descriptions-item>
        </el-descriptions>
        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
          <el-button v-if="canFillCorrective(me,current)" type="warning" :icon="Edit" @click="openCorrective(current)">填写纠正措施</el-button>
          <el-button v-if="canReviewAssessment(me,current)" type="danger" :icon="CircleCheck" @click="openReview(current)">审核并闭环</el-button>
          <el-button :icon="Printer" @click="exportPdfOne(current)">导出本单PDF</el-button>
        </div>
      </div>
      <template #footer>
        <el-button @click="detailVisible=false"><ArrowLeft style="width:14px;height:14px;margin-right:4px" />返 回</el-button>
      </template>
    </el-dialog>

    <!-- 签字确认 -->
    <el-dialog v-model="signVisible" title="受审核部门认可签字" width="520px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="认可意见" required>
          <el-radio-group v-model="signForm.accepted"><el-radio-button :label="true">同意</el-radio-button><el-radio-button :label="false">不同意</el-radio-button></el-radio-group>
        </el-form-item>
        <el-form-item label="签字人"><el-input v-model="signForm.name" /></el-form-item>
        <el-form-item label="签字图片">
          <input type="file" accept="image/*" @change="onSignUpload" :disabled="uploading" />
          <div v-if="uploading" style="color:var(--c-text-soft);font-size:12px;margin-top:4px">上传中...</div>
          <el-image v-if="signForm.url" :src="signForm.url" style="width:160px;height:80px;object-fit:contain;border:1px solid var(--c-border);border-radius:6px;background:#fff" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="signVisible=false">取消</el-button>
        <el-button type="success" :loading="saving" @click="submitSign">确认签字</el-button>
      </template>
    </el-dialog>

    <!-- 纠正措施 -->
    <el-dialog v-model="corrVisible" title="填写纠正措施" width="620px" :close-on-click-modal="false">
      <el-form label-width="120px">
        <el-form-item label="原因分析" required><el-input v-model="corrForm.causeAnalysis" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="纠正措施" required><el-input v-model="corrForm.correctiveActions" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="完成情况"><el-input v-model="corrForm.completionStatus" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="审核员意见"><el-input v-model="corrForm.auditorOpinion" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="corrVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCorr">保存并进入整改中</el-button>
      </template>
    </el-dialog>

    <!-- 审核闭环 -->
    <el-dialog v-model="reviewVisible" title="审核员意见 / 闭环" width="520px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="审核员意见" required><el-input v-model="reviewForm.opinion" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible=false">取消</el-button>
        <el-button type="danger" :loading="saving" @click="submitReview">确认闭环</el-button>
      </template>
    </el-dialog>

    <!-- 下发落实单 -->
    <el-dialog v-model="createVisible" :title="'下发落实单'" width="640px" :close-on-click-modal="false">
      <el-form :model="form" label-width="130px">
        <el-form-item label="落实单编号"><el-input v-model="form.reportNo" placeholder="自动生成，可修改" /></el-form-item>
        <el-form-item label="受审核部门" required><el-input v-model="form.auditedDept" /></el-form-item>
        <el-form-item label="受审核人" required><el-input v-model="form.auditedPerson" /></el-form-item>
        <el-form-item label="审核员" required><el-input v-model="form.auditor" /></el-form-item>
        <el-form-item label="其他参与人员"><el-input v-model="form.participants" /></el-form-item>
        <el-form-item label="不符合性质" required><el-select v-model="form.nature" style="width:100%"><el-option label="一般不符合" value="一般不符合" /><el-option label="严重不符合" value="严重不符合" /></el-select></el-form-item>
        <el-form-item label="审核依据" required>
          <el-select v-model="form.basis" multiple style="width:100%"><el-option v-for="b in BASIS_OPTS" :key="b" :label="b" :value="b" /></el-select>
        </el-form-item>
        <el-form-item label="其他依据"><el-input v-model="form.basisOther" /></el-form-item>
        <el-form-item label="归纳分类" required><el-select v-model="form.category" style="width:100%"><el-option v-for="c in CATEGORY_OPTS" :key="c" :label="c" :value="c" /></el-select></el-form-item>
        <el-form-item label="请于 N 日内反馈"><el-input-number v-model="form.feedbackDays" :min="1" :max="60" /></el-form-item>
        <el-form-item label="不符合项陈述" required><el-input v-model="form.statement" type="textarea" :rows="4" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">下发</el-button>
      </template>
    </el-dialog>
  </div>`,
  setup() {
    const { ref, reactive, onMounted, watch, computed } = Vue;
    const { ElMessage } = ElementPlus;
    const { Search, Refresh, Plus, View, Printer, Download, ArrowLeft, Edit, Delete, EditPen, CircleCheck } = ElementPlusIconsVue;

    const me = computed(() => store.user || {});
    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const size = ref(10);
    const loading = ref(false);
    const kw = ref('');
    const filterStatus = ref('');
    const filterCategory = ref('');
    const exporting = ref(false);
    const uploading = ref(false);
    const saving = ref(false);

    const detailVisible = ref(false);
    const current = ref(null);
    const signVisible = ref(false);
    const signForm = reactive({ accepted: true, name: '', url: '' });
    const corrVisible = ref(false);
    const corrForm = reactive({ causeAnalysis: '', correctiveActions: '', completionStatus: '', auditorOpinion: '' });
    const reviewVisible = ref(false);
    const reviewForm = reactive({ opinion: '' });
    const createVisible = ref(false);
    const form = reactive({
      reportNo: '', auditedDept: '', auditedPerson: '', auditor: '', participants: '',
      nature: '一般不符合', basis: [], basisOther: '', category: '其他', feedbackDays: 7, statement: ''
    });

    function closeTopDialog() {
      if (detailVisible.value) { detailVisible.value = false; return true; }
      if (signVisible.value) { signVisible.value = false; return true; }
      if (corrVisible.value) { corrVisible.value = false; return true; }
      if (reviewVisible.value) { reviewVisible.value = false; return true; }
      if (createVisible.value) { createVisible.value = false; return true; }
      return false;
    }
    watch([detailVisible, signVisible, corrVisible, reviewVisible, createVisible], (vals) => {
      store.backHandler = vals.some(v => v) ? closeTopDialog : null;
    });

    async function load() {
      loading.value = true;
      try {
        const r = await api.assessments({ status: filterStatus.value, category: filterCategory.value, keyword: kw.value, page: 1, size: 0 });
        let all = (r.list || []).filter(a => canViewAssessment(me.value, a)); // 客户端兜底可见性
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
      api.refreshCache('moduleAssessments');
      search();
    }

    async function openDetail(row) {
      const r = await api.assessments({});
      current.value = (r.list || []).find(x => (x._id || x.id) === (row._id || row.id)) || row;
      detailVisible.value = true;
    }

    function openSign(row) {
      current.value = row;
      signForm.accepted = true;
      signForm.name = myName();
      signForm.url = '';
      signVisible.value = true;
    }
    async function onSignUpload(e) {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      uploading.value = true;
      try {
        const urls = await uploadFiles(files, api, { targetKb: 60, maxFiles: 1 });
        signForm.url = urls[0] || '';
        ElMessage.success('签字图片已上传');
      } catch (err) { ElMessage.error(err.message); }
      finally { uploading.value = false; e.target.value = ''; }
    }
    async function submitSign() {
      saving.value = true;
      try {
        const row = current.value;
        const id = row._id || row.id;
        const update = {
          accepted: signForm.accepted,
          acceptSignatureName: signForm.name,
          acceptSignatureUrl: signForm.url || '',
          acceptSignedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        // 受审核人签字后状态由「待确认」推进到「已确认」（若当前为待确认）
        if ((row.status || '待确认') === '待确认') update.status = '已确认';
        await api.updateAssessment(id, update);
        Object.assign(row, update);
        if (current.value) Object.assign(current.value, update);
        signVisible.value = false;
        ElMessage.success('签字已确认');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    function openCorrective(row) {
      current.value = row;
      corrForm.causeAnalysis = row.causeAnalysis || '';
      corrForm.correctiveActions = row.correctiveActions || '';
      corrForm.completionStatus = row.completionStatus || '';
      corrForm.auditorOpinion = row.auditorOpinion || '';
      corrVisible.value = true;
    }
    async function submitCorr() {
      if (!corrForm.causeAnalysis || !corrForm.correctiveActions) { ElMessage.warning('请填写原因分析与纠正措施'); return; }
      saving.value = true;
      try {
        const row = current.value;
        const id = row._id || row.id;
        const update = {
          causeAnalysis: corrForm.causeAnalysis,
          correctiveActions: corrForm.correctiveActions,
          completionStatus: corrForm.completionStatus,
          auditorOpinion: corrForm.auditorOpinion,
          correctiveFilledBy: myName(),
          correctiveFilledAt: new Date().toISOString(),
          status: '整改中',
          updatedAt: new Date().toISOString()
        };
        await api.updateAssessment(id, update);
        Object.assign(row, update);
        if (current.value) Object.assign(current.value, update);
        corrVisible.value = false;
        ElMessage.success('纠正措施已保存，进入整改中');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    function openReview(row) {
      current.value = row;
      reviewForm.opinion = row.auditorOpinion || '';
      reviewVisible.value = true;
    }
    async function submitReview() {
      if (!reviewForm.opinion) { ElMessage.warning('请填写审核员意见'); return; }
      saving.value = true;
      try {
        const row = current.value;
        const id = row._id || row.id;
        const update = {
          auditorOpinion: reviewForm.opinion,
          status: '已闭环',
          updatedAt: new Date().toISOString()
        };
        await api.updateAssessment(id, update);
        Object.assign(row, update);
        if (current.value) Object.assign(current.value, update);
        reviewVisible.value = false;
        ElMessage.success('已审核并闭环');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    function openCreate() {
      const u = store.user || {};
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const datePart = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
      form.reportNo = 'MK-' + datePart + '-' + String(Math.floor(Math.random() * 900) + 100);
      form.auditedDept = ''; form.auditedPerson = ''; form.auditor = u.name || u.username || '';
      form.participants = ''; form.nature = '一般不符合'; form.basis = []; form.basisOther = '';
      form.category = '其他'; form.feedbackDays = 7; form.statement = '';
      createVisible.value = true;
    }
    async function save() {
      if (!form.auditedDept || !form.auditedPerson || !form.auditor || !form.statement) { ElMessage.warning('请填写受审核部门、受审核人、审核员和不符合项陈述'); return; }
      if (!form.basis.length) { ElMessage.warning('请至少选择一项审核依据'); return; }
      saving.value = true;
      try {
        const u = store.user || {};
        const now = new Date().toISOString();
        const fd = new Date(now); fd.setDate(fd.getDate() + (form.feedbackDays || 7));
        await api.createAssessment({
          reportNo: form.reportNo,
          auditedDept: form.auditedDept,
          auditedPerson: form.auditedPerson,
          auditor: form.auditor,
          participants: form.participants,
          basis: form.basis,
          basisOther: form.basisOther,
          nature: form.nature,
          statement: form.statement,
          feedbackDays: form.feedbackDays,
          feedbackDeadline: fd.toISOString(),
          category: form.category,
          status: '待确认',
          accepted: null,
          acceptSignatureName: '',
          acceptSignatureUrl: '',
          causeAnalysis: '', correctiveActions: '', completionStatus: '', auditorOpinion: '',
          correctiveFilledBy: '', createdById: u._id || '', createdByName: u.name || u.username || '',
          deptCode: deptOf(currentDept() || 'ENV') || 'JN',
          createdAt: now, updatedAt: now
        });
        ElMessage.success('落实单已下发');
        createVisible.value = false;
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('删除后将移除（软删除，可在云端恢复）。确定删除吗？', '删除落实单', { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' });
      } catch (e) { return; }
      saving.value = true;
      try {
        await api.updateAssessment(row._id || row.id, { isDeleted: true, deletedAt: new Date().toISOString() });
        ElMessage.success('落实单已删除');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    // ---------- 导出 PDF（纸质模板） ----------
    function buildAssessmentPdf(a) {
      const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const row = (k, v) => `<tr><td class="k">${esc(k)}</td><td colspan="3">${esc(v)}</td></tr>`;
      const acceptedText = a.accepted == null ? '待签' : (a.accepted ? '同意' : '不同意');
      const sigImg = a.acceptSignatureUrl ? `<img src="${esc(a.acceptSignatureUrl)}" style="height:48px" />` : (a.acceptSignatureName || '');
      return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><style>
        *{box-sizing:border-box} body{font-family:"Microsoft YaHei","SimSun",sans-serif;color:#1f2d28;margin:18px;font-size:13px}
        h1{font-size:18px;text-align:center;border-bottom:3px solid #1f8a4c;padding-bottom:8px}
        .sub{text-align:center;color:#666;margin:6px 0 14px}
        table{border-collapse:collapse;width:100%;margin-bottom:16px} td,th{border:1px solid #333;padding:6px 8px;vertical-align:top}
        td.k{background:#eef6f0;font-weight:bold;width:140px} .title2{font-size:15px;font-weight:bold;margin:10px 0 6px;border-left:4px solid #1f8a4c;padding-left:8px}
      </style></head><body>
        <h1>管理模块检查不符合项报告单</h1>
        <div class="sub">编号：${esc(a.reportNo)}　｜　归纳分类：${esc(a.category)}</div>
        <table>
          ${row('受审核部门', a.auditedDept)} ${row('受审核人', a.auditedPerson)}
          ${row('审核员', a.auditor)} ${row('其他参与人员', a.participants)}
          ${row('不符合性质', a.nature)} ${row('请于 N 日内反馈', (a.feedbackDays || 7) + ' 天')}
          ${row('审核依据', (a.basis || []).join('、') + (a.basisOther ? '（其他：' + a.basisOther + '）' : ''))}
          <tr><td class="k">不符合项陈述</td><td colspan="3">${esc(a.statement)}</td></tr>
          <tr><td class="k">受审核部门认可意见</td><td>${esc(acceptedText)}</td><td class="k">签字</td><td>${sigImg}</td></tr>
        </table>
        <div class="title2">管理模块纠正措施表</div>
        <table>
          <tr><td class="k">不符合项原因分析</td><td colspan="3">${esc(a.causeAnalysis)}</td></tr>
          <tr><td class="k">纠正措施</td><td colspan="3">${esc(a.correctiveActions)}</td></tr>
          <tr><td class="k">纠正措施完成情况</td><td colspan="3">${esc(a.completionStatus)}</td></tr>
          <tr><td class="k">审核员意见</td><td colspan="3">${esc(a.auditorOpinion)}</td></tr>
          <tr><td class="k">填写人/时间</td><td colspan="3">${esc(a.correctiveFilledBy || '') + ' ' + esc((a.correctiveFilledAt || '').slice(0,10))}</td></tr>
        </table>
      </body></html>`;
    }
    async function exportPdfOne(a) {
      if (!window.electronAPI) { ElMessage.error('本地导出能力不可用'); return; }
      exporting.value = true;
      try {
        const html = buildAssessmentPdf(a);
        const defaultName = '落实单_' + (a.reportNo || 'MK') + '.pdf';
        const res = await window.electronAPI.exportPdf({ defaultName, html });
        await showExportResult(res, { defaultName, html, summary: '模块考核落实单 PDF 已生成（报告单 + 纠正措施表）。' });
      } catch (e) { ElMessage.error(e.message); }
      finally { exporting.value = false; }
    }
    async function exportPdf() {
      if (!window.electronAPI) { ElMessage.error('本地导出能力不可用'); return; }
      exporting.value = true;
      try {
        const r = await api.assessments({ status: filterStatus.value, category: filterCategory.value, keyword: kw.value, page: 1, size: 0 });
        const all = (r.list || []).filter(a => canViewAssessment(me.value, a));
        if (!all.length) { ElMessage.warning('当前筛选无数据可导出'); return; }
        const html = all.map(buildAssessmentPdf).join('<div style="page-break-before:always"></div>');
        const defaultName = '模块考核落实单_' + ts() + '.pdf';
        const res = await window.electronAPI.exportPdf({ defaultName, html });
        await showExportResult(res, { defaultName, html, summary: '已导出 ' + all.length + ' 张落实单 PDF（每张含报告单 + 纠正措施表）。' });
      } catch (e) { ElMessage.error(e.message); }
      finally { exporting.value = false; }
    }
    async function exportExcel() {
      if (!window.XLSX) { ElMessage.error('Excel 组件未加载，请重启客户端'); return; }
      if (!window.electronAPI) { ElMessage.error('本地导出能力不可用'); return; }
      exporting.value = true;
      try {
        const r = await api.assessments({ status: filterStatus.value, category: filterCategory.value, keyword: kw.value, page: 1, size: 0 });
        const all = (r.list || []).filter(a => canViewAssessment(me.value, a));
        if (!all.length) { ElMessage.warning('当前筛选无数据可导出'); return; }
        const headers = ['编号', '受审核部门', '受审核人', '审核员', '归纳分类', '性质', '状态', '认可意见', '创建时间'];
        const rows = all.map(x => [x.reportNo || x._id, x.auditedDept, x.auditedPerson, x.auditor, x.category, x.nature || '一般不符合', x.status || '待确认', (x.accepted == null ? '待签' : (x.accepted ? '同意' : '不同意')), (x.createdAt || '').slice(0, 10)]);
        const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, '模块考核落实单');
        const b64 = window.XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const res = await window.electronAPI.saveXlsxEnhanced({ defaultName: '模块考核落实单_' + ts() + '.xlsx', buffer: b64, plan: {} });
        await showExportResult(res, { onSaveAs: () => exportExcel(), summary: '模块考核落实单 Excel 台账已生成。' });
      } catch (e) { ElMessage.error(e.message || '导出失败'); }
      finally { exporting.value = false; }
    }
    function ts() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    onMounted(load);

    return {
      BASIS_OPTS, CATEGORY_OPTS, STATUS_OPTS, list, total, page, size, loading, kw, filterStatus, filterCategory,
      exporting, uploading, saving, me,
      canCreateAssessment, canSignAssessment, canFillCorrective, canReviewAssessment, isAdmin, isSafetyEnvStaff,
      detailVisible, current, signVisible, signForm, corrVisible, corrForm, reviewVisible, reviewForm, createVisible, form,
      search, reset, onPage, onSize, openDetail, openSign, onSignUpload, submitSign, openCorrective, submitCorr, openReview, submitReview,
      openCreate, save, remove, exportPdf, exportPdfOne, exportExcel,
      statusClass, fmtDate,
      Search, Refresh, Plus, View, Printer, Download, ArrowLeft, Edit, Delete, EditPen, CircleCheck, STATUS_MAP, SEVERITY_MAP
    };
  }
};
