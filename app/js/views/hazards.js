import { api, STATUS_MAP, SEVERITY_MAP, ROLE_MAP } from '../api.js';
import { store } from '../store.js';
import { buildExcelWorkbook, buildPdfHtml, collectExportPhotoUrls, fetchPhotoThumbnails } from '../export_utils.js';
import { resolveIssuePhotos, resolveIssuesPhotos } from '../image_utils.js';
import { uploadFiles } from '../image_upload.js';
import { isAdmin, isViewer, isReporter, filterIssuesByRole, canCreate, canUrgeIssue, canStartRectify, canSubmitRectify, canReviewIssue } from '../permission.js';
import { currentDept, categoryOptions, inDeptScope } from '../dept.js';
import { businessOptions, deptOf, businessLabelOf, businessesForDept, visibleBizCodes } from '../business.js';
import { businessOf } from '../stats_utils.js';

const STATUS_OPTS = [
  { value: 'pending', label: STATUS_MAP.pending },
  { value: 'processing', label: STATUS_MAP.processing },
  { value: 'reviewing', label: STATUS_MAP.reviewing },
  { value: 'closed', label: STATUS_MAP.closed }
];
// 类别按当前科室切换。库里存的仍是中文（历史数据零迁移），
// 两个科室都各有「其他」，因此类别本身不足以判定归属，归属以 deptCode 为准（dept.js hazardDeptOf）。
const SEVERITY_OPTS = [
  { value: 'general', label: SEVERITY_MAP.general },
  { value: 'serious', label: SEVERITY_MAP.serious },
  { value: 'critical', label: SEVERITY_MAP.critical }
];

function statusClass(st) {
  if (st === 'pending') return 'tag-pending';
  if (st === 'processing') return 'tag-processing';
  if (st === 'reviewing') return 'tag-reviewing';
  if (st === 'closed') return 'tag-closed';
  return '';
}
function severityClass(sev) {
  if (sev === 'critical') return 'tag-overdue';
  if (sev === 'serious') return 'tag-pending';
  return 'tag-closed';
}
function fmtDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }

