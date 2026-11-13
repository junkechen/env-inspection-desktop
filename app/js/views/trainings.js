import { api } from '../api.js';
import { store } from '../store.js';
import { isAdmin, isSafetyEnvStaff } from '../permission.js';

// 安全教育培训（电脑端）
// 集合 training_resources / training_records 与移动端（env_inspection_v370/lib/models/training.dart）同源共享，
// 数据天然一致、实时同步。
//
// 轻量化原则（对齐设计文档）：培训资源仅存元数据 + 外链（政府权威源）/ 云端 URL（内部课件），
// 媒体不落地本地；电脑端以「外链浏览器打开 + 学习时长记录」呈现。
// 合规依据：3号令（金属冶炼高危：初训≥48·年再训≥16；新上岗≥72·年再训≥20；一般≥24/12）、§22 如实记录、§25 合格方可上岗、30号令（特种证6年·每3年复审）。

const { ref, reactive, computed, onMounted } = Vue;

const CATEGORY_OPTS = ['政策法规', '事故警示', '高危作业', '应急处置', '职业危害', '综合管理'];
const SOURCE_OPTS = [
  { value: '网络自动搜集', label: '网络自动搜集（政府权威源）' },
  { value: '公司内部', label: '公司内部（云端课件）' }
];
// 年度学时合规基准（3号令，金属冶炼=高危行业最严口径）
const HOURS_RULES = [
  { role: '主要负责人/安全管理人员', annual: 16, initial: 48, basis: '3号令第九条：高危行业初训≥48学时、每年再培训≥16学时' },
  { role: '新上岗从业人员', annual: 20, initial: 72, basis: '3号令第十三条：高危行业岗前≥72学时、每年再培训≥20学时' },
  { role: '其他从业人员（一般行业）', annual: 12, initial: 24, basis: '3号令：一般行业初训≥24学时、每年≥12学时' }
];
const EXAM_PASS = 80; // 合格线（落实「考核合格方可上岗」§25）

function fmtDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }

