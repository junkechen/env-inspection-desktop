import { api } from '../api.js';
import { store } from '../store.js';
import { isAdmin, isSafetyEnvStaff } from '../permission.js';
import {
  QUESTION_TYPES, QUESTION_LEVELS, QUESTION_CATEGORIES, QUESTION_STATUS, PASS_LINE,
  seedQuestions, mergeQuestions, drawPaper, gradePaper, answerText
} from '../question_bank.js';

// 安全教育培训（电脑端）
// 集合 training_resources / training_records 与移动端（env_inspection_v370/lib/models/training.dart）同源共享，
// 数据天然一致、实时同步。
//
// 轻量化原则（对齐设计文档）：培训资源仅存元数据 + 外链（政府权威源）/ 云端 URL（内部课件），
// 媒体不落地本地；电脑端以「外链浏览器打开 + 学习时长记录」呈现。
// 合规依据：3号令（金属冶炼高危：初训≥48·年再训≥16；新上岗≥72·年再训≥20；一般≥24/12）、§22 如实记录、§25 合格方可上岗、30号令（特种证6年·每3年复审）。

const { ref, reactive, computed, onMounted, onBeforeUnmount } = Vue;

const CATEGORY_OPTS = ['政策法规', '事故警示', '高危作业', '应急处置', '职业危害', '综合管理'];
// 增加「音频」：与移动端 TrainingMedia.audio 对齐，供 URL 自动识别回填使用（纯新增）
const MEDIA_OPTS = ['文本', '视频', '音频', 'PPT课件', '图文', '文档', '课程'];

// 权威培训资源源索引（v1.0.35 新增，对齐移动端 source_fetcher.dart / resource_discovery.dart）。
// 名称复用 ../cloudfunction_security/discover_training_resources.mjs 的 TRUSTED_SOURCES，
// 但只取真实站点根域、不照抄栏目/深链结构；纯前端内置，不新增云函数依赖。
const TRUSTED_SOURCES = [
  { name: '应急管理部', url: 'https://www.mem.gov.cn/', note: '国家级 · 事故警示/法规/课件' },
  { name: '国家消防救援局', url: 'https://www.119.gov.cn/', note: '国家级 · 消防宣传视频' },
  { name: '国家矿山安全监察局', url: 'https://www.chinamine-safety.gov.cn/', note: '国家级 · 矿山安全' },
  { name: '中国应急信息网', url: 'http://www.emerinfo.cn/', note: '国家级 · 应急科普' },
  { name: '中国安全生产协会', url: 'https://www.china-safety.org.cn/', note: '行业协会 · 课件/标准' },
  { name: '中国消防协会', url: 'https://www.cfsa.org.cn/', note: '行业协会 · 消防科普' },
  { name: '中国职业安全健康协会', url: 'https://www.cosha.org.cn/', note: '行业协会 · 职业健康' },
  { name: '中国化学品安全协会', url: 'https://www.chemicalsafety.org.cn/', note: '行业协会 · 危化安全' },
  { name: '中国安全生产网', url: 'https://www.aqsc.org/', note: '安全媒体 · 警示案例' },
  { name: '广东省应急管理厅', url: 'http://yjgl.gd.gov.cn/', note: '地方厅局 · 广东' },
  { name: '江苏省应急管理厅', url: 'http://yjt.jiangsu.gov.cn/', note: '地方厅局 · 江苏' },
  { name: '浙江省应急管理厅', url: 'http://yjt.zj.gov.cn/', note: '地方厅局 · 浙江' },
  { name: '北京市应急管理局', url: 'https://yjglj.beijing.gov.cn/', note: '地方厅局 · 北京' },
  { name: '上海市应急管理局', url: 'https://yjglj.sh.gov.cn/', note: '地方厅局 · 上海' },
  { name: '科普中国', url: 'https://cloud.kepuchina.cn/', note: '科普平台 · 安全应急视频' }
];

