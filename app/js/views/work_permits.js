import { api } from '../api.js';
import { store } from '../store.js';
import { isAdmin, isSafetyEnvStaff } from '../permission.js';

// 作业票签批（电脑端台账 + 签批）
// 数据集合 work_permits 与移动端（env_inspection_v370/lib/models/work_permit.dart）同源共享，
// 类型/状态中文枚举、签字节点链、有效期规则（GB 30871-2022）均严格对齐移动端，
// 因此两端数据天然一致、实时同步。
//
// 电脑端定位：台账查阅 + 签批流转管理（现场确认/分级审批/开工/完工/中止/复工/驳回/作废）。
// 手写签字：移动端走 SignaturePad 手写笔迹；电脑端为管理侧台账，签字以「角色+账号+时间」落证
// （imageUrl 留空，移动端现场签字图片经云端 URL 同步后可在电脑端直接调阅）。

const { ref, reactive, computed, onMounted } = Vue;

const TYPE_OPTS = ['动火作业票', '密闭空间作业票', '高空作业票'];
const STATUS_OPTS = [
  '草稿', '待安全交底', '待现场确认', '待审批', '已批准', '进行中',
  '待验收', '已关闭', '已过期', '已驳回', '已中止', '已作废'
];

// 分级选项（对齐移动端 PermitRules.levels）
const LEVELS = {
  '动火作业票': ['特级', '一级', '二级'],
  '密闭空间作业票': ['高风险', '中风险', '低风险'],
  '高空作业票': ['Ⅰ级(2~5m)', 'Ⅱ级(5~15m)', 'Ⅲ级(15~30m)', 'Ⅳ级(≥30m)']
};
// 有效期上限（小时）：动火特级/一级 8、二级 72；受限 24；高处 168（GB 30871 §5.1.5/§8.2.11）
const VALIDITY_HOURS = {
  '动火作业票': (lv) => (lv === '二级' ? 72 : 8),
  '密闭空间作业票': () => 24,
  '高空作业票': () => 168
};
// 措施卡模板（对齐移动端 PermitRules.measureTemplate）
const MEASURE_TPL = {
  '动火作业票': [
    '动火人、监火人持特种作业操作证（§4.9）',
    '作业前气体分析合格，数据齐全（§5.3.1）',
    '清除/隔离周围可燃物，配备灭火器不少于2具',
    '设备/管线已倒空、吹扫、置换、盲板隔离',
    '五级风以上/夜间动火已提级管理',
    '乙炔瓶直立、防倾倒，气瓶安全距离合规'
  ],
  '密闭空间作业票': [
    '作业前30分钟内气体检测：氧含量19.5%~23.5%',
    '作业期间连续监测可燃/有毒/氧气浓度，每2小时记录',
    '强制通风，严禁向受限空间通纯氧',
    '监护人在受限空间外全程监护，配备救援装备（§6.8）',
    '转动设备已断电、挂牌「有人工作严禁合闸」',
    '照明电压≤36V，使用防爆工具',
    '进出人员、工器具清点登记（三不进入）'
  ],
  '高空作业票': [
    '作业人员持特种作业证，无职业禁忌（GBZ/T 260）',
    '佩戴全身式安全带并高挂低用（GB 6095）',
    '脚手架/平台/临边防护验收合格（≥1.2m护栏）',
    '六级以上大风、暴雨、大雾、雷电等恶劣天气禁止作业',
    '禁止抛掷物料，工具绳索传递',
    '交叉作业设硬质隔离/安全网，不得垂直同时作业',
    '专人全程监护，监护人不得离场（§4.10）'
  ]
};

// 签字节点中文（对齐移动端 SignNode）
const NODE_NAME = { apply: '作业申请', disclose: '安全交底', siteConfirm: '现场确认', approve: '分级审批', close: '验收关闭' };
// 状态样式（标签着色）
function statusClass(st) {
  if (st === '已关闭') return 'tag-closed';
  if (st === '已过期' || st === '已驳回' || st === '已作废') return 'tag-overdue';
  if (st === '进行中' || st === '已批准') return 'tag-active';
  if (st === '已中止') return 'tag-warn';
  return 'tag-pending';
}
function fmtDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }
function myId() {
  const u = store.user || {};
  return u._id || u.id || u.username || u.name || '';
}
function myName() { return (store.user && (store.user.name || store.user.username)) || ''; }
// 防篡改摘要（与移动端 PermitSignature.makeHash 同算法）
function makeHash(imageUrl, at, signerId) {
  const src = [imageUrl || '', at, signerId, 'gzxc-permit'].join('|');
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) & 0x7fffffff;
  return h.toString(16);
}