export default {
  template: `
  <div>
    <h2 class="page-title neon-title">隐患管理</h2>
    <p class="page-sub">安全 / 节能 / 环保隐患的上报、整改流转与催办 · 与移动端数据同源</p>

    <div class="toolbar">
      <el-input v-model="kw" placeholder="标题/描述/位置/部门/责任人" clearable style="width:240px" @keyup.enter="search" />
      <el-select v-model="filterStatus" placeholder="状态" clearable style="width:130px">
        <el-option v-for="o in STATUS_OPTS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-if="bizFilterOpts.length > 1" v-model="filterBusiness" placeholder="业务" clearable style="width:130px">
        <el-option v-for="o in bizFilterOpts" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select v-model="filterDept" placeholder="部门" clearable style="width:150px">
        <el-option v-for="d in depts" :key="d.name" :label="d.name" :value="d.name" />
      </el-select>
      <el-select v-model="filterSeverity" placeholder="等级" clearable style="width:120px">
        <el-option v-for="o in SEVERITY_OPTS" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="search">查询</el-button>
      <el-button :icon="Refresh" @click="reset">重置</el-button>
      <el-tag v-if="overdueOnly" type="danger" effect="dark" closable @close="overdueOnly=false;search()" style="margin-left:10px">仅显示已逾期</el-tag>
      <span class="spacer"></span>
      <el-button v-if="canCreate(me)" type="success" :icon="Plus" @click="openCreate">新增隐患</el-button>
      <el-button type="warning" :icon="Download" :loading="exporting" @click="exportExcel">导出Excel</el-button>
      <el-button type="danger" :icon="Printer" :loading="exporting" @click="exportPdf">导出PDF</el-button>
    </div>

    <div class="card" style="min-width:0">
      <div class="table-wrap">
      <el-table :data="list" v-loading="loading" size="default" stripe>
        <el-table-column label="编号" width="150">
          <template #default="{row}">{{ row.id || row._id }}</template>
        </el-table-column>
        <el-table-column label="标题" min-width="170" show-overflow-tooltip>
          <template #default="{row}">{{ row.title || row.description?.slice(0,24) || '—' }}</template>
        </el-table-column>
        <el-table-column prop="category" label="类别" width="100" />
        <el-table-column label="业务" width="90">
          <template #default="{row}">{{ row.businessType ? businessLabelOf(row.businessType) : '环保' }}</template>
        </el-table-column>
        <el-table-column prop="department" label="部门" width="120" />
        <el-table-column prop="assigneeName" label="责任人" width="100" />
        <el-table-column label="等级" width="80">
          <template #default="{row}"><span :class="severityClass(row.severity)">{{ SEVERITY_MAP[row.severity] || '一般' }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{row}"><span :class="statusClass(row.status)">{{ STATUS_MAP[row.status] || row.status }}</span></template>
        </el-table-column>
        <el-table-column label="期限" width="105">
          <template #default="{row}">{{ (row.dueDate||row.deadline||'').slice(0,10) || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="360" fixed="right">
          <template #default="{row}">
            <el-button text type="primary" :icon="View" @click="openDetail(row)">详情</el-button>
            <el-button v-if="canModify(me, row)" text type="info" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="canModify(me, row)" text type="warning" :icon="Switch" @click="openReassign(row)">重新指派</el-button>
            <el-button v-if="canRecall(me, row)" text type="danger" :icon="Delete" @click="recall(row)">撤回</el-button>
            <el-button v-if="canStartRectify(me, row)" text type="success" @click="startRectify(row)">开始整改</el-button>
            <el-button v-if="canSubmitRectify(me, row)" text type="primary" @click="openFeedback(row)">提交反馈</el-button>
            <el-button v-if="canUrgeIssue(me, row)" text type="warning" :icon="Bell" @click="openRemind(row)">催办</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end;align-items:center;gap:12px">
        <el-pagination background layout="total, sizes, prev, pager, next, jumper" :total="total" :page-size="size" :page-sizes="[10,20,50,100]" :current-page="page" @current-change="onPage" @size-change="onSize" />
      </div>
    </div>

    <!-- 详情 -->
    <el-dialog v-model="detailVisible" width="760px" top="6vh" :close-on-click-modal="false">
      <template #header>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="back-inline" @click="detailVisible=false" title="返回"><ArrowLeft style="width:16px;height:16px" /></span>
          <span style="font-weight:600">隐患详情</span>
        </div>
      </template>
      <template v-if="current">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="编号" :span="2">{{ current.id || current._id }}</el-descriptions-item>
          <el-descriptions-item label="标题" :span="2">{{ current.title || '—' }}</el-descriptions-item>
          <el-descriptions-item label="业务">{{ current.businessType ? businessLabelOf(current.businessType) : '环保' }}</el-descriptions-item>
          <el-descriptions-item label="类别">{{ current.category }}</el-descriptions-item>
          <el-descriptions-item label="等级"><span :class="severityClass(current.severity)">{{ SEVERITY_MAP[current.severity] || '一般' }}</span></el-descriptions-item>
          <el-descriptions-item label="部门">{{ current.department }}</el-descriptions-item>
          <el-descriptions-item label="责任人">{{ current.assigneeName }}</el-descriptions-item>
          <el-descriptions-item label="上报人">{{ current.reporterName || '—' }}</el-descriptions-item>
          <el-descriptions-item label="位置">{{ current.location || '—' }}</el-descriptions-item>
          <el-descriptions-item label="状态"><span :class="statusClass(current.status)">{{ STATUS_MAP[current.status] || current.status }}</span></el-descriptions-item>
          <el-descriptions-item label="整改期限">{{ (current.dueDate||current.deadline||'').slice(0,10) || '—' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ fmtDate(current.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ fmtDate(current.updatedAt) }}</el-descriptions-item>
          <el-descriptions-item label="描述" :span="2">{{ current.description }}</el-descriptions-item>
          <el-descriptions-item v-if="current.acceptanceNote" label="验收意见" :span="2">{{ current.acceptanceNote }}</el-descriptions-item>
          <el-descriptions-item v-if="current.rejectionNote" label="驳回意见" :span="2">{{ current.rejectionNote }}</el-descriptions-item>
          <el-descriptions-item v-if="current.rectificationNote" label="整改反馈" :span="2">{{ current.rectificationNote }}</el-descriptions-item>
        </el-descriptions>

        <h3 style="margin:16px 0 8px;color:#fff">现场照片</h3>
        <div v-if="current.photos && current.photos.length" style="display:flex;gap:8px;flex-wrap:wrap">
          <el-image v-for="(img,i) in current.photos" :key="i" :src="img" :preview-src-list="current.photos" style="width:90px;height:90px;border-radius:8px;border:1px solid var(--c-border)" fit="cover" />
        </div>
        <span v-else style="color:var(--c-text-soft);font-size:13px">暂无图片</span>

        <h3 style="margin:16px 0 8px;color:#fff">整改后照片</h3>
        <div v-if="current.rectificationPhotos && current.rectificationPhotos.length" style="display:flex;gap:8px;flex-wrap:wrap">
          <el-image v-for="(img,i) in current.rectificationPhotos" :key="i" :src="img" :preview-src-list="current.rectificationPhotos" style="width:90px;height:90px;border-radius:8px;border:1px solid var(--c-border)" fit="cover" />
        </div>
        <span v-else style="color:var(--c-text-soft);font-size:13px">暂无整改图片</span>

        <template v-if="current.rectificationHistory && current.rectificationHistory.length">
          <h3 style="margin:16px 0 8px;color:#fff">整改记录</h3>
          <el-timeline>
            <el-timeline-item v-for="(t,i) in current.rectificationHistory" :key="i" :timestamp="fmtDate(t.timestamp)">
              <b>{{ t.submitterName || '整改人' }}</b>
              <div style="color:var(--c-text-soft);font-size:13px">{{ t.description }}</div>
              <div v-if="t.photos && t.photos.length" style="display:flex;gap:6px;margin-top:6px">
                <el-image v-for="(p,j) in t.photos" :key="j" :src="p" :preview-src-list="t.photos" style="width:60px;height:60px;border-radius:6px;border:1px solid var(--c-border)" fit="cover" />
              </div>
            </el-timeline-item>
          </el-timeline>
        </template>

        <template v-if="current.rejectionHistory && current.rejectionHistory.length">
          <h3 style="margin:16px 0 8px;color:#fff">驳回记录</h3>
          <el-timeline>
            <el-timeline-item v-for="(t,i) in current.rejectionHistory" :key="i" :timestamp="fmtDate(t.timestamp)" type="danger">
              <b>{{ t.reviewerName || '验收人' }}</b>
              <div style="color:var(--c-text-soft);font-size:13px">{{ t.note }}</div>
            </el-timeline-item>
          </el-timeline>
        </template>

        <el-divider v-if="canStartRectify(me, current) || canSubmitRectify(me, current) || (canReviewIssue(me, current) && current.status === 'reviewing')" />
        <!-- 整改人：开始整改 -->
        <div v-if="canStartRectify(me, current)" style="margin-bottom:12px">
          <el-button type="success" :loading="saving" @click="startRectify(current)">开始整改</el-button>
          <span style="color:var(--c-text-soft);font-size:12px;margin-left:10px">确认后将状态变更为「整改中」</span>
        </div>
        <!-- 整改人：提交整改反馈 -->
        <el-form v-if="canSubmitRectify(me, current)" label-width="90px">
          <el-form-item label="整改说明">
            <el-input v-model="rectifyNote" type="textarea" :rows="2" placeholder="填写整改情况" />
          </el-form-item>
          <el-form-item label="整改照片">
            <input type="file" accept="image/*" multiple @change="onDetailFeedbackUpload" :disabled="uploading" />
            <div v-if="uploading" style="color:var(--c-text-soft);font-size:12px;margin-top:4px">上传中...</div>
            <div v-if="feedbackPhotos.length" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
              <div v-for="(p,i) in feedbackPhotos" :key="i" style="position:relative">
                <el-image :src="p" style="width:70px;height:70px;border-radius:6px;border:1px solid var(--c-border)" fit="cover" />
                <el-button circle size="small" style="position:absolute;top:-6px;right:-6px" @click="removeFeedbackPhoto(i)">×</el-button>
              </div>
            </div>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" @click="submitRectify">提交反馈</el-button>
            <span style="color:var(--c-text-soft);font-size:12px;margin-left:10px">提交后状态变为「待验收」</span>
          </el-form-item>
        </el-form>
        <!-- 发起人/管理员：验收/驳回 -->
        <div v-if="canReviewIssue(me, current) && current.status === 'reviewing'" style="display:flex;flex-wrap:wrap;gap:10px">
          <el-input v-model="rectifyNote" type="textarea" :rows="2" placeholder="验收意见 / 驳回原因" style="flex:1 1 100%" />
          <el-button type="success" :loading="saving" @click="reviewIssue(true)">验收通过</el-button>
          <el-button type="danger" :loading="saving" @click="reviewIssue(false)">驳回</el-button>
        </div>
      </template>
      <template #footer>
        <el-button @click="detailVisible=false"><ArrowLeft style="width:14px;height:14px;margin-right:4px" />返 回</el-button>
      </template>
    </el-dialog>

    <!-- 催办 -->
    <el-dialog v-model="remindVisible" title="发送催办" width="480px">
      <el-input v-model="remindContent" type="textarea" :rows="4" placeholder="催办内容（默认自动生成）" />
      <template #footer>
        <el-button @click="remindVisible=false">取消</el-button>
        <el-button type="warning" :loading="saving" @click="sendRemind">发送</el-button>
      </template>
    </el-dialog>

    <!-- 提交整改反馈（列表快捷入口） -->
    <el-dialog v-model="feedbackVisible" title="提交整改反馈" width="520px" :close-on-click-modal="false">
      <el-form label-width="90px">
        <el-form-item label="整改说明">
          <el-input v-model="rectifyNote" type="textarea" :rows="3" placeholder="填写整改情况" />
        </el-form-item>
        <el-form-item label="整改照片">
          <input type="file" accept="image/*" multiple @change="onFeedbackUpload" :disabled="uploading" />
          <div v-if="uploading" style="color:var(--c-text-soft);font-size:12px;margin-top:4px">上传中...</div>
          <div v-if="feedbackPhotos.length" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <div v-for="(p,i) in feedbackPhotos" :key="i" style="position:relative">
              <el-image :src="p" style="width:70px;height:70px;border-radius:6px;border:1px solid var(--c-border)" fit="cover" />
              <el-button circle size="small" style="position:absolute;top:-6px;right:-6px" @click="removeFeedbackPhoto(i)">×</el-button>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="feedbackVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitRectify">提交反馈</el-button>
      </template>
    </el-dialog>

    <!-- 重新指派 -->
    <el-dialog v-model="reassignVisible" title="重新指派整改人" width="480px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="当前责任人"><span>{{ reassignTarget.assigneeName || '—' }}</span></el-form-item>
        <el-form-item label="新整改人" required>
          <el-select v-model="reassignId" style="width:100%" @change="onReassignChange" filterable>
            <el-option v-for="u in rectifiers" :key="u._id" :label="u.name + ' ('+ (u.department||'未分配') +')'" :value="u._id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reassignVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="reassign">确认指派</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑 -->
    <el-dialog v-model="createVisible" :title="editId ? '编辑隐患' : '新增隐患'" width="620px" :close-on-click-modal="false">
      <el-form :model="form" label-width="100px">
        <el-form-item label="标题" required><el-input v-model="form.title" placeholder="简短标题" /></el-form-item>
        <el-form-item label="业务" required>
          <!-- 业务选项按「当前账号可见业务集合」收敛（visibleBizCodes）：
               只有安全权限的账号，下拉里就只有「安全业务」，无法误选节能/环保。
               v1.0.29 曾误用全量 BUSINESS_OPTS 导致单业务账号能越权选择，v1.0.30 修正。 -->
          <el-select v-model="form.businessType" style="width:100%" @change="onBusinessChange">
            <el-option v-for="o in bizCreateOpts" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="类别" required>
          <el-select v-model="form.category" style="width:100%"><el-option v-for="o in CATEGORY_OPTS" :key="o" :label="o" :value="o" /></el-select>
        </el-form-item>
        <el-form-item label="等级" required>
          <el-select v-model="form.severity" style="width:100%"><el-option v-for="o in SEVERITY_OPTS" :key="o.value" :label="o.label" :value="o.value" /></el-select>
        </el-form-item>
        <el-form-item label="部门" required><el-select v-model="form.department" style="width:100%"><el-option v-for="d in depts" :key="d.name" :label="d.name" :value="d.name" /></el-select></el-form-item>
        <el-form-item label="位置"><el-input v-model="form.location" /></el-form-item>
        <el-form-item label="整改责任人" required>
          <el-select v-model="form.assigneeId" style="width:100%" @change="onAssigneeChange" filterable>
            <el-option v-for="u in rectifiers" :key="u._id" :label="u.name + ' ('+ (u.department||'未分配') +')'" :value="u._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="整改期限"><el-date-picker v-model="form.dueDate" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="描述" required><el-input v-model="form.description" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="现场照片">
          <input type="file" accept="image/*" multiple @change="onCreateUpload" :disabled="uploading" />
          <div v-if="uploading" style="color:var(--c-text-soft);font-size:12px;margin-top:4px">上传中...</div>
          <div v-if="form.photos.length" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <div v-for="(p,i) in form.photos" :key="i" style="position:relative">
              <el-image :src="p" style="width:60px;height:60px;border-radius:6px;border:1px solid var(--c-border)" fit="cover" />
              <el-button circle size="small" style="position:absolute;top:-6px;right:-6px" @click="form.photos.splice(i,1)">×</el-button>
            </div>
          </div>
          <div style="color:var(--c-text-soft);font-size:12px;margin-top:4px">最多 9 张，JPG/PNG 均可，自动压缩</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">保存</el-button>
      </template>
    </el-dialog>
  </div>`,
  setup() {
    const { ref, reactive, onMounted, watch, computed } = Vue;
    const { ElMessage } = ElementPlus;
    const { Search, Refresh, Plus, View, Bell, Download, Printer, ArrowLeft, Edit, Switch, Delete } = ElementPlusIconsVue;

    // 当前登录用户（权限判断用）
    const me = computed(() => store.user || {});

    // 可编辑/撤回：发起人( reporter )或管理员，且处于待处理/整改中（对齐 APK 撤回与编辑口径）
    function canModify(user, issue) {
      if (!issue) return false;
      if (isViewer(user)) return false;
      const ok = isAdmin(user) || isReporter(user, issue);
      return ok && (issue.status === 'pending' || issue.status === 'processing');
    }
    // 撤回（软删除）：与 canModify 同口径，发起人/管理员在流程早期可撤回
    function canRecall(user, issue) {
      if (!issue) return false;
      if (isViewer(user)) return false;
      const ok = isAdmin(user) || isReporter(user, issue);
      return ok && (issue.status === 'pending' || issue.status === 'processing');
    }

    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const size = ref(10);
    const loading = ref(false);
    const kw = ref('');
    const filterStatus = ref('');
    const filterBusiness = ref('');
    const filterDept = ref('');
    const filterSeverity = ref('');
    const depts = ref([]);
    const users = ref([]);
    const rectifiers = ref([]);

    const detailVisible = ref(false);
    const current = ref(null);
    const newStatus = ref('');
    const rectifyNote = ref('');
    const remindVisible = ref(false);
    const remindContent = ref('');
    const remindTarget = ref(null);
    const feedbackVisible = ref(false);
    const feedbackTarget = ref(null);
    const feedbackPhotos = ref([]);
    const createVisible = ref(false);
    const editId = ref(null);
    const reassignVisible = ref(false);
    const reassignTarget = ref(null);
    const reassignId = ref('');
    const saving = ref(false);
    const uploading = ref(false);
    const exporting = ref(false);
    const overdueOnly = ref(false);
    const form = reactive({ title: '', businessType: 'SAFE', category: '其他', severity: 'general', department: '', location: '', assigneeId: '', assigneeName: '', dueDate: '', description: '', photos: [] });

    // 当前账号仅归属单个业务时，上报自动采用该业务、隐藏业务选择框
    const singleBusiness = computed(() => {
      const bs = (store.user && Array.isArray(store.user.businessTypes)) ? store.user.businessTypes : [];
      return bs.length === 1 ? bs[0] : '';
    });

    // 工具栏“业务”筛选下拉：v1.0.28 起按「用户可见业务集合」取值（与列表数据
    // 的隔离口径 visibleBizCodes 完全一致），不再按科室徽章收敛 —— 否则会出现
    // 「徽章在 JN 时能选安全业务却查不到数据」的错位。
    // 单业务时长度=1，模板中 v-if 隐藏该选择框。
    const bizFilterOpts = computed(() => {
      return visibleBizCodes(store.user).map(code => ({ value: code, label: businessLabelOf(code) }));
    });

    // 新增隐患弹窗的“业务”下拉：与工具栏筛选同一口径（visibleBizCodes），
    // 保证「能看到的业务」与「能填报的业务」一致 —— 只有安全权限的账号只能填安全业务。
    const bizCreateOpts = computed(() => {
      const opts = visibleBizCodes(store.user).map(code => ({ value: code, label: businessLabelOf(code) }));
      return opts.length ? opts : businessOptions();
    });

    // 单业务账号自动采用；多业务默认取当前科室下第一个可见业务（与仪表盘一致）
    filterBusiness.value = singleBusiness.value || (bizFilterOpts.value[0] ? bizFilterOpts.value[0].value : '');
    // 管理员在后台调整业务权限后即时生效：store.user 变化（refreshMe 写回）时，
    // 重新收敛 filterBusiness，避免出现下拉里没有、筛选却命中的脏状态
    watch(() => store.user, () => {
      const opts = bizFilterOpts.value.map(o => o.value);
      if (singleBusiness.value) filterBusiness.value = singleBusiness.value;
      else if (!opts.includes(filterBusiness.value)) filterBusiness.value = opts[0] || '';
    });

    // 返回按钮处理：有弹窗打开时优先关闭弹窗
    function closeTopDialog() {
      if (detailVisible.value) { detailVisible.value = false; return true; }
      if (feedbackVisible.value) { feedbackVisible.value = false; return true; }
      if (createVisible.value) { createVisible.value = false; return true; }
      if (remindVisible.value) { remindVisible.value = false; return true; }
      if (reassignVisible.value) { reassignVisible.value = false; return true; }
      return false;
    }
    watch([detailVisible, feedbackVisible, createVisible, remindVisible, reassignVisible], (vals) => {
      store.backHandler = vals.some(v => v) ? closeTopDialog : null;
    });

    function isOverdue(h) {
      return h.status !== 'closed' && h.dueDate && new Date(h.dueDate).getTime() < Date.now();
    }
    async function load() {
      loading.value = true;
      try {
        const user = store.user;
        // 数据隔离（v1.0.28 起按业务隔离）：inDeptScope = 隐患业务 ∈ 用户可见业务集合
        // （business.js visibleBizCodes：admin 全部 / 显式赋权 / deptCodes 派生 / 存量全部）。
        // 科室徽章不再参与数据过滤，只影响仪表盘分组与默认 tab ——
        // 此前徽章参与过滤导致 v1.0.24~v1.0.27 连续「数据查不到」回归。
        const inDept = (h) => inDeptScope(h, user);
        // 非管理员只能看到“自己发起 + 分配给自己的”问题（对齐 APK），必须拉全量本地过滤。
        // 统一走「全量拉取 + 本地过滤 + 本地分页」：科室隔离、角色、业务、等级、状态、
        // 逾期都是客户端维度，若叠加在服务端分页结果上，稀疏数据（如全库仅 1 条安全
        // 业务、排在第 1 页之外）会被滤成恒为空（v1.0.25 回归：安全业务查不到）。
        // 当前数据量（数百条）下全量拉取开销可接受。
        const r = await api.hazards({ status: '', department: filterDept.value, category: '', keyword: kw.value, page: 1, size: 0 });
        let all = filterIssuesByRole(user, r.list || []).filter(inDept);
        if (overdueOnly.value) all = all.filter(isOverdue);
        if (filterStatus.value) all = all.filter(h => h.status === filterStatus.value);
        if (filterBusiness.value) all = all.filter(h => businessOf(h) === filterBusiness.value);
        if (filterSeverity.value) all = all.filter(h => h.severity === filterSeverity.value);
        const start = (page.value - 1) * size.value;
        list.value = all.slice(start, start + size.value);
        total.value = all.length;
      } finally { loading.value = false; }
    }
    function search() { page.value = 1; load(); }
    function onSize(v) { size.value = v; page.value = 1; load(); }
    // 「重置」是用户主动触发的动作，先失效缓存再取数，
    // 否则在 TTL 内点击会直接命中缓存、看起来像没生效。
    function reset() {
      kw.value = ''; filterStatus.value = ''; filterBusiness.value = ''; filterDept.value = ''; filterSeverity.value = ''; overdueOnly.value = false;
      api.refreshCache('hazards');
      search();
    }
    function onPage(p) { page.value = p; load(); }

    async function openDetail(row) {
      const h = await api.getHazard(row._id);
      const issue = h || row;
      // 把 cloud:// fileID 刷新为可浏览的临时 HTTPS URL
      await resolveIssuePhotos(issue);
      current.value = issue;
      newStatus.value = current.value.status;
      rectifyNote.value = '';
      feedbackPhotos.value = [];
      detailVisible.value = true;
    }
    async function startRectify(row) {
      try {
        saving.value = true;
        await api.updateHazard(row._id, { status: 'processing', updatedAt: new Date().toISOString() });
        ElMessage.success('已开始整改');
        load();
        if (detailVisible.value && current.value && current.value._id === row._id) {
          current.value.status = 'processing';
        }
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    async function submitRectify() {
      try {
        saving.value = true;
        const me = store.user || {};
        const issue = current.value || feedbackTarget.value;
        if (!issue) return;
        if (!rectifyNote.value.trim() && !feedbackPhotos.value.length) {
          ElMessage.warning('请填写整改说明或上传整改照片');
          return;
        }
        const update = {
          status: 'reviewing',
          rectificationNote: rectifyNote.value.trim() || '已提交整改反馈',
          updatedAt: new Date().toISOString()
        };
        if (feedbackPhotos.value.length) {
          update.rectificationPhotos = [...(issue.rectificationPhotos || []), ...feedbackPhotos.value];
        }
        const record = {
          timestamp: new Date().toISOString(),
          description: rectifyNote.value.trim() || '已提交整改反馈',
          submitterId: me._id || '',
          submitterName: me.name || me.username || '整改人',
          photos: feedbackPhotos.value || []
        };
        update.rectificationHistory = [...(issue.rectificationHistory || []), record];
        await api.updateHazard(issue._id, update);
        ElMessage.success('整改反馈已提交');
        rectifyNote.value = '';
        feedbackPhotos.value = [];
        feedbackVisible.value = false;
        if (current.value && current.value._id === issue._id) {
          Object.assign(current.value, update);
        }
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    async function reviewIssue(pass) {
      try {
        saving.value = true;
        const me = store.user || {};
        const update = { updatedAt: new Date().toISOString() };
        if (pass) {
          update.status = 'closed';
          update.acceptanceNote = rectifyNote.value.trim() || '验收通过';
          update.closedAt = new Date().toISOString();
        } else {
          update.status = 'pending';
          update.rejectionNote = rectifyNote.value.trim() || '驳回整改';
        }
        const record = {
          timestamp: new Date().toISOString(),
          reviewerId: me._id || '',
          reviewerName: me.name || me.username || '验收人',
          note: pass ? (rectifyNote.value.trim() || '验收通过') : (rectifyNote.value.trim() || '驳回整改'),
          pass
        };
        update.rejectionHistory = [...(current.value.rejectionHistory || []), record];
        await api.updateHazard(current.value._id, update);
        Object.assign(current.value, update);
        ElMessage.success(pass ? '已验收通过' : '已驳回');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    async function onFeedbackUpload(e) {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      uploading.value = true;
      try {
        const urls = await uploadFiles(files, api);
        feedbackPhotos.value.push(...urls);
        ElMessage.success(`已上传 ${urls.length} 张图片，可继续编辑，提交后保存`);
      } catch (err) { ElMessage.error(err.message); }
      finally { uploading.value = false; e.target.value = ''; }
    }
    async function onDetailFeedbackUpload(e) { await onFeedbackUpload(e); }
    function removeFeedbackPhoto(i) { feedbackPhotos.value.splice(i, 1); }
    function openFeedback(row) {
      feedbackTarget.value = row;
      rectifyNote.value = '';
      feedbackPhotos.value = [];
      feedbackVisible.value = true;
    }

    async function onCreateUpload(e) {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      uploading.value = true;
      try {
        const urls = await uploadFiles(files, api);
        form.photos.push(...urls);
        ElMessage.success(`已添加 ${urls.length} 张图片（未提交前可删除）`);
      } catch (err) { ElMessage.error(err.message); }
      finally { uploading.value = false; e.target.value = ''; }
    }
    function openRemind(row) {
      remindTarget.value = row;
      remindContent.value = `请尽快处理隐患「${row.title || row.description?.slice(0,20)}」，当前状态：${STATUS_MAP[row.status] || row.status}。`;
      remindVisible.value = true;
    }
    async function sendRemind() {
      saving.value = true;
      try {
        await api.remindHazard(remindTarget.value._id, remindContent.value);
        ElMessage.success('催办已发送');
        remindVisible.value = false;
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }
    function openCreate() {
      // 默认业务：单业务账号直接用其唯一业务；多业务账号取当前科室下第一个「有权限」的业务。
      // 注意必须与 bizCreateOpts 同一口径，否则默认项可能落在下拉之外（v1.0.30 修正）。
      const allowed = bizCreateOpts.value.map(o => o.value);
      const deptBiz = businessesForDept(currentDept(), store.user || {}).filter(b => allowed.indexOf(b.code) !== -1);
      const biz = singleBusiness.value || (deptBiz[0] ? deptBiz[0].code : (allowed[0] || 'SAFE'));
      Object.assign(form, { title: '', businessType: biz, category: (categoryOptions(biz)[0] || '其他'), severity: 'general', department: depts.value[0]?.name || '', location: '', assigneeId: '', assigneeName: '', dueDate: '', description: '', photos: [] });
      editId.value = null;
      createVisible.value = true;
    }
    // 编辑：复用新增表单，回填记录字段（类别/严重程度/期限/位置等）
    function openEdit(row) {
      const h = row;
      const biz = h.businessType || singleBusiness.value || (bizFilterOpts.value[0] ? bizFilterOpts.value[0].value : 'SAFE');
      Object.assign(form, {
        title: h.title || '',
        businessType: biz,
        category: h.category || '其他',
        severity: h.severity || 'general',
        department: h.department || '',
        location: h.location || '',
        assigneeId: h.assigneeId || '',
        assigneeName: h.assigneeName || '',
        dueDate: (h.dueDate || h.deadline || '').slice(0, 10) || '',
        description: h.description || '',
        photos: Array.isArray(h.photos) ? h.photos.slice() : []
      });
      editId.value = h._id || h.id;
      createVisible.value = true;
    }
    // 切换业务 → 类别下拉级联重置为该项业务的首个类别
    function onBusinessChange(biz) {
      const opts = categoryOptions(biz);
      form.category = (opts && opts.length) ? opts[0] : '其他';
    }
    function onAssigneeChange(id) {
      const u = rectifiers.value.find(x => x._id === id);
      form.assigneeName = u ? u.name : '';
    }
    async function create() {
      if (!form.title || !form.department || !form.description || !form.assigneeId) { ElMessage.warning('请填写标题、部门、责任人和描述'); return; }
      // 兜底：业务必须在当前账号权限内（防止管理员在后台改权限后弹窗仍留旧值）
      const allowedCodes = bizCreateOpts.value.map(o => o.value);
      if (allowedCodes.length && allowedCodes.indexOf(form.businessType) === -1) {
        ElMessage.warning('所选业务不在您的权限范围内，请重新选择');
        return;
      }
      saving.value = true;
      try {
        const me = store.user || {};
        if (editId.value) {
          // 编辑模式：仅更新可改字段，并回填业务/科室（历史隐患可能缺这俩字段）
          await api.updateHazard(editId.value, {
            title: form.title,
            category: form.category,
            severity: form.severity,
            department: form.department,
            location: form.location,
            businessType: form.businessType,
            deptCode: deptOf(form.businessType) || 'JN',
            dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : '',
            deadline: form.dueDate ? new Date(form.dueDate).toISOString() : '',
            description: form.description,
            photos: form.photos || [],
            updatedAt: new Date().toISOString()
          });
          ElMessage.success('隐患已更新');
        } else {
          await api.createHazard({
            title: form.title,
            businessType: form.businessType,
            deptCode: deptOf(form.businessType) || 'JN',
            category: form.category,
            severity: form.severity,
            department: form.department,
            location: form.location,
            assigneeId: form.assigneeId,
            assigneeName: form.assigneeName,
            reporterId: me._id || '',
            reporterName: me.name || me.username || '',
            dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : '',
            deadline: form.dueDate ? new Date(form.dueDate).toISOString() : '',
            description: form.description,
            status: 'pending',
            photos: form.photos || [],
            rectificationPhotos: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          ElMessage.success('已新增隐患');
        }
        createVisible.value = false;
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }
    // 重新指派整改人：换人后状态重置为 pending（对齐 APK updateAssignee），让新整改人能在「待反馈」看到
    function openReassign(row) {
      reassignTarget.value = row;
      reassignId.value = '';
      reassignVisible.value = true;
    }
    function onReassignChange(id) {
      const u = rectifiers.value.find(x => x._id === id);
      reassignId.value = id;
    }
    async function reassign() {
      if (!reassignId.value) { ElMessage.warning('请选择新整改人'); return; }
      const u = rectifiers.value.find(x => x._id === reassignId.value);
      if (!u) return;
      saving.value = true;
      try {
        const id = reassignTarget.value._id || reassignTarget.value.id;
        await api.updateHazard(id, {
          assigneeId: u._id,
          assigneeName: u.name,
          status: 'pending',
          updatedAt: new Date().toISOString()
        });
        ElMessage.success('已重新指派给 ' + u.name);
        reassignVisible.value = false;
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }
    // 撤回隐患：发起人/管理员在流程早期软删（status:'deleted', isDeleted:true），对齐 APK recallIssue
    async function recall(row) {
      try {
        await ElementPlus.ElMessageBox.confirm(
          '撤回后该隐患将从列表移除（软删除，可在云端恢复）。确定撤回吗？',
          '撤回隐患',
          { type: 'warning', confirmButtonText: '确定撤回', cancelButtonText: '取消' }
        );
      } catch (e) { return; }
      saving.value = true;
      try {
        const id = row._id || row.id;
        await api.updateHazard(id, {
          status: 'deleted',
          isDeleted: true,
          deletedAt: new Date().toISOString(),
          deletedBy: (store.user && (store.user.name || store.user.username)) || '',
          updatedAt: new Date().toISOString()
        });
        ElMessage.success('隐患已撤回');
        load();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    // 导出时所用的「统计范围」描述（取自当前筛选条件）
    function buildPeriod() {
      const parts = [];
      if (filterStatus.value) parts.push('状态:' + (STATUS_MAP[filterStatus.value] || filterStatus.value));
      if (filterDept.value) parts.push('部门:' + filterDept.value);
      if (filterSeverity.value) parts.push('等级:' + (SEVERITY_MAP[filterSeverity.value] || filterSeverity.value));
      if (kw.value) parts.push('关键词:' + kw.value);
      return parts.length ? parts.join(' ') : '全部数据';
    }
    function ts() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }
    async function fetchAllForExport() {
      // 按当前筛选取全部数据（size=0 返回不分页全量），再按角色过滤（非管理员只导自己相关的）
      const r = await api.hazards({
        page: 1, size: 0,
        status: filterStatus.value, department: filterDept.value,
        severity: filterSeverity.value, keyword: kw.value
      });
      let issues = filterIssuesByRole(store.user, r.list || []).filter((h) => inDeptScope(h, store.user));
      // 业务筛选与页面列表同口径（businessOf），保证「导出 = 所见」：选安全只导安全，不混入节能/环保
      if (filterBusiness.value) issues = issues.filter((h) => businessOf(h) === filterBusiness.value);
      return issues;
    }
    async function exportExcel() {
      if (!window.XLSX) { ElMessage.error('Excel 组件未加载，请重启客户端'); return; }
      if (!window.electronAPI) { ElMessage.error('本地导出能力不可用'); return; }
      exporting.value = true;
      try {
        let issues = await fetchAllForExport();
        if (!issues.length) { ElMessage.warning('当前筛选无数据可导出'); return; }
        // 先把所有 cloud:// 照片刷新为临时 HTTPS URL，避免 Excel 里出现“链接失效”
        await resolveIssuesPhotos(issues);

        // 下载并缩放隐患/整改照片（并发 4，单张失败只显示“无图片”，不中断导出）
        const urls = collectExportPhotoUrls(issues);
        let photoStore = new Map();
        if (urls.length && typeof window.electronAPI.fetchImageUrl === 'function') {
          photoStore = await fetchPhotoThumbnails(urls, {
            fetchImage: (p) => window.electronAPI.fetchImageUrl(p),
            concurrency: 4, maxPx: 120, timeoutMs: 20000
          });
        }

        const meta = {
          period: buildPeriod(),
          exportUser: (store.user && (store.user.name || store.user.username)) || '管理员',
          generatedAt: new Date().toISOString(),
          photoStore
        };
        const wb = buildExcelWorkbook(window.XLSX, issues, meta);
        // base64 传递，避免大数组在 IPC 结构化克隆时的兼容问题
        const b64 = window.XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const res = await window.electronAPI.saveXlsxEnhanced({
          defaultName: 'GZ巡查整改台账_' + ts() + '.xlsx',
          buffer: b64,
          plan: wb.__ledgerPlan || {}
        });
        if (res && res.error) ElMessage.error('导出失败：' + res.error);
        else if (res && !res.canceled) {
          const n = ((wb.__ledgerPlan || {}).media || []).length;
          ElMessage.success(n ? `Excel 已保存：${res.filePath}（内嵌图片 ${n} 张）` : 'Excel 已保存：' + res.filePath);
        }
      } catch (e) { ElMessage.error(e.message || '导出失败'); }
      finally { exporting.value = false; }
    }
    async function exportPdf() {
      if (!window.electronAPI) { ElMessage.error('本地导出能力不可用'); return; }
      exporting.value = true;
      try {
        let issues = await fetchAllForExport();
        if (!issues.length) { ElMessage.warning('当前筛选无数据可导出'); return; }
        // PDF 需要内嵌可访问的图片，先刷新 cloud:// fileID
        await resolveIssuesPhotos(issues);
        const meta = { period: buildPeriod(), exportUser: (store.user && (store.user.name || store.user.username)) || '管理员', generatedAt: new Date().toISOString() };
        const html = buildPdfHtml(issues, meta);
        const res = await window.electronAPI.exportPdf({ defaultName: 'GZ巡查整改报告_' + ts() + '.pdf', html });
        if (res && res.error) ElMessage.error('导出失败：' + res.error);
        else if (res && !res.canceled) ElMessage.success('PDF 已保存：' + res.filePath);
      } catch (e) { ElMessage.error(e.message || '导出失败'); }
      finally { exporting.value = false; }
    }

    onMounted(async () => {
      const [d, u] = await Promise.all([api.departments(), api.users({})]);
      depts.value = d;
      users.value = (u.list || []).filter(x => x.status !== 'disabled');
      // 整改责任人：对齐 APK，排除 admin 账号即可，不限 role/部门
      rectifiers.value = users.value.filter(u => !isAdmin(u));
      // 若其他页面（如仪表盘/统计）预设了筛选条件，在这里应用一次
      if (store.pendingHazardFilter) {
        const f = store.pendingHazardFilter;
        if (f.status != null) filterStatus.value = f.status;
        if (f.department != null) filterDept.value = f.department;
        if (f.severity != null) filterSeverity.value = f.severity;
        if (f.keyword != null) kw.value = f.keyword;
        if (f.overdue === true) overdueOnly.value = true;
        store.pendingHazardFilter = null;
      }
      load();
    });

    // 业务下拉改为动态字典：管理端新增/停用业务后，这里无需重新编译即可看到变化
    const bizOpts = computed(() => businessOptions());
    // 类别下拉随所选业务级联；切换业务后自动重置为首选项
    const categoryOpts = computed(() => categoryOptions(form.businessType));

    return {
      STATUS_OPTS, SEVERITY_OPTS, BUSINESS_OPTS: bizOpts, CATEGORY_OPTS: categoryOpts, STATUS_MAP, SEVERITY_MAP, ROLE_MAP, list, total, page, size, loading,
      kw, filterStatus, filterBusiness, filterDept, filterSeverity, depts, rectifiers, me, singleBusiness, bizFilterOpts, bizCreateOpts,
      canCreate, canUrgeIssue, canStartRectify, canSubmitRectify, canReviewIssue, canModify, canRecall,
      detailVisible, current, newStatus, rectifyNote, remindVisible, remindContent, feedbackVisible, feedbackPhotos, createVisible, editId, saving, uploading, exporting, overdueOnly, form,
      reassignVisible, reassignTarget, reassignId,
      search, reset, onPage, onSize, openDetail, startRectify, submitRectify, reviewIssue, onFeedbackUpload, onDetailFeedbackUpload, removeFeedbackPhoto, openFeedback, onCreateUpload, openRemind, sendRemind, openCreate, openEdit, create, recall, openReassign, onReassignChange, reassign,
      exportExcel, exportPdf,
      onBusinessChange, onAssigneeChange, statusClass, severityClass, fmtDate, businessLabelOf,
      Search, Refresh, Plus, View, Bell, Download, Printer, ArrowLeft, Edit, Switch, Delete
    };
  }
};