export default {
  template: `
  <div>
    <h2 class="page-title neon-title">安全教育培训</h2>
    <p class="page-sub">培训资源 · 学习时长（学时台账） · 测试成绩 · 竞赛排名 · 与移动端同源实时同步</p>

    <el-tabs v-model="tab">
      <!-- 培训资源 -->
      <el-tab-pane label="培训资源" name="res">
        <div class="toolbar">
          <el-input v-model="kw" placeholder="标题/摘要" clearable style="width:220px" @keyup.enter="loadRes" />
          <el-select v-model="filterCat" placeholder="类别" clearable style="width:140px">
            <el-option v-for="c in CATEGORY_OPTS" :key="c" :label="c" :value="c" />
            <el-option label="全部类别" value="all" />
          </el-select>
          <el-button type="primary" :icon="Search" @click="loadRes">查询</el-button>
          <span class="spacer"></span>
          <el-button v-if="canManage" type="success" :icon="Plus" @click="openCreateRes">新增资源</el-button>
        </div>
        <div class="card" style="min-width:0">
          <el-table :data="resources" v-loading="loadingRes" stripe>
            <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
            <el-table-column prop="category" label="类别" width="110" />
            <el-table-column prop="source" label="来源" width="130" />
            <el-table-column label="时长" width="80" align="center"><template #default="{row}">{{ row.durationMin || 0 }}分</template></el-table-column>
            <el-table-column prop="requiredLevel" label="三级教育" width="110" />
            <el-table-column label="状态" width="80" align="center"><template #default="{row}"><el-tag :type="row.status==='online'?'success':'info'" size="small">{{ row.status==='online'?'在线':'下线' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="220" fixed="right">
              <template #default="{row}">
                <el-button text type="primary" :icon="Link" @click="openRes(row)">打开学习</el-button>
                <el-button v-if="canManage" text type="danger" :icon="Delete" @click="removeRes(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- 学习时长 -->
      <el-tab-pane label="学习时长" name="study">
        <el-alert type="success" :closable="false" style="margin-bottom:10px"
          title="学时合规基准（3号令，金属冶炼=高危行业）"
          :description="hoursBasisText" />
        <div class="card">
          <el-table :data="studyStats" v-loading="loadingRec" stripe>
            <el-table-column prop="personName" label="姓名" width="110" />
            <el-table-column prop="deptCode" label="部门" width="140" />
            <el-table-column label="学习分钟" width="100" align="center"><template #default="{row}">{{ row.studyMinutes }}</template></el-table-column>
            <el-table-column label="折合学时" width="100" align="center"><template #default="{row}">{{ (row.studyMinutes/60).toFixed(1) }}</template></el-table-column>
            <el-table-column label="年度应达标(学时)" width="140" align="center"><template #default="{row}">{{ annualRequired }}</template></el-table-column>
            <el-table-column label="完成率" min-width="160">
              <template #default="{row}">
                <el-progress :percentage="row.rate" :status="row.rate>=100?'success':''" />
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- 测试成绩 -->
      <el-tab-pane label="测试成绩" name="exam">
        <div class="card">
          <el-table :data="examRows" v-loading="loadingRec" stripe>
            <el-table-column prop="personName" label="姓名" width="110" />
            <el-table-column prop="deptCode" label="部门" width="140" />
            <el-table-column prop="content" label="考试/试卷" min-width="180" show-overflow-tooltip />
            <el-table-column label="得分" width="90" align="center"><template #default="{row}">{{ row.score }}</template></el-table-column>
            <el-table-column label="合格(≥{{ examPass }})" width="110" align="center">
              <template #default="{row}"><el-tag :type="row.passed?'success':'danger'" size="small">{{ row.passed?'合格':'不合格' }}</el-tag></template>
            </el-table-column>
            <el-table-column label="时间" width="160"><template #default="{row}">{{ fmtDate(row.at) }}</template></el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- 竞赛排名 -->
      <el-tab-pane label="竞赛排名" name="rank">
        <el-alert type="info" :closable="false" style="margin-bottom:10px"
          title="积分规则：学习分钟数 + 最高合格考试成绩 + 竞赛得分（合格线 ≥ 80 分计入）" />
        <div class="card">
          <el-table :data="ranking" v-loading="loadingRec" stripe>
            <el-table-column label="排名" width="80" align="center"><template #default="{row,$index}">
              <span v-if="$index===0">🥇</span><span v-else-if="$index===1">🥈</span><span v-else-if="$index===2">🥉</span><span v-else>{{ $index+1 }}</span>
            </template></el-table-column>
            <el-table-column prop="personName" label="姓名" width="120" />
            <el-table-column prop="deptCode" label="部门" width="140" />
            <el-table-column label="学习分钟" width="100" align="center"><template #default="{row}">{{ row.studyMinutes }}</template></el-table-column>
            <el-table-column label="最高分" width="90" align="center"><template #default="{row}">{{ row.bestExamScore }}</template></el-table-column>
            <el-table-column label="竞赛分" width="90" align="center"><template #default="{row}">{{ row.contestScore }}</template></el-table-column>
            <el-table-column label="积分" width="100" align="center"><template #default="{row}"><b>{{ row.totalPoints }}</b></template></el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 新增资源 -->
    <el-dialog v-model="resVisible" title="新增培训资源" width="620px" :close-on-click-modal="false">
      <el-form label-width="110px" :model="resForm">
        <el-form-item label="标题" required><el-input v-model="resForm.title" /></el-form-item>
        <el-form-item label="摘要"><el-input v-model="resForm.summary" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="类别" required><el-select v-model="resForm.category" style="width:200px"><el-option v-for="c in CATEGORY_OPTS" :key="c" :label="c" :value="c" /></el-select></el-form-item>
        <el-form-item label="来源" required><el-select v-model="resForm.source" style="width:240px"><el-option v-for="s in SOURCE_OPTS" :key="s.value" :label="s.label" :value="s.value" /></el-select></el-form-item>
        <el-form-item label="链接/URL" required><el-input v-model="resForm.sourceUrl" placeholder="政府权威源外链或内部课件云端URL" /></el-form-item>
        <el-form-item label="预估时长(分)"><el-input-number v-model="resForm.durationMin" :min="1" :max="600" /></el-form-item>
        <el-form-item label="三级教育"><el-input v-model="resForm.requiredLevel" placeholder="厂级/车间级/班组级（可空）" /></el-form-item>
        <el-form-item label="标签"><el-input v-model="resForm.tags" placeholder="逗号分隔，如：必修,焊工" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitRes">保存</el-button>
      </template>
    </el-dialog>
  </div>
  `,
  setup() {
    const tab = ref('res');
    const kw = ref('');
    const filterCat = ref('all');
    const resources = ref([]);
    const loadingRes = ref(false);
    const loadingRec = ref(false);
    const resVisible = ref(false);
    const saving = ref(false);
    const resForm = reactive({ title: '', summary: '', category: '政策法规', source: '网络自动搜集', sourceUrl: '', durationMin: 15, requiredLevel: '', tags: '' });
    const records = ref([]);

    const me = computed(() => store.user || {});
    const canManage = computed(() => isAdmin(me.value) || isSafetyEnvStaff(me.value));
    const examPass = EXAM_PASS;
    const annualRequired = computed(() => HOURS_RULES[0].annual); // 高危年度再培训学时
    const hoursBasisText = computed(() => HOURS_RULES.map((r) => r.role + '：年再训≥' + r.annual + '学时（' + r.basis + '）').join('；'));

    // 学习时长：按人聚合学习分钟（type=学习）
    const studyStats = computed(() => {
      const map = {};
      (records.value || []).forEach((r) => {
        if (r.type !== '学习') return;
        const k = r.personId || r.personName;
        if (!map[k]) map[k] = { personId: k, personName: r.personName, deptCode: r.deptCode, studyMinutes: 0 };
        map[k].studyMinutes += Number(r.minutes) || 0;
      });
      return Object.values(map).map((s) => {
        const need = annualRequired.value * 60;
        return Object.assign({}, s, { rate: need ? Math.min(100, Math.round(s.studyMinutes / need * 100)) : 0 });
      }).sort((a, b) => b.studyMinutes - a.studyMinutes);
    });
    // 测试成绩
    const examRows = computed(() => (records.value || [])
      .filter((r) => r.type === '考试')
      .map((r) => Object.assign({}, r, { passed: Number(r.score) >= examPass }))
      .sort((a, b) => fmtDate(b.at).localeCompare(fmtDate(a.at))));
    // 竞赛排名：积分 = 学习分钟 + 最高合格考试成绩 + 竞赛得分
    const ranking = computed(() => {
      const map = {};
      (records.value || []).forEach((r) => {
        const k = r.personId || r.personName;
        if (!map[k]) map[k] = { personId: k, personName: r.personName, deptCode: r.deptCode, studyMinutes: 0, bestExamScore: 0, contestScore: 0 };
        const m = map[k];
        if (r.type === '学习') m.studyMinutes += Number(r.minutes) || 0;
        if (r.type === '考试' && Number(r.score) >= examPass) m.bestExamScore = Math.max(m.bestExamScore, Number(r.score));
        if (r.type === '竞赛') m.contestScore += Number(r.score) || Number(r.points) || 0;
      });
      return Object.values(map).map((m) => Object.assign({}, m, { totalPoints: m.studyMinutes + m.bestExamScore + m.contestScore }))
        .sort((a, b) => b.totalPoints - a.totalPoints);
    });

    async function loadRes() {
      loadingRes.value = true;
      try {
        const r = await api.trainingResources({ keyword: kw.value, category: filterCat.value, page: 1, size: 0 });
        resources.value = r.list || [];
      } catch (e) { ElMessage.error(e.message || '加载失败'); }
      finally { loadingRes.value = false; }
    }
    async function loadRec() {
      loadingRec.value = true;
      try {
        const r = await api.trainingRecords({ page: 1, size: 0 });
        records.value = r.list || [];
      } catch (e) { ElMessage.error(e.message || '加载失败'); }
      finally { loadingRec.value = false; }
    }
    function openRes(row) {
      const url = row.sourceUrl;
      if (!url) { ElMessage.warning('该资源暂无链接'); return; }
      if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url);
      else window.open(url, '_blank');
    }
    async function removeRes(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除该培训资源？', '删除', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
      } catch (e) { return; }
      try {
        await api.updateTrainingResource(row._id || row.id, { isDeleted: true });
        ElMessage.success('已删除');
        loadRes();
      } catch (e) { ElMessage.error(e.message || '删除失败'); }
    }
    function openCreateRes() {
      Object.assign(resForm, { title: '', summary: '', category: '政策法规', source: '网络自动搜集', sourceUrl: '', durationMin: 15, requiredLevel: '', tags: '' });
      resVisible.value = true;
    }
    async function submitRes() {
      if (!resForm.title || !resForm.sourceUrl) { ElMessage.warning('请填写标题与链接'); return; }
      saving.value = true;
      try {
        const now = new Date().toISOString();
        const payload = {
          title: resForm.title, summary: resForm.summary, category: resForm.category, source: resForm.source,
          sourceUrl: resForm.sourceUrl, durationMin: Number(resForm.durationMin) || 15,
          tags: String(resForm.tags || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          requiredLevel: resForm.requiredLevel, status: 'online',
          createdAt: now, updatedAt: now
        };
        await api.createTrainingResource(payload);
        resVisible.value = false;
        ElMessage.success('资源已新增');
        loadRes();
      } catch (e) { ElMessage.error(e.message || '保存失败'); }
      finally { saving.value = false; }
    }

    onMounted(() => { loadRes(); loadRec(); });

    return {
      CATEGORY_OPTS, SOURCE_OPTS, tab, kw, filterCat, resources, loadingRes, loadingRec, resVisible, saving, resForm,
      me, canManage, examPass, annualRequired, hoursBasisText, studyStats, examRows, ranking,
      fmtDate, loadRes, openRes, removeRes, openCreateRes, submitRes,
      Search, Plus, Delete, Link
    };
  }
};