function emptyForm() {
  return reactive({
    permitType: '动火作业票',
    level: '特级',
    title: '',
    workshop: '',
    deptCode: (store.user && store.user.department) || '',
    location: '',
    applicantName: myName(),
    jobContent: '',
    planStart: '',
    planEnd: '',
    riskAnalysis: '',
    measures: []
  });
}

export default {
  template: `
  <div>
    <h2 class="page-title neon-title">作业票签批</h2>
    <p class="page-sub">动火 / 密闭空间 / 高空 三类特殊作业 · 签字节点链 · 与移动端同源实时同步</p>

    <div class="toolbar">
      <el-input v-model="kw" placeholder="标题/申请人/地点/车间/编号" clearable style="width:240px" @keyup.enter="search" />
      <el-select v-model="filterType" placeholder="作业类型" clearable style="width:150px">
        <el-option v-for="t in TYPE_OPTS" :key="t" :label="t" :value="t" />
        <el-option label="全部类型" value="all" />
      </el-select>
      <el-select v-model="filterStatus" placeholder="状态" clearable style="width:130px">
        <el-option v-for="s in STATUS_OPTS" :key="s" :label="s" :value="s" />
        <el-option label="全部状态" value="all" />
      </el-select>
      <el-button type="primary" :icon="Search" @click="search">查询</el-button>
      <el-button :icon="Refresh" @click="reset">重置</el-button>
      <span class="spacer"></span>
      <el-button type="success" :icon="Plus" @click="openCreate">发起作业票</el-button>
      <el-button type="warning" :icon="Download" :loading="exporting" @click="exportExcel">导出Excel</el-button>
    </div>

    <div class="card" style="min-width:0">
      <div class="table-wrap">
      <el-table :data="list" v-loading="loading" size="default" stripe>
        <el-table-column label="编号" width="150">
          <template #default="{row}">{{ row.id || row._id }}</template>
        </el-table-column>
        <el-table-column prop="permitType" label="类型" width="130" />
        <el-table-column prop="level" label="分级" width="100" />
        <el-table-column label="作业内容" min-width="180" show-overflow-tooltip>
          <template #default="{row}">{{ row.title || '—' }}</template>
        </el-table-column>
        <el-table-column prop="workshop" label="车间" width="110" />
        <el-table-column prop="location" label="作业地点" width="130" show-overflow-tooltip />
        <el-table-column prop="applicantName" label="申请人" width="90" />
        <el-table-column label="有效期" width="140">
          <template #default="{row}">{{ fmtDate(row.effectiveStart) }} <br/> ~ {{ fmtDate(row.expireAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{row}"><span :class="statusClass(row.status)">{{ row.status || '草稿' }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{row}">
            <el-button text type="primary" :icon="View" @click="openDetail(row)">详情/签批</el-button>
          </template>
        </el-table-column>
      </el-table>
      </div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end;align-items:center;gap:12px">
        <el-pagination background layout="total, sizes, prev, pager, next, jumper" :total="total" :page-size="size" :page-sizes="[10,20,50,100]" :current-page="page" @current-change="onPage" @size-change="onSize" />
      </div>
    </div>

    <!-- 详情 / 签批 -->
    <el-dialog v-model="detailVisible" width="900px" top="4vh" :close-on-click-modal="false">
      <template #header>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="back-inline" @click="detailVisible=false" title="返回"><ArrowLeft style="width:16px;height:16px" /></span>
          <span style="font-weight:600">作业票详情与签批流转</span>
          <span v-if="current" :class="statusClass(current.status)" style="margin-left:6px">{{ current.status }}</span>
        </div>
      </template>
      <div v-if="current" style="max-height:74vh;overflow:auto;padding-right:6px">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="编号" :span="2">{{ current.id || current._id }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ current.permitType }}</el-descriptions-item>
          <el-descriptions-item label="分级">{{ current.level }}</el-descriptions-item>
          <el-descriptions-item label="作业内容/标题" :span="2">{{ current.title || '—' }}</el-descriptions-item>
          <el-descriptions-item label="车间">{{ current.workshop || '—' }}</el-descriptions-item>
          <el-descriptions-item label="作业地点">{{ current.location || '—' }}</el-descriptions-item>
          <el-descriptions-item label="申请人">{{ current.applicantName }}</el-descriptions-item>
          <el-descriptions-item label="所属部门">{{ current.deptCode || '—' }}</el-descriptions-item>
          <el-descriptions-item label="计划开始">{{ fmtDate(current.planStart) }}</el-descriptions-item>
          <el-descriptions-item label="计划结束">{{ fmtDate(current.planEnd) }}</el-descriptions-item>
          <el-descriptions-item label="实际作业起">{{ fmtDate(current.effectiveStart) }}</el-descriptions-item>
          <el-descriptions-item label="有效期至">{{ fmtDate(current.expireAt) }}</el-descriptions-item>
          <el-descriptions-item label="危险辨识" :span="2">{{ current.riskAnalysis || '—' }}</el-descriptions-item>
        </el-descriptions>

        <h3 style="margin:14px 0 8px;color:#fff">措施卡（逐条确认）</h3>
        <el-table :data="current.measures || []" size="small" border>
          <el-table-column type="index" label="#" width="40" />
          <el-table-column prop="text" label="措施内容" min-width="260" show-overflow-tooltip />
          <el-table-column label="确认" width="70" align="center">
            <template #default="{row}"><el-tag :type="row.checked ? 'success' : 'info'" size="small">{{ row.checked ? '已确认' : '未确认' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="确认人/时间" width="200">
            <template #default="{row}">{{ row.confirmedBy || '—' }}<br/>{{ fmtDate(row.confirmedAt) }}</template>
          </el-table-column>
        </el-table>

        <h3 style="margin:14px 0 8px;color:#fff">作业人员（含持证）</h3>
        <el-table :data="current.workers || []" size="small" border>
          <el-table-column prop="name" label="姓名" width="100" />
          <el-table-column prop="role" label="岗位/角色" width="140" />
          <el-table-column prop="certNo" label="特种作业证号" min-width="160" />
        </el-table>

        <h3 style="margin:14px 0 8px;color:#fff">气体检测记录（受限空间每2h复测 / 动火中断重测）</h3>
        <el-table :data="current.gasAnalysis || []" size="small" border>
          <el-table-column label="检测时间" width="150"><template #default="{row}">{{ fmtDate(row.sampledAt) }}</template></el-table-column>
          <el-table-column prop="point" label="部位" width="120" />
          <el-table-column label="O₂%" width="80" align="center">
            <template #default="{row}"><span :style="{color: (row.o2>=19.5 && row.o2<=23.5)?'#67c23a':'#f56c6c'}">{{ row.o2 }}</span></template>
          </el-table-column>
          <el-table-column prop="combustible" label="可燃气体%LEL" width="110" align="center" />
          <el-table-column prop="toxic" label="有毒气体" width="120" show-overflow-tooltip />
          <el-table-column prop="analyst" label="检测人" width="90" />
          <el-table-column prop="result" label="结论" width="80" align="center">
            <template #default="{row}"><el-tag :type="row.result==='合格'?'success':'danger'" size="small">{{ row.result }}</el-tag></template>
          </el-table-column>
        </el-table>
        <el-button v-if="canGas(current)" size="small" type="primary" plain :icon="Plus" @click="gasVisible=true" style="margin-top:8px">追加气体检测记录</el-button>

        <h3 style="margin:14px 0 8px;color:#fff">签字节点链（存证）</h3>
        <el-timeline>
          <el-timeline-item
            v-for="(s,i) in (current.signatures||[])" :key="i"
            :timestamp="fmtDate(s.signedAt)" :type="i===lastSignedIdx?'primary':'success'" placement="top">
            <div><b>{{ NODE_NAME[s.node] || s.node }}</b> · {{ s.role }} · {{ s.signerName }}</div>
            <div style="color:#9aa4b2;font-size:12px">现场说明：{{ s.location || '—' }} · 摘要 {{ s.hash || '—' }}</div>
            <img v-if="isCloudUrl(s.imageUrl)" :src="s.imageUrl" style="max-height:90px;margin-top:6px;border:1px solid #334155;border-radius:6px" />
            <div v-else style="color:#9aa4b2;font-size:12px;margin-top:4px">（手写签字图片存于移动端，电脑端仅展示签证人/时间存证）</div>
          </el-timeline-item>
          <el-timeline-item v-if="!(current.signatures||[]).length" timestamp="尚未签字" type="info">—</el-timeline-item>
        </el-timeline>

        <h3 style="margin:14px 0 8px;color:#fff">现场照片</h3>
        <div v-if="(current.attachments||[]).length" style="display:flex;flex-wrap:wrap;gap:8px">
          <img v-for="(u,i) in current.attachments" :key="i" :src="u" style="max-height:90px;border:1px solid #334155;border-radius:6px" />
        </div>
        <div v-else style="color:#9aa4b2;font-size:12px">暂无</div>

        <div v-if="current.remark" style="margin-top:10px;color:#f8a978">备注/原因：{{ current.remark }}</div>

        <!-- 流转操作 -->
        <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:10px;border-top:1px solid #334155;padding-top:14px">
          <el-button v-if="canSiteConfirm(current)" type="primary" :icon="Select" @click="flow('siteConfirm','现场确认')">现场确认</el-button>
          <el-button v-if="canApprove(current)" type="success" :icon="Stamp" @click="flow('approve','分级审批')">分级审批</el-button>
          <el-button v-if="canStartWork(current)" type="warning" :icon="VideoPlay" @click="flow('startWork','开工')">开工（计时起点）</el-button>
          <el-button v-if="canFinish(current)" :icon="CircleCheck" @click="flow('finish','完工')">完工</el-button>
          <el-button v-if="canClose(current)" type="success" :icon="Finished" @click="flow('close','验收关闭')">验收关闭</el-button>
          <el-button v-if="canSuspend(current)" type="danger" plain :icon="VideoPause" @click="flowPrompt('suspend','中止作业')">中止</el-button>
          <el-button v-if="canResume(current)" :icon="Refresh" @click="flow('resume','复工')">复工</el-button>
          <el-button v-if="canReject(current)" type="danger" plain :icon="Close" @click="flowPrompt('reject','驳回')">驳回</el-button>
          <el-button v-if="canVoid(current)" type="danger" :icon="Delete" @click="flowPrompt('void','作废')">作废</el-button>
        </div>
        <el-alert v-if="!hasAction(current)" style="margin-top:10px" type="info" :closable="false" title="当前状态无需电脑端操作，或当前账号无对应签批权限（现场签字请在移动端完成）。" />
      </div>
    </el-dialog>

    <!-- 追加气体检测 -->
    <el-dialog v-model="gasVisible" title="追加气体检测记录" width="520px">
      <el-form label-width="110px" :model="gasForm">
        <el-form-item label="检测部位"><el-input v-model="gasForm.point" placeholder="如：釜内/管廊" /></el-form-item>
        <el-form-item label="氧含量%"><el-input v-model="gasForm.o2" placeholder="19.5~23.5 合格" /><span style="font-size:12px;color:#9aa4b2">受限空间合格区间 19.5%~23.5%</span></el-form-item>
        <el-form-item label="可燃气体%LEL"><el-input v-model="gasForm.combustible" /></el-form-item>
        <el-form-item label="有毒气体"><el-input v-model="gasForm.toxic" placeholder="如：CO/H2S 浓度描述" /></el-form-item>
        <el-form-item label="检测人"><el-input v-model="gasForm.analyst" :placeholder="myName()" /></el-form-item>
        <el-form-item label="结论"><el-select v-model="gasForm.result"><el-option label="合格" value="合格" /><el-option label="不合格" value="不合格" /></el-select></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="gasVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveGas">保存</el-button>
      </template>
    </el-dialog>

    <!-- 发起作业票 -->
    <el-dialog v-model="createVisible" title="发起作业票（N1 申请）" width="720px" top="4vh" :close-on-click-modal="false">
      <el-form label-width="110px" :model="form">
        <el-form-item label="作业类型" required>
          <el-select v-model="form.permitType" @change="onTypeChange" style="width:220px">
            <el-option v-for="t in TYPE_OPTS" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="分级" required>
          <el-select v-model="form.level" style="width:220px">
            <el-option v-for="l in levelOpts" :key="l" :label="l" :value="l" />
          </el-select>
          <span style="font-size:12px;color:#9aa4b2;margin-left:10px">{{ validityHint }}</span>
        </el-form-item>
        <el-form-item label="作业内容" required><el-input v-model="form.title" placeholder="作业名称/内容摘要" /></el-form-item>
        <el-form-item label="车间"><el-input v-model="form.workshop" /></el-form-item>
        <el-form-item label="作业地点"><el-input v-model="form.location" /></el-form-item>
        <el-form-item label="申请人"><el-input v-model="form.applicantName" /></el-form-item>
        <el-form-item label="所属部门"><el-input v-model="form.deptCode" /></el-form-item>
        <el-form-item label="计划开始"><el-date-picker v-model="form.planStart" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width:220px" /></el-form-item>
        <el-form-item label="计划结束"><el-date-picker v-model="form.planEnd" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width:220px" /></el-form-item>
        <el-form-item label="危险辨识"><el-input v-model="form.riskAnalysis" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="措施卡" required>
          <div style="width:100%">
            <el-checkbox v-for="(m,i) in form.measures" :key="i" v-model="m.checked" style="display:block;white-space:normal;margin-right:0">
              {{ m.text }}
            </el-checkbox>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">提交申请</el-button>
      </template>
    </el-dialog>
  </div>
  `,
  setup() {
    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const size = ref(20);
    const loading = ref(false);
    const kw = ref('');
    const filterType = ref('all');
    const filterStatus = ref('all');
    const exporting = ref(false);
    const detailVisible = ref(false);
    const current = ref(null);
    const createVisible = ref(false);
    const gasVisible = ref(false);
    const saving = ref(false);
    const form = emptyForm();
    const gasForm = reactive({ point: '', o2: '', combustible: '', toxic: '', analyst: myName(), result: '合格' });

    const me = computed(() => store.user || {});
    const levelOpts = computed(() => LEVELS[form.permitType] || []);
    const validityHint = computed(() => {
      const t = form.permitType;
      if (t === '动火作业票') return '动火特级/一级≤8h，二级≤72h（GB 30871 §5.1.5）';
      if (t === '密闭空间作业票') return '受限空间≤24h，每2h复测气体';
      return '高处作业票≤7天（§8.2.11）';
    });
    const lastSignedIdx = computed(() => (current.value && current.value.signatures ? current.value.signatures.length - 1 : -1));

    // ---------- 权限（对齐移动端 work_permit_provider 权限口径） ----------
    function canSiteConfirm(p) {
      return me.value.isActive !== false && me.value.id !== p.applicantId &&
        (p.status === '待现场确认');
    }
    function canApprove(p) {
      return (isSafetyEnvStaff(me.value) || me.value.role === 'admin' || me.value.role === 'supervisor') &&
        p.status === '待审批';
    }
    function canStartWork(p) { return me.value.isActive !== false && p.status === '已批准'; }
    function canFinish(p) { return me.value.isActive !== false && p.status === '进行中'; }
    function canClose(p) { return me.value.isActive !== false && p.status === '待验收'; }
    function canSuspend(p) { return me.value.isActive !== false && (p.status === '已批准' || p.status === '进行中'); }
    function canResume(p) { return me.value.isActive !== false && p.status === '已中止'; }
    function canReject(p) {
      return (isSafetyEnvStaff(me.value) || me.value.role === 'admin' || me.value.role === 'supervisor') &&
        ['待安全交底', '待现场确认', '待审批'].includes(p.status);
    }
    function canVoid(p) {
      return isSafetyEnvStaff(me.value) || me.value.role === 'admin';
    }
    function canGas(p) {
      return me.value.isActive !== false && (p.permitType === '密闭空间作业票' || p.permitType === '动火作业票') &&
        ['已批准', '进行中'].includes(p.status);
    }
    function hasAction(p) {
      return canSiteConfirm(p) || canApprove(p) || canStartWork(p) || canFinish(p) || canClose(p) ||
        canSuspend(p) || canResume(p) || canReject(p) || canVoid(p);
    }
    function isCloudUrl(u) { return typeof u === 'string' && /^https?:\/\//.test(u); }

    async function load() {
      loading.value = true;
      try {
        const r = await api.workPermits({ keyword: kw.value, type: filterType.value, status: filterStatus.value, page: page.value, size: size.value });
        list.value = r.list || [];
        total.value = r.total || 0;
      } catch (e) { ElMessage.error(e.message || '加载失败'); }
      finally { loading.value = false; }
    }
    function search() { page.value = 1; load(); }
    function reset() { kw.value = ''; filterType.value = 'all'; filterStatus.value = 'all'; page.value = 1; load(); }
    function onPage(p) { page.value = p; load(); }
    function onSize(s) { size.value = s; page.value = 1; load(); }

    function openDetail(row) {
      current.value = JSON.parse(JSON.stringify(row));
      detailVisible.value = true;
    }

    // 流转动作：纯电脑端台账管理，签字以「角色+账号+时间」落证（无手写笔迹图片）。
    async function flow(action, label) { await doFlow(action, label, ''); }
    async function flowPrompt(action, label) {
      try {
        const { value } = await ElementPlus.ElMessageBox.prompt('请输入' + label + '原因（留痕）', label, { inputType: 'textarea', confirmButtonText: '确定' });
        await doFlow(action, label, value || '');
      } catch (e) { /* 取消 */ }
    }
    async function doFlow(action, label, reason) {
      const p = current.value;
      if (!p) return;
      saving.value = true;
      try {
        const now = new Date().toISOString();
        const patch = { updatedAt: now };
        const sigs = (p.signatures || []).map((x) => Object.assign({}, x));
        const pushSig = (node, role) => sigs.push({
          node, role, signerId: myId(), signerName: myName(), imageUrl: '',
          signedAt: now, location: '', hash: makeHash('', now, myId())
        });
        switch (action) {
          case 'siteConfirm': pushSig('siteConfirm', '现场确认（班长/计划员）'); patch.status = '待审批'; break;
          case 'approve': pushSig('approve', '分级审批（安环/车间主任）'); patch.status = '已批准'; break;
          case 'startWork':
            patch.effectiveStart = now;
            patch.expireAt = expireAt(p, now);
            patch.status = '进行中'; break;
          case 'finish': patch.status = '待验收'; break;
          case 'close': pushSig('close', '验收关闭'); patch.status = '已关闭'; break;
          case 'suspend': patch.status = '已中止'; patch.remark = reason; break;
          case 'resume':
            patch.effectiveStart = now;
            patch.expireAt = expireAt(p, now);
            patch.status = '进行中'; break;
          case 'reject': patch.status = '已驳回'; patch.remark = reason; break;
          case 'void': patch.status = '已作废'; patch.remark = reason; break;
        }
        if (sigs.length) patch.signatures = sigs;
        await api.updateWorkPermit(p._id || p.id, patch);
        current.value = Object.assign({}, p, patch);
        detailVisible.value = false;
        ElMessage.success(label + '成功');
        load();
      } catch (e) { ElMessage.error(e.message || (label + '失败')); }
      finally { saving.value = false; }
    }
    function expireAt(p, startIso) {
      const h = VALIDITY_HOURS[p.permitType] ? VALIDITY_HOURS[p.permitType](p.level) : 24;
      return new Date(new Date(startIso).getTime() + h * 3600 * 1000).toISOString();
    }

    async function saveGas() {
      const p = current.value;
      if (!p) return;
      saving.value = true;
      try {
        const o2 = parseFloat(gasForm.o2) || 0;
        const rec = {
          sampledAt: new Date().toISOString(), point: gasForm.point, o2,
          combustible: parseFloat(gasForm.combustible) || 0, toxic: gasForm.toxic,
          analyst: gasForm.analyst || myName(), result: gasForm.result
        };
        const gas = (p.gasAnalysis || []).map((x) => Object.assign({}, x));
        gas.push(rec);
        await api.updateWorkPermit(p._id || p.id, { gasAnalysis: gas, updatedAt: new Date().toISOString() });
        current.value = Object.assign({}, p, { gasAnalysis: gas });
        gasVisible.value = false;
        ElMessage.success('气体检测记录已保存');
      } catch (e) { ElMessage.error(e.message || '保存失败'); }
      finally { saving.value = false; }
    }

    function onTypeChange() {
      form.level = (LEVELS[form.permitType] || [])[0] || '';
      form.measures = (MEASURE_TPL[form.permitType] || []).map((t) => ({ text: t, checked: false, confirmedBy: '', confirmedAt: '' }));
    }
    function openCreate() {
      Object.assign(form, emptyForm());
      onTypeChange();
      createVisible.value = true;
    }
    async function submitCreate() {
      if (!form.title || !form.applicantName) { ElMessage.warning('请填写作业内容与申请人'); return; }
      saving.value = true;
      try {
        const id = 'WP' + Date.now().toString(36).toUpperCase();
        const now = new Date().toISOString();
        const measures = form.measures.map((m) => ({
          text: m.text, checked: !!m.checked,
          confirmedBy: m.checked ? myName() : '', confirmedAt: m.checked ? now : ''
        }));
        const payload = {
          id,
          permitType: form.permitType,
          level: form.level,
          title: form.title,
          workshop: form.workshop,
          deptCode: form.deptCode,
          location: form.location,
          applicantId: myId(),
          applicantName: form.applicantName,
          jobContent: form.title,
          planStart: form.planStart || now,
          planEnd: form.planEnd || now,
          riskAnalysis: form.riskAnalysis,
          measures,
          gasAnalysis: [],
          workers: [],
          signatures: [{
            node: 'apply', role: '作业申请（申请人）', signerId: myId(), signerName: form.applicantName,
            imageUrl: '', signedAt: now, location: '', hash: makeHash('', now, myId())
          }],
          attachments: [],
          status: '待安全交底',
          remark: '',
          createdAt: now,
          updatedAt: now
        };
        await api.createWorkPermit(payload);
        createVisible.value = false;
        ElMessage.success('作业票已发起，进入「待安全交底」');
        page.value = 1; load();
      } catch (e) { ElMessage.error(e.message || '发起失败'); }
      finally { saving.value = false; }
    }

    async function exportExcel() {
      if (!window.XLSX) { ElMessage.error('Excel 组件未加载，请重启客户端'); return; }
      if (!window.electronAPI) { ElMessage.error('本地导出能力不可用'); return; }
      exporting.value = true;
      try {
        const r = await api.workPermits({ keyword: kw.value, type: filterType.value, status: filterStatus.value, page: 1, size: 0 });
        const all = r.list || [];
        if (!all.length) { ElMessage.warning('当前筛选无数据可导出'); return; }
        const headers = ['编号', '类型', '分级', '作业内容', '车间', '作业地点', '申请人', '所属部门', '计划开始', '计划结束', '实际作业起', '有效期至', '状态'];
        const rows = all.map((x) => [
          x.id || x._id, x.permitType, x.level, x.title, x.workshop, x.location, x.applicantName, x.deptCode,
          fmtDate(x.planStart), fmtDate(x.planEnd), fmtDate(x.effectiveStart), fmtDate(x.expireAt), x.status || '草稿'
        ]);
        const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, '作业票');
        const b64 = window.XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        const ts = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; })();
        const res = await window.electronAPI.saveXlsxEnhanced({ defaultName: 'GZ作业票_' + ts + '.xlsx', buffer: b64, plan: {} });
        if (res && res.error) ElMessage.error('导出失败：' + res.error);
        else if (res && !res.canceled) ElMessage.success('Excel 已保存：' + res.filePath);
      } catch (e) { ElMessage.error(e.message || '导出失败'); }
      finally { exporting.value = false; }
    }

    onMounted(load);

    return {
      TYPE_OPTS, STATUS_OPTS, NODE_NAME, list, total, page, size, loading, kw, filterType, filterStatus,
      exporting, detailVisible, current, createVisible, gasVisible, saving, form, gasForm, me, levelOpts, validityHint, lastSignedIdx,
      statusClass, fmtDate, isCloudUrl,
      canSiteConfirm, canApprove, canStartWork, canFinish, canClose, canSuspend, canResume, canReject, canVoid, canGas, hasAction,
      search, reset, onPage, onSize, openDetail, flow, flowPrompt, saveGas, onTypeChange, openCreate, submitCreate, exportExcel,
      Search, Refresh, Plus, View, Download, ArrowLeft, Delete, Select, Stamp, VideoPlay, CircleCheck, Finished, VideoPause, Close
    };
  }
};