// 按 URL 扩展名推断媒体类型（source_fetcher.dart 的 guessFromUrl 等价实现）。
// 网页类 URL 无扩展名 → 归为「文本」，与移动端 article 口径一致。
function guessMediaFromUrl(url) {
  const u = String(url || '').toLowerCase().split('?')[0].split('#')[0];
  const has = (exts) => exts.some((e) => u.endsWith(e));
  if (has(['.mp4', '.m3u8', '.webm', '.mov', '.mkv', '.flv'])) return '视频';
  if (has(['.mp3', '.m4a', '.wav', '.aac', '.ogg'])) return '音频';
  if (u.endsWith('.ppt') || u.endsWith('.pptx')) return 'PPT课件';
  if (u.endsWith('.pdf') || u.endsWith('.doc') || u.endsWith('.docx')) return '文档';
  if (has(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])) return '图文';
  return '文本';
}
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}
function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return ''; }
}
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
          <el-select v-model="filterMedia" placeholder="形式" clearable style="width:120px">
            <el-option v-for="m in MEDIA_OPTS" :key="m" :label="m" :value="m" />
            <el-option label="全部形式" value="all" />
          </el-select>
          <el-button type="primary" :icon="Search" @click="loadRes">查询</el-button>
          <el-button :icon="Refresh" :loading="loadingRes" @click="loadRes">刷新</el-button>
          <span class="spacer"></span>
          <el-button v-if="canManage" :icon="Search" @click="openSource">搜索源</el-button>
          <el-button v-if="canManage" type="success" :icon="Plus" @click="openCreateRes">新增资源</el-button>
        </div>
        <div class="card" style="min-width:0">
          <el-table :data="viewResources" v-loading="loadingRes" stripe>
            <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
            <el-table-column prop="category" label="类别" width="110" />
            <el-table-column prop="mediaType" label="形式" width="90" />
            <el-table-column prop="source" label="来源" width="130" />
            <el-table-column label="时长" width="80" align="center"><template #default="{row}">{{ row.durationMin || 0 }}分</template></el-table-column>
            <el-table-column prop="requiredLevel" label="三级教育" width="110" />
            <el-table-column label="状态" width="80" align="center"><template #default="{row}"><el-tag :type="row.status==='online'?'success':'info'" size="small">{{ row.status==='online'?'在线':'下线' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="300" fixed="right">
              <template #default="{row}">
                <el-button text type="success" :icon="VideoPlay" @click="openStudy(row)">开始学习</el-button>
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

      <!-- 题库练习（对齐移动端在线测试：抽题 → 作答 → 判分 → 写入培训档案） -->
      <el-tab-pane label="题库练习" name="quiz">
        <div class="toolbar">
          <el-button type="primary" :icon="EditPen" @click="startQuiz" :loading="quizStarting">
            {{ quizPaper.length ? '重新抽题' : '开始练习（15 题）' }}
          </el-button>
          <span class="hint">合格线 {{ examPass }} 分（《安全生产法》§25 考核合格方可上岗）· 可用题目 {{ enabledQuestions.length }} 道</span>
        </div>
        <div v-if="quizPaper.length">
          <div class="card quiz-card" v-for="(q,i) in quizPaper" :key="q.id">
            <div class="quiz-head">
              <b>{{ i + 1 }}. {{ q.stem }}</b>
              <span class="quiz-tag">{{ q.type }} · {{ q.category }} · {{ q.level }}</span>
            </div>
            <el-radio-group v-if="q.type !== '多选'" v-model="q._answer" :disabled="quizGraded">
              <el-radio v-for="(o,idx) in q.options" :key="idx" :label="idx" style="display:block;margin:6px 0">
                {{ String.fromCharCode(65 + idx) }}. {{ o }}
              </el-radio>
            </el-radio-group>
            <el-checkbox-group v-else v-model="q._answer" :disabled="quizGraded">
              <el-checkbox v-for="(o,idx) in q.options" :key="idx" :label="idx" style="display:block;margin:6px 0">
                {{ String.fromCharCode(65 + idx) }}. {{ o }}
              </el-checkbox>
            </el-checkbox-group>
            <div v-if="quizGraded" class="quiz-explain" :class="q._ok ? 'ok' : 'bad'">
              {{ q._ok ? '✔ 正确' : '✘ 错误' }} · 正确答案：{{ answerText(q) }}
              <span style="color:var(--c-text-soft)">　依据：{{ q.explain || '—' }}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
            <el-button v-if="!quizGraded" type="success" :loading="quizSubmitting" @click="submitQuiz">提交判分</el-button>
            <el-button v-else @click="startQuiz">再练一次</el-button>
            <span v-if="quizGraded" :style="{ color: quizResult.score >= examPass ? '#34d399' : '#f87171', fontWeight: 600 }">
              得分 {{ quizResult.score }} 分（答对 {{ quizResult.right }}/{{ quizResult.total }}）· {{ quizResult.score >= examPass ? '合格' : '不合格' }}
            </span>
          </div>
        </div>
        <div v-else class="hint" style="padding:36px 0;text-align:center">点击「开始练习」抽题；优先使用安环部已启用的云端题目，未配置时自动回退内置法规题库。</div>
      </el-tab-pane>

      <!-- 题库管理（安环部确认 + 软件自动检索待确认更新） -->
      <el-tab-pane v-if="canManage" label="题库管理" name="bank">
        <div class="toolbar">
          <el-select v-model="bankFilter" placeholder="状态" style="width:130px" @change="loadQuestions">
            <el-option label="全部" value="all" />
            <el-option label="待确认" value="pending" />
            <el-option label="已启用" value="enabled" />
            <el-option label="已停用" value="disabled" />
          </el-select>
          <el-input v-model="bankKw" placeholder="题干 / 依据" clearable style="width:220px" @keyup.enter="loadQuestions" />
          <el-button type="primary" :icon="Search" @click="loadQuestions">查询</el-button>
          <el-button :icon="Refresh" :loading="bankLoading" @click="loadQuestions">刷新</el-button>
          <span class="spacer"></span>
          <el-button type="success" :icon="Plus" :loading="qDetecting" @click="detectQuestionUpdates">检索待确认更新</el-button>
          <el-button type="primary" :icon="Plus" @click="openQuestionForm">录入题目</el-button>
        </div>
        <div class="qb-stats">
          <div class="qb-stat"><div>题目总数</div><b>{{ questions.length }}</b></div>
          <div class="qb-stat"><div>待确认</div><b style="color:#f59e0b">{{ pendingCount }}</b></div>
          <div class="qb-stat"><div>已启用</div><b style="color:#34d399">{{ enabledQuestions.length }}</b></div>
          <div class="qb-stat"><div>已停用</div><b style="color:#94a3b8">{{ disabledCount }}</b></div>
        </div>
        <div class="card" style="min-width:0">
          <div class="table-wrap">
          <el-table :data="viewQuestions" v-loading="bankLoading" stripe size="small" style="min-width:910px">
            <el-table-column label="题干" width="250">
              <template #default="{row}"><span :title="row.stem">{{ row.stem }}</span></template>
            </el-table-column>
            <el-table-column prop="type" label="题型" width="72" />
            <el-table-column prop="category" label="分类" width="90" />
            <el-table-column prop="level" label="难度" width="72" />
            <el-table-column label="状态" width="86">
              <template #default="{row}">
                <el-tag :type="row.status === 'enabled' ? 'success' : (row.status === 'pending' ? 'warning' : 'info')" size="small">
                  {{ questionStatusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sourceRef" label="法规依据" width="180" show-overflow-tooltip />
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{row}">
                <el-button v-if="row.status === 'pending'" text type="success" @click="setQuestionStatus(row, 'enabled')">采纳</el-button>
                <el-button v-if="row.status === 'pending'" text type="info" @click="setQuestionStatus(row, 'disabled')">忽略</el-button>
                <el-button v-if="row.status === 'enabled'" text type="warning" @click="setQuestionStatus(row, 'disabled')">停用</el-button>
                <el-button v-if="row.status === 'disabled'" text type="primary" @click="setQuestionStatus(row, 'enabled')">启用</el-button>
                <el-button text type="primary" @click="openQuestionForm(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
          </div>
        </div>
        <div class="hint" style="margin-top:8px">
          题库三态由安环部确认后生效；软件仅按 id 补缺生成「待确认」题目，绝不覆盖或删除已确认题目（《安全生产法》§25 责任清晰、迎检可举证）。
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 题库录入 / 编辑 -->
    <el-dialog v-model="qFormVisible" :title="qForm.cloudId ? '编辑题目' : '录入题目'" width="680px" :close-on-click-modal="false">
      <el-form :model="qForm" label-width="90px">
        <el-form-item label="题型">
          <el-select v-model="qForm.type" style="width:140px" @change="onQTypeChange">
            <el-option v-for="t in Q_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="题干" required><el-input v-model="qForm.stem" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="选项" required>
          <div style="width:100%">
            <div v-for="(o,i) in qForm.options" :key="i" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <el-tag size="small" effect="plain">{{ String.fromCharCode(65 + i) }}</el-tag>
              <el-input v-model="qForm.options[i]" />
              <el-button v-if="qForm.type !== '判断'" text type="danger" :icon="Delete" @click="removeQOption(i)">删</el-button>
            </div>
            <el-button v-if="qForm.type !== '判断'" size="small" :icon="Plus" @click="addQOption">添加选项</el-button>
          </div>
        </el-form-item>
        <el-form-item label="正确答案" required>
          <el-select v-model="qForm.answer" multiple :multiple-limit="qForm.type === '多选' ? 4 : 1" style="width:100%" placeholder="选择正确选项（多选可多选）">
            <el-option v-for="(o,i) in qForm.options" :key="i" :label="String.fromCharCode(65 + i) + '. ' + o" :value="i" />
          </el-select>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="qForm.category" style="width:160px"><el-option v-for="c in Q_CATS" :key="c" :label="c" :value="c" /></el-select>
        </el-form-item>
        <el-form-item label="难度">
          <el-select v-model="qForm.level" style="width:140px"><el-option v-for="l in Q_LEVELS" :key="l" :label="l" :value="l" /></el-select>
        </el-form-item>
        <el-form-item label="法规依据" required><el-input v-model="qForm.explain" placeholder="解析 + 法规条款，如《安全生产法》第二十五条" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="qFormVisible=false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveQuestion">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增资源 -->
    <el-dialog v-model="resVisible" title="新增培训资源" width="620px" :close-on-click-modal="false">
      <el-form label-width="110px" :model="resForm">
        <el-form-item label="标题" required><el-input v-model="resForm.title" /></el-form-item>
        <el-form-item label="摘要"><el-input v-model="resForm.summary" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="类别" required><el-select v-model="resForm.category" style="width:200px"><el-option v-for="c in CATEGORY_OPTS" :key="c" :label="c" :value="c" /></el-select></el-form-item>
        <el-form-item label="来源" required><el-select v-model="resForm.source" style="width:240px"><el-option v-for="s in SOURCE_OPTS" :key="s.value" :label="s.label" :value="s.value" /></el-select></el-form-item>
        <el-form-item label="形式" required><el-select v-model="resForm.mediaType" style="width:160px"><el-option v-for="m in MEDIA_OPTS" :key="m" :label="m" :value="m" /></el-select></el-form-item>
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

    <!-- 搜索并添加视频源（权威源索引 + 任意 URL 自动识别） -->
    <el-dialog v-model="sourceVisible" title="搜索并添加视频源" width="720px" top="6vh" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" style="margin-bottom:10px"
        title="权威源索引（政府 / 协会 / 媒体站点）· 点选即回填 URL 与标题；也可粘贴任意链接自动识别" />
      <el-input v-model="sourceKw" placeholder="按站点名 / 域名 / 说明过滤" clearable style="margin-bottom:8px" />
      <div class="card" style="max-height:240px;overflow:auto;padding:2px 4px">
        <div v-if="!filteredSources.length" style="color:var(--c-text-soft);font-size:13px;padding:10px">无匹配源</div>
        <div v-for="s in filteredSources" :key="s.url" @click="pickSource(s)"
          style="padding:8px 10px;border-bottom:1px solid var(--c-border);cursor:pointer">
          <div style="font-weight:600">{{ s.name }}</div>
          <div style="font-size:12px;color:var(--c-text-soft)">{{ s.url }} · {{ s.note }}</div>
        </div>
      </div>
      <el-divider>或粘贴任意 URL 自动识别</el-divider>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <el-input v-model="detectUrl" placeholder="https://… 视频 / 音频 / 课件 / 文档链接" clearable style="flex:1;min-width:300px" @keyup.enter="autoDetect" />
        <el-button type="primary" :loading="detecting" @click="autoDetect">自动识别</el-button>
      </div>
      <div style="font-size:12px;color:var(--c-text-soft);margin-top:8px;line-height:1.6">
        浏览器渲染进程受同源策略 / CORS 限制，多数政府站点不允许跨域读取网页 &lt;title&gt;；
        识别失败时自动降级为按 URL 扩展名推断媒体类型（mp4 / mp3 / ppt / pdf / 图片），标题可手动修改。
      </div>
      <template #footer>
        <el-button @click="sourceVisible=false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 应用内学习（iframe 内嵌 + 秒级前台计时） -->
    <el-dialog v-model="studyVisible" :title="'应用内学习 · ' + (studyRow ? studyRow.title : '')"
      width="980px" top="4vh" :close-on-click-modal="false" :before-close="beforeStudyClose">
      <div @click="markStudyInteraction">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <el-tag type="success" effect="dark" size="large">已学习 {{ studyTimeText }}</el-tag>
          <el-button v-if="!studyRunning" type="success" :icon="VideoPlay" @click="startStudy">{{ studySeconds ? '继续' : '开始' }}</el-button>
          <el-button v-else type="warning" :icon="VideoPause" @click="pauseStudy('已手动暂停')">暂停</el-button>
          <el-button type="primary" :icon="Timer" @click="endStudy">结束并记录</el-button>
          <el-button :icon="Link" @click="openStudyExternal">用系统浏览器打开</el-button>
          <span v-if="studyPauseReason" style="color:#f8a978;font-size:12px">{{ studyPauseReason }}</span>
        </div>
        <el-alert type="warning" :closable="false" style="margin-bottom:10px"
          title="内嵌加载说明（降级提示）"
          description="部分政府 / 媒体站点通过 X-Frame-Options 或 CSP frame-ancestors 禁止被 iframe 内嵌；http 资源在 https 页面下也会被浏览器拦截。若下方内容空白，请点「用系统浏览器打开」继续学习，计时仍在本窗口进行。" />
        <div style="border:1px solid var(--c-border);border-radius:6px;overflow:hidden;background:#fff">
          <iframe v-if="studyVisible" :src="studyUrl" style="width:100%;height:56vh;border:0" referrerpolicy="no-referrer"></iframe>
        </div>
        <div style="font-size:12px;color:var(--c-text-soft);margin-top:8px;line-height:1.6">
          计时规则：秒级累计前台真实学习时长；切出页面（visibilitychange / 窗口失焦）或 5 分钟无操作自动暂停；单次上限 120 分钟。
        </div>
      </div>
    </el-dialog>
  </div>
  `,
  setup() {
    // 与其余视图一致：从 ElementPlus 取 ElMessage（原文件裸用 ElMessage 未解构，
    // 在渲染进程里会 ReferenceError，这里补齐，纯新增修复）。
    const { ElMessage, ElMessageBox } = (typeof ElementPlus !== 'undefined' ? ElementPlus : {});
    const { Search, Plus, Delete, Link, Refresh, VideoPlay, VideoPause, Timer, EditPen } =
      (typeof ElementPlusIconsVue !== 'undefined' ? ElementPlusIconsVue : {});

    const tab = ref('res');
    const kw = ref('');
    const filterCat = ref('all');
    const filterMedia = ref('all');
    const resources = ref([]);
    const loadingRes = ref(false);
    const loadingRec = ref(false);
    const resVisible = ref(false);
    const saving = ref(false);
    const resForm = reactive({ title: '', summary: '', category: '政策法规', source: '网络自动搜集', mediaType: '文本', sourceUrl: '', durationMin: 15, requiredLevel: '', tags: '' });

    // ---------- 搜索源 ----------
    const sourceVisible = ref(false);
    const sourceKw = ref('');
    const detectUrl = ref('');
    const detecting = ref(false);
    const filteredSources = computed(() => {
      const k = sourceKw.value.trim().toLowerCase();
      const base = TRUSTED_SOURCES;
      const hit = k ? base.filter((s) => (s.name + ' ' + s.url + ' ' + s.note).toLowerCase().indexOf(k) >= 0) : base;
      return hit.slice(0, 20);
    });

    // ---------- 应用内学习计时 ----------
    const studyVisible = ref(false);
    const studyRow = ref(null);
    const studyUrl = ref('');
    const studySeconds = ref(0);
    const studyRunning = ref(false);
    const studyPauseReason = ref('');
    let studyTicker = null;            // setInterval 句柄（非响应式）
    let studyLastInteraction = 0;
    let studyRecorded = false;         // 防止「结束并记录」与弹窗关闭重复落库
    const STUDY_IDLE_MS = 5 * 60 * 1000;
    const STUDY_MAX_SEC = 120 * 60;    // 单次上限 120 分钟（与移动端一致，防挂机虚报）
    const studyTimeText = computed(() => {
      const s = studySeconds.value;
      const p = (n) => String(n).padStart(2, '0');
      return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
    });

    // 资源展示：服务端已按 关键词/类别 过滤，此处再按 媒体形式 客户端过滤
    const viewResources = computed(() => (resources.value || []).filter((r) => {
      if (filterMedia.value === 'all') return true;
      return (r.mediaType || '文本') === filterMedia.value;
    }));
    const records = ref([]);

    // ---------- 题库（training_questions，与手机端共用） ----------
    const Q_TYPES = QUESTION_TYPES;
    const Q_LEVELS = QUESTION_LEVELS;
    const Q_CATS = QUESTION_CATEGORIES;
    const bankFilter = ref('all');
    const bankKw = ref('');
    const bankLoading = ref(false);
    const cloudQuestions = ref([]);
    const qDetecting = ref(false);

    // 内置种子题与云端题目合并：云端同 id 覆盖种子（安环部确认结果优先）
    const questions = computed(() => mergeQuestions(cloudQuestions.value));
    const enabledQuestions = computed(() => questions.value.filter((q) => q.status === 'enabled'));
    const pendingCount = computed(() => questions.value.filter((q) => q.status === 'pending').length);
    const disabledCount = computed(() => questions.value.filter((q) => q.status === 'disabled').length);
    const viewQuestions = computed(() => {
      const k = bankKw.value.trim();
      return questions.value.filter((q) => {
        if (bankFilter.value !== 'all' && (q.status || 'pending') !== bankFilter.value) return false;
        if (k && (String(q.stem || '') + String(q.explain || '') + String(q.sourceRef || '')).indexOf(k) < 0) return false;
        return true;
      });
    });
    function questionStatusText(s) { return QUESTION_STATUS[s] || s || '—'; }

    async function loadQuestions() {
      bankLoading.value = true;
      try {
        const r = await api.trainingQuestions({ status: bankFilter.value, keyword: bankKw.value, page: 1, size: 0 });
        cloudQuestions.value = r.list || [];
      } catch (e) {
        // 集合尚未创建 / 网关异常：静默回退内置题库，不阻塞学习功能
        cloudQuestions.value = [];
      } finally {
        bankLoading.value = false;
      }
    }

    // ---------- 在线练习 ----------
    const quizPaper = ref([]);
    const quizGraded = ref(false);
    const quizStarting = ref(false);
    const quizSubmitting = ref(false);
    const quizResult = reactive({ score: 0, right: 0, total: 0 });

    function startQuiz() {
      quizStarting.value = true;
      try {
        const pool = enabledQuestions.value.length ? enabledQuestions.value : questions.value;
        quizPaper.value = drawPaper(pool, 15);
        quizGraded.value = false;
        quizResult.score = 0; quizResult.right = 0; quizResult.total = quizPaper.value.length;
      } finally {
        quizStarting.value = false;
      }
    }
    async function submitQuiz() {
      const unanswered = quizPaper.value.filter((q) => {
        const a = q._answer;
        return a == null || (Array.isArray(a) && a.length === 0);
      }).length;
      if (unanswered) {
        try {
          await ElMessageBox.confirm('还有 ' + unanswered + ' 题未作答，确定提交？', '提交判分', { type: 'warning' });
        } catch (e) { return; }
      }
      const g = gradePaper(quizPaper.value);
      quizResult.score = g.score; quizResult.right = g.right; quizResult.total = g.total;
      quizGraded.value = true;
      quizSubmitting.value = true;
      try {
        const u = me.value || {};
        const now = new Date().toISOString();
        const uid = u._id || u.id || u.username || '';
        const uname = u.name || u.username || '';
        // 同一份记录同时满足手机端 TrainingRecord 与电脑端 training_records 统计口径
        await api.createTrainingRecord({
          id: 'tr_' + Date.now(),
          type: '考试',
          userId: uid, userName: uname,
          personId: uid, personName: uname, deptCode: u.department || '',
          content: '安全知识练习（' + g.total + ' 题）',
          resourceId: '', resourceTitle: '',
          minutes: 0, seconds: 0, mode: 'auto',
          score: g.score,
          passed: g.score >= examPass,
          points: g.score >= examPass ? g.score : 0,
          paperSnapshot: quizPaper.value.map((q) => ({ id: q.id, answer: q._answer })),
          date: now, at: now
        });
        loadRec();
        ElMessage[g.score >= examPass ? 'success' : 'warning'](
          g.score >= examPass ? ('得分 ' + g.score + '，合格，已记入培训档案') : ('得分 ' + g.score + '，未达合格线 ' + examPass + ' 分')
        );
      } catch (e) {
        ElMessage.error('成绩保存失败：' + (e && e.message ? e.message : e));
      } finally {
        quizSubmitting.value = false;
      }
    }

    // ---------- 题库维护（安环部） ----------
    async function setQuestionStatus(row, status) {
      const now = new Date().toISOString();
      const patch = {
        status, confirmedBy: (me.value.name || me.value.username || ''),
        confirmedAt: now, updatedAt: now
      };
      try {
        if (row.cloudId) {
          await api.updateTrainingQuestion(row.cloudId, patch);
        } else {
          // 内置种子题无云端文档：写一条同 id 的覆盖文档，使确认结果在双端生效
          await api.createTrainingQuestion(Object.assign({}, row, patch, { id: row.id, createdAt: now }));
        }
        await loadQuestions();
        ElMessage.success(status === 'enabled' ? '已采纳启用' : (status === 'disabled' ? '已停用/忽略' : '已更新'));
      } catch (e) {
        ElMessage.error('操作失败：' + (e && e.message ? e.message : e));
      }
    }
    async function detectQuestionUpdates() {
      qDetecting.value = true;
      try {
        const exist = new Set((cloudQuestions.value || []).map((q) => String(q.id || q._id)));
        const fresh = seedQuestions().filter((q) => !exist.has(String(q.id)));
        let added = 0;
        for (const q of fresh) {
          try {
            await api.createTrainingQuestion(Object.assign({}, q, {
              status: 'pending', confirmedBy: '', confirmedAt: null,
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
            }));
            added++;
          } catch (e) { /* 单条失败不影响其余 */ }
        }
        await loadQuestions();
        ElMessage.success(added ? ('已生成 ' + added + ' 条待确认题目，请逐条采纳') : '暂未发现新的待确认题目');
      } catch (e) {
        ElMessage.error('检索失败：' + (e && e.message ? e.message : e));
      } finally {
        qDetecting.value = false;
      }
    }

    const qFormVisible = ref(false);
    function emptyQForm() {
      return { cloudId: '', id: '', type: '单选', stem: '', options: ['', '', '', ''], answer: [], category: '通用', level: '基础', explain: '' };
    }
    const qForm = reactive(emptyQForm());
    function openQuestionForm(row) {
      if (row) {
        Object.assign(qForm, {
          cloudId: row.cloudId || '', id: row.id || '', type: row.type || '单选', stem: row.stem || '',
          options: (row.options || []).slice(), answer: (row.answer || []).slice(),
          category: row.category || '通用', level: row.level || '基础', explain: row.explain || ''
        });
      } else {
        Object.assign(qForm, emptyQForm(), { id: 'q_' + Date.now() });
      }
      qFormVisible.value = true;
    }
    function onQTypeChange() {
      if (qForm.type === '判断') qForm.options = ['正确', '错误'];
      else if (qForm.options.length < 2) qForm.options = ['', '', '', ''];
      qForm.answer = [];
    }
    function addQOption() { qForm.options.push(''); }
    function removeQOption(i) {
      qForm.options.splice(i, 1);
      qForm.answer = qForm.answer.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
    }
    async function saveQuestion() {
      const opts = qForm.options.map((s) => String(s || '').trim()).filter(Boolean);
      if (!qForm.stem.trim()) { ElMessage.warning('请填写题干'); return; }
      if (opts.length < 2) { ElMessage.warning('请至少填写两个选项'); return; }
      if (!qForm.answer.length) { ElMessage.warning('请选择正确答案'); return; }
      if (!qForm.explain.trim()) { ElMessage.warning('请填写法规依据/解析'); return; }
      saving.value = true;
      try {
        const now = new Date().toISOString();
        const payload = {
          id: qForm.id, version: 1, type: qForm.type, stem: qForm.stem.trim(),
          options: opts, answer: qForm.answer.slice().sort(),
          explain: qForm.explain.trim(), category: qForm.category, level: qForm.level,
          jobTags: [], workshopTags: [], source: 'anbu', sourceRef: qForm.explain.trim(), sourceUrl: '',
          status: qForm.cloudId ? (questions.value.find((x) => x.id === qForm.id) || {}).status || 'pending' : 'pending',
          confirmedBy: qForm.cloudId ? (me.value.name || '') : '',
          confirmedAt: qForm.cloudId ? now : null,
          createdAt: now, updatedAt: now, stats: { answered: 0, errorRate: 0 }
        };
        if (qForm.cloudId) await api.updateTrainingQuestion(qForm.cloudId, payload);
        else await api.createTrainingQuestion(payload);
        qFormVisible.value = false;
        await loadQuestions();
        ElMessage.success(qForm.cloudId ? '题目已更新' : '已录入待确认，采纳后生效');
      } catch (e) {
        ElMessage.error('保存失败：' + (e && e.message ? e.message : e));
      } finally {
        saving.value = false;
      }
    }

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
      Object.assign(resForm, { title: '', summary: '', category: '政策法规', source: '网络自动搜集', mediaType: '文本', sourceUrl: '', durationMin: 15, requiredLevel: '', tags: '' });
      resVisible.value = true;
    }
    async function submitRes() {
      if (!resForm.title || !resForm.sourceUrl) { ElMessage.warning('请填写标题与链接'); return; }
      saving.value = true;
      try {
        const now = new Date().toISOString();
        const payload = {
          title: resForm.title, summary: resForm.summary, category: resForm.category, source: resForm.source,
          mediaType: resForm.mediaType,
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

    // ---------- 搜索源：权威源索引 + 任意 URL 自动识别 ----------
    function openSource() {
      sourceKw.value = '';
      detectUrl.value = '';
      sourceVisible.value = true;
    }
    // 点选权威源 → 回填 URL / 标题 / 来源，打开「新增资源」表单由用户确认保存
    function pickSource(s) {
      Object.assign(resForm, {
        title: s.name + ' · 安全培训资源',
        summary: '来源：' + s.name + '（' + s.note + '）',
        source: '网络自动搜集',
        mediaType: '视频',
        category: '综合管理',
        sourceUrl: s.url
      });
      sourceVisible.value = false;
      resVisible.value = true;
      ElMessage.info('已回填来源，请确认标题后保存');
    }
    // 粘贴任意 URL：尽力抓取 <title>，失败降级为按扩展名推断媒体类型（纯前端、无云函数依赖）
    async function autoDetect() {
      const url = detectUrl.value.trim();
      if (!/^https?:\/\//i.test(url)) { ElMessage.warning('请粘贴以 http(s):// 开头的完整链接'); return; }
      detecting.value = true;
      try {
        let title = '';
        let ctMedia = '';
        try {
          // 渲染进程同源策略 / CORS：政府站点大多不开放跨域读取，fetch 大概率失败。
          // 这里是 best-effort；失败（CORS / 超时 / 非 200）一律走下面的扩展名推断降级。
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 8000);
          try {
            const resp = await fetch(url, { method: 'GET', signal: ctrl.signal });
            if (resp && resp.ok) {
              const ct = (resp.headers && resp.headers.get ? resp.headers.get('content-type') : '') || '';
              const text = await resp.text();
              const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
              if (m) title = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
              const c = ct.toLowerCase();
              if (c.indexOf('video') >= 0) ctMedia = '视频';
              else if (c.indexOf('audio') >= 0) ctMedia = '音频';
              else if (c.indexOf('pdf') >= 0) ctMedia = '文档';
            }
          } finally { clearTimeout(to); }
        } catch (e) { /* CORS / 超时 / 网络错误：降级 */ }

        const inferred = guessMediaFromUrl(url);
        const media = ctMedia || inferred;
        const finalTitle = title || (hostOf(url) || '网络培训资源');
        if (!title) ElMessage.warning('受浏览器跨域限制未能读取网页标题，已按链接推断媒体类型，请确认标题');
        else ElMessage.success('已识别网页标题');
        Object.assign(resForm, {
          title: finalTitle,
          summary: '来源：' + (hostOf(url) || '外部链接'),
          source: '网络自动搜集',
          mediaType: media,
          sourceUrl: url
        });
        sourceVisible.value = false;
        resVisible.value = true;
      } finally { detecting.value = false; }
    }

    // ---------- 应用内学习计时 ----------
    function markStudyInteraction() { studyLastInteraction = Date.now(); }
    function startStudy() {
      if (studyTicker) return;
      studyRunning.value = true;
      studyPauseReason.value = '';
      studyLastInteraction = Date.now();
      studyTicker = setInterval(() => {
        if (!studyRunning.value) return;
        studySeconds.value += 1;
        if (Date.now() - studyLastInteraction > STUDY_IDLE_MS) pauseStudy('5 分钟无操作，计时已自动暂停');
      }, 1000);
    }
    function pauseStudy(reason) {
      if (studyTicker) { clearInterval(studyTicker); studyTicker = null; }
      studyRunning.value = false;
      if (reason) studyPauseReason.value = reason;
    }
    function openStudy(row) {
      const url = row.sourceUrl;
      if (!url) { ElMessage.warning('该资源暂无链接'); return; }
      studyRow.value = row;
      studyUrl.value = url;
      studySeconds.value = 0;
      studyRunning.value = false;
      studyPauseReason.value = '';
      studyRecorded = false;
      studyVisible.value = true;
      startStudy();
    }
    // 降级备选：站点禁止 iframe 内嵌 / http 资源被拦截时，用系统浏览器打开
    function openStudyExternal() { if (studyRow.value) openRes(studyRow.value); }

    // 写学习记录到 training_records：api.createTrainingRecord 内部即 rpc('add', { collection:'training_records', data })。
    // 字段同时满足：① 手机端 TrainingRecord（userId/userName/resourceId/resourceTitle/seconds/mode='auto'/date）；
    // ② 电脑端 studyStats 口径（type='学习'/personId/personName/deptCode/minutes/at）。
    async function saveStudyRecord() {
      const sec = Math.min(studySeconds.value, STUDY_MAX_SEC);
      if (sec <= 0) return false;
      const row = studyRow.value || {};
      const u = me.value || {};
      const now = new Date().toISOString();
      const minutes = Math.floor(sec / 60);
      const uid = u._id || u.id || u.username || '';
      const uname = u.name || u.username || '';
      const payload = {
        id: 'tr_' + Date.now(),
        type: '学习',
        userId: uid, userName: uname,
        resourceId: String(row._id || row.id || ''), resourceTitle: row.title || '',
        seconds: sec, mode: 'auto', date: now,
        personId: uid, personName: uname, deptCode: u.department || '',
        content: row.title || '', minutes, points: minutes, at: now,
        score: 0, passed: false
      };
      await api.createTrainingRecord(payload);
      loadRec();
      ElMessage.success('已记录学习 ' + sec + ' 秒');
      return true;
    }
    async function finishStudy() {
      pauseStudy('');
      if (!studyRecorded && studySeconds.value > 0) {
        studyRecorded = true;
        try { await saveStudyRecord(); }
        catch (e) { ElMessage.error('学习记录保存失败：' + (e && e.message ? e.message : e)); }
      }
    }
    async function endStudy() { await finishStudy(); studyVisible.value = false; }
    // 用户点 X / ESC 关闭时也要落库，避免已学时长丢失；studyRecorded 保证不重复写
    async function beforeStudyClose(done) {
      await finishStudy();
      if (typeof done === 'function') done();
    }
    function onVisibilityChange() {
      if (typeof document !== 'undefined' && document.hidden && studyRunning.value) {
        pauseStudy('切换出页面，计时已自动暂停');
      }
    }
    function onWindowBlur() {
      if (studyRunning.value) pauseStudy('窗口失焦，计时已自动暂停');
    }

    onMounted(() => {
      loadRes(); loadRec(); loadQuestions();
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibilityChange);
      if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('blur', onWindowBlur);
    });
    onBeforeUnmount(() => {
      if (studyTicker) { clearInterval(studyTicker); studyTicker = null; }
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibilityChange);
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('blur', onWindowBlur);
    });

    return {
      CATEGORY_OPTS, MEDIA_OPTS, SOURCE_OPTS, tab, kw, filterCat, filterMedia, resources, viewResources, loadingRes, loadingRec, resVisible, saving, resForm,
      me, canManage, examPass, annualRequired, hoursBasisText, studyStats, examRows, ranking,
      fmtDate, loadRes, openRes, removeRes, openCreateRes, submitRes,
      sourceVisible, sourceKw, filteredSources, detectUrl, detecting, openSource, pickSource, autoDetect,
      studyVisible, studyRow, studyUrl, studySeconds, studyTimeText, studyRunning, studyPauseReason,
      openStudy, startStudy, pauseStudy, endStudy, beforeStudyClose, openStudyExternal, markStudyInteraction,
      Q_TYPES, Q_LEVELS, Q_CATS, bankFilter, bankKw, bankLoading, viewQuestions, questions,
      enabledQuestions, pendingCount, disabledCount, questionStatusText, loadQuestions,
      quizPaper, quizGraded, quizStarting, quizSubmitting, quizResult, startQuiz, submitQuiz, answerText,
      qDetecting, detectQuestionUpdates, setQuestionStatus,
      qFormVisible, qForm, openQuestionForm, onQTypeChange, addQOption, removeQOption, saveQuestion,
      Search, Plus, Delete, Link, Refresh, VideoPlay, VideoPause, Timer, EditPen
    };
  }
};
