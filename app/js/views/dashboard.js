import { api, STATUS_MAP, SEVERITY_MAP, CATEGORY_MAP } from '../api.js';
import { store } from '../store.js';
import { navigate } from '../router.js';
import { isAdmin, filterIssuesByRole, filterMessagesByUser } from '../permission.js';
import { computeStats, businessOf } from '../stats_utils.js';
import { BUSINESS_OPTS, businessInfos, businessLabelOf } from '../business.js';
import { resolveIssuePhotos, resolveHtmlImages } from '../image_utils.js';
import { visibleAnnouncements, sanitizeHtml, matchTargetDept, CATEGORY_MAP as ANN_CATEGORY_MAP } from '../announcement.js';
import { currentDept } from '../dept.js';
import { onUpdate, cachedAt } from '../cache.js';
import { fetchLatest, promptAndUpdate, silentStartupCheck } from '../update.js';

const CARD_CFG = [
  { key: 'total', label: '隐患总数', icon: '📋', color: '#00e5a0', glow: 'rgba(0,229,160,.35)' },
  { key: 'pending', label: '待处理', icon: '⏳', color: '#f59e0b', glow: 'rgba(245,158,11,.35)' },
  { key: 'processing', label: '整改中', icon: '🔧', color: '#38bdf8', glow: 'rgba(56,189,248,.35)' },
  { key: 'reviewing', label: '待验收', icon: '🔍', color: '#a78bfa', glow: 'rgba(167,139,250,.35)' },
  { key: 'closed', label: '已关闭', icon: '✅', color: '#34d399', glow: 'rgba(52,211,153,.35)' },
  { key: 'overdue', label: '已逾期', icon: '⚠️', color: '#f87171', glow: 'rgba(248,113,113,.35)' }
];

const DEPT_COLORS = ['#00e5a0', '#38bdf8', '#f59e0b', '#a78bfa', '#f87171', '#34d399', '#60a5fa', '#fb923c'];
const STATUS_COLORS = { pending: '#f59e0b', processing: '#38bdf8', reviewing: '#a78bfa', closed: '#34d399', overdue: '#f87171' };

function fmtArrow(n) {
  const v = Number(n);
  if (v > 0) return { icon: '▲', color: '#f87171', text: `增长 ${v}%` };
  if (v < 0) return { icon: '▼', color: '#34d399', text: `下降 ${Math.abs(v)}%` };
  return { icon: '−', color: 'var(--c-text-soft)', text: '持平' };
}
function isRead(row) { return row.isRead === true || row.read === true || row.status === 'read'; }
function titleOf(row) { return row.title || row.subject || row.content || '催办通知'; }
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
    <!-- 标题 -->
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px">
      <div>
        <h2 class="page-title neon-title">数据概览</h2>
        <p class="page-sub">整体态势 · 趋势分析 · 车间排名 · 数据来自云端与移动端同源</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="color:var(--c-text-soft);font-size:12px">
          数据更新于 {{ dataUpdatedAt || '加载中…' }} · {{ nowText }}
        </div>
        <el-button size="small" :loading="checking" @click="manualCheck">检查更新</el-button>
      </div>
    </div>

    <!-- 预警条 -->
    <div v-if="s.alerts && s.alerts.length" style="margin-bottom:16px;display:flex;flex-direction:column;gap:10px">
      <div v-for="(a,i) in s.alerts" :key="i" class="card" :style="{ borderLeft:'4px solid '+(a.level==='danger'?'#f87171':a.level==='warning'?'#f59e0b':'#38bdf8'), padding:'12px 16px', display:'flex', alignItems:'center', gap:'10px' }">
        <span style="font-size:18px">{{ a.level==='danger'?'🚨':a.level==='warning'?'⚠️':'ℹ️' }}</span>
        <span style="color:#fff;font-weight:500">{{ a.text }}</span>
      </div>
    </div>

    <!-- 公告栏（置顶优先；普通用户只见已发布且未过期） -->
    <div class="card section" style="border-top:2px solid var(--c-accent);margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">📢 公告栏</h3>
        <el-button text type="primary" @click="navigate('/announcements')">查看全部</el-button>
      </div>
      <div v-if="!announcements.length" style="color:var(--c-text-soft);text-align:center;padding:18px 0">
        暂无公告
      </div>
      <div v-else class="ann-board">
        <div v-for="a in announcements" :key="a._id" class="ann-board-item" @click="openAnnouncement(a)">
          <span v-if="a.pinned" class="ann-pin-badge">置顶</span>
          <span v-if="!(annRead[a._id] && annRead[a._id].read)" class="ann-unread-dot" title="未读"></span>
          <span class="ann-board-title">{{ a.title || '(无标题)' }}</span>
          <span class="ann-board-cat">{{ ANN_CATEGORY_MAP[a.category] || '其他' }}</span>
          <span class="ann-board-time">{{ fmtDate(a.publishedAt || a.createdAt) }}</span>
        </div>
      </div>
    </div>

    <!-- 业务切换（归属多个业务的账号显示；单业务自动采用不显示） -->
    <div v-if="bizList.length > 1" class="card section" style="display:flex;align-items:center;gap:14px;padding:10px 16px;margin-bottom:16px">
      <span style="color:var(--c-text-soft);font-size:13px">业务范围</span>
      <el-radio-group v-model="filterBiz" size="small" @change="applyBiz">
        <el-radio-button v-for="b in bizList" :key="b.code" :label="b.code">{{ b.name }}</el-radio-button>
      </el-radio-group>
      <span style="color:var(--c-text-soft);font-size:12px">当前：{{ businessLabelOf(filterBiz) }}</span>
    </div>

    <!-- 顶部 6 张数据卡片 -->
    <div class="stat-grid">
      <div v-for="c in cards" :key="c.key" class="stat-card" :style="{ borderColor: c.glow.replace('.35','.25'), cursor:'pointer' }" @click="goToHazards(c.key)" title="点击查看对应问题">
        <div class="ic" :style="{ background: 'linear-gradient(135deg,'+c.glow.replace('.35','.15')+','+c.glow.replace('.35','.05')+'),'+c.color, color:'#fff', boxShadow:'0 0 18px '+c.glow }">{{ c.icon }}</div>
        <div>
          <div class="num" :style="{ color: c.color, textShadow:'0 0 18px '+c.glow }">{{ s.counts[c.key] }}</div>
          <div class="lbl">{{ c.label }}</div>
        </div>
      </div>
    </div>

    <!-- 周月对比卡片 -->
    <div class="card section" style="border-top:2px solid var(--c-primary)">
      <h3 style="margin:0 0 14px">周/月趋势对比</h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">
        <div class="card" style="background:rgba(15,23,42,.6);padding:14px">
          <div style="color:var(--c-text-soft);font-size:12px">本周新增</div>
          <div style="font-size:22px;font-weight:700;color:#fff;margin:4px 0">{{ s.comparison?.thisWeek?.created || 0 }}</div>
          <div style="font-size:12px;display:flex;align-items:center;gap:4px" :style="{color: fmtArrow(s.comparison?.mom).color}">
            <span>{{ fmtArrow(s.comparison?.mom).icon }}</span><span>{{ fmtArrow(s.comparison?.mom).text }}</span>
          </div>
        </div>
        <div class="card" style="background:rgba(15,23,42,.6);padding:14px">
          <div style="color:var(--c-text-soft);font-size:12px">上周新增</div>
          <div style="font-size:22px;font-weight:700;color:#fff;margin:4px 0">{{ s.comparison?.lastWeek?.created || 0 }}</div>
          <div style="font-size:12px;color:var(--c-text-soft)">环比基准</div>
        </div>
        <div class="card" style="background:rgba(15,23,42,.6);padding:14px">
          <div style="color:var(--c-text-soft);font-size:12px">本月新增</div>
          <div style="font-size:22px;font-weight:700;color:#fff;margin:4px 0">{{ s.comparison?.thisMonth?.created || 0 }}</div>
          <div style="font-size:12px;display:flex;align-items:center;gap:4px" :style="{color: fmtArrow(s.comparison?.yoy).color}">
            <span>{{ fmtArrow(s.comparison?.yoy).icon }}</span><span>{{ fmtArrow(s.comparison?.yoy).text }}</span>
          </div>
        </div>
        <div class="card" style="background:rgba(15,23,42,.6);padding:14px">
          <div style="color:var(--c-text-soft);font-size:12px">上月新增</div>
          <div style="font-size:22px;font-weight:700;color:#fff;margin:4px 0">{{ s.comparison?.lastMonth?.created || 0 }}</div>
          <div style="font-size:12px;color:var(--c-text-soft)">同比基准</div>
        </div>
      </div>
    </div>

    <!-- 趋势 + 等级分布 -->
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:18px;margin-bottom:18px">
      <div class="card" style="border-top:2px solid var(--c-primary)">
        <h3 style="margin:0 0 12px">近 30 天隐患趋势（新增 / 闭环）</h3>
        <div ref="trendEl" style="height:300px"></div>
      </div>
      <div class="card" style="border-top:2px solid var(--c-purple)">
        <h3 style="margin:0 0 12px">隐患等级分布</h3>
        <div ref="severityEl" style="height:300px"></div>
      </div>
    </div>

    <!-- 部门柱状 + 状态分布 -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px">
      <div class="card" style="border-top:2px solid var(--c-warning)">
        <h3 style="margin:0 0 12px">各部门隐患数量</h3>
        <div ref="barEl" style="height:280px"></div>
      </div>
      <div class="card" style="border-top:2px solid var(--c-success)">
        <h3 style="margin:0 0 12px">状态分布</h3>
        <div ref="pieEl" style="height:280px"></div>
      </div>
    </div>

    <!-- 车间问题数量排名（点击行查看详情） -->
    <div class="card section" style="border-top:2px solid var(--c-primary);margin-bottom:18px;min-width:0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">车间问题数量排名（点击行查看详情）</h3>
        <span style="color:var(--c-text-soft);font-size:12px">共 {{ s.byDepartmentDetail?.length || 0 }} 个车间/部门</span>
      </div>
      <div class="table-wrap">
        <el-table :data="s.byDepartmentDetail" stripe max-height="320" @row-click="openDept" style="cursor:pointer">
        <el-table-column label="排名" width="70">
          <template #default="{ $index }">
            <span :style="{ color: DEPT_COLORS[$index % DEPT_COLORS.length], fontWeight: 700 }">{{ $index + 1 }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="车间/部门" min-width="160" />
        <el-table-column label="总数" width="80">
          <template #default="{ row }"><span style="font-weight:700;color:#fff">{{ row.total }}</span></template>
        </el-table-column>
        <el-table-column label="待处理" width="80"><template #default="{ row }"><span style="color:#f59e0b">{{ row.pending }}</span></template></el-table-column>
        <el-table-column label="整改中" width="80"><template #default="{ row }"><span style="color:#38bdf8">{{ row.processing }}</span></template></el-table-column>
        <el-table-column label="待验收" width="80"><template #default="{ row }"><span style="color:#a78bfa">{{ row.reviewing }}</span></template></el-table-column>
        <el-table-column label="已关闭" width="80"><template #default="{ row }"><span style="color:#34d399">{{ row.closed }}</span></template></el-table-column>
        <el-table-column label="已逾期" width="80"><template #default="{ row }"><span style="color:#f87171">{{ row.overdue }}</span></template></el-table-column>
        <el-table-column label="占比" width="100">
          <template #default="{ row }">
            <div style="font-size:12px">{{ s.counts.total ? ((row.total / s.counts.total) * 100).toFixed(1) : 0 }}%</div>
            <div style="height:4px;background:rgba(255,255,255,.1);border-radius:2px;margin-top:4px"><div :style="{ width: s.counts.total ? ((row.total / s.counts.total) * 100) + '%' : '0%', background: DEPT_COLORS[$index % DEPT_COLORS.length], height: '100%', borderRadius: '2px' }"></div></div>
          </template>
        </el-table-column>
      </el-table>
      </div>
    </div>

    <!-- 问题类型 + 重复问题 -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px">
      <div class="card" style="border-top:2px solid #f472b6">
        <h3 style="margin:0 0 12px">问题类型分布</h3>
        <div ref="categoryEl" style="height:280px"></div>
      </div>
      <div class="card" style="border-top:2px solid #fb923c">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h3 style="margin:0">重复问题分析</h3>
          <span style="color:var(--c-text-soft);font-size:12px">同一位置出现多次</span>
        </div>
        <div v-if="!s.repeatLocations || !s.repeatLocations.length" style="color:var(--c-text-soft);text-align:center;padding:40px 0">
          暂无重复问题，各区域检查效果良好
        </div>
        <div v-else style="display:flex;flex-direction:column;gap:10px">
          <div v-for="(loc,i) in s.repeatLocations" :key="i" style="padding:10px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:8px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:#f59e0b">📍</span>
                <span style="color:#fff;font-weight:500">{{ loc.name }}</span>
              </div>
              <span style="color:#f59e0b;font-weight:700;font-size:13px">{{ loc.value }} 次</span>
            </div>
            <div style="height:5px;background:rgba(255,255,255,.08);border-radius:3px;margin-top:8px">
              <div :style="{ width: (loc.value / s.repeatLocations[0].value * 100) + '%', background: '#f59e0b', height: '100%', borderRadius: '3px' }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 整改进度分析 -->
    <div class="card section" style="border-top:2px solid #38bdf8;margin-bottom:18px">
      <h3 style="margin:0 0 14px">整改进度分析</h3>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <div class="progress-stack" style="flex:1;height:24px;border-radius:6px;overflow:hidden;display:flex;min-width:0">
          <div v-if="s.counts.pending" :style="{ flex: s.counts.pending, background: STATUS_COLORS.pending }"></div>
          <div v-if="s.counts.processing" :style="{ flex: s.counts.processing, background: STATUS_COLORS.processing }"></div>
          <div v-if="s.counts.reviewing" :style="{ flex: s.counts.reviewing, background: STATUS_COLORS.reviewing }"></div>
          <div v-if="s.counts.closed" :style="{ flex: s.counts.closed, background: STATUS_COLORS.closed }"></div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:16px;font-size:13px">
        <div style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:#f59e0b"></span>待处理 {{ s.counts.pending }}</div>
        <div style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:#38bdf8"></span>整改中 {{ s.counts.processing }}</div>
        <div style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:#a78bfa"></span>待验收 {{ s.counts.reviewing }}</div>
        <div style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:#34d399"></span>已关闭 {{ s.counts.closed }}</div>
      </div>
    </div>

    <!-- 最新催办消息 -->
    <div class="card section" style="border-top:2px solid var(--c-accent)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">最新催办消息</h3>
        <el-button text type="primary" @click="navigate('/messages')">查看全部</el-button>
      </div>
      <el-table :data="messages" size="small" empty-text="暂无消息" style="--el-table-bg-color:transparent">
        <el-table-column label="标题" min-width="160" show-overflow-tooltip>
          <template #default="{row}">{{ titleOf(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{row}">
            <span :class="isRead(row) ? 'tag-closed' : 'tag-overdue'">{{ isRead(row) ? '已读' : '未读' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{row}">
            <el-button text type="primary" @click="openMsg(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 公告预览（首页快速查看，标记已读） -->
    <el-dialog v-model="annVisible" width="720px" top="8vh">
      <template #header>
        <div style="display:flex;align-items:center;gap:8px">
          <span v-if="annDetail && annDetail.pinned" class="ann-pin-badge">置顶</span>
          <span style="font-weight:600">{{ (annDetail && annDetail.title) || '公告详情' }}</span>
        </div>
      </template>
      <div v-if="annDetail" class="ann-detail">
        <div class="ann-detail-meta">
          <span>{{ ANN_CATEGORY_MAP[annDetail.category] || '其他' }}</span>
          <span>发布人：{{ annDetail.authorName || '—' }}</span>
          <span>发布时间：{{ fmtDate(annDetail.publishedAt || annDetail.createdAt) }}</span>
        </div>
        <div class="ann-detail-body" v-html="annHtml"></div>
      </div>
      <template #footer>
        <el-button @click="annVisible=false">关 闭</el-button>
        <el-button type="primary" @click="navigate('/announcements')">前往公告栏</el-button>
      </template>
    </el-dialog>

    <!-- 车间详情弹窗 -->
    <el-dialog v-model="deptVisible" width="960px" destroy-on-close top="5vh">
      <template #header>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="back-inline" @click="deptVisible=false" title="返回"><ArrowLeft style="width:16px;height:16px" /></span>
          <span style="font-weight:600">{{ deptTitle }}</span>
        </div>
      </template>
      <div v-if="deptData">
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px">
          <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;color:#fff">{{ deptData.total }}</div><div style="font-size:12px;color:var(--c-text-soft)">总数</div></div>
          <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;color:#f59e0b">{{ deptData.pending }}</div><div style="font-size:12px;color:var(--c-text-soft)">待处理</div></div>
          <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;color:#38bdf8">{{ deptData.processing }}</div><div style="font-size:12px;color:var(--c-text-soft)">整改中</div></div>
          <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;color:#a78bfa">{{ deptData.reviewing }}</div><div style="font-size:12px;color:var(--c-text-soft)">待验收</div></div>
          <div class="card" style="padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;color:#34d399">{{ deptData.closed }}</div><div style="font-size:12px;color:var(--c-text-soft)">已关闭</div></div>
        </div>
        <div style="color:var(--c-text-soft);font-size:12px;margin-bottom:8px">该车间/部门下各状态占比</div>
        <div style="height:6px;border-radius:3px;overflow:hidden;display:flex;margin-bottom:16px">
          <div :style="{ flex: deptData.pending, background: STATUS_COLORS.pending }"></div>
          <div :style="{ flex: deptData.processing, background: STATUS_COLORS.processing }"></div>
          <div :style="{ flex: deptData.reviewing, background: STATUS_COLORS.reviewing }"></div>
          <div :style="{ flex: deptData.closed, background: STATUS_COLORS.closed }"></div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 style="margin:0;color:#fff">具体问题清单</h3>
          <div style="display:flex;gap:8px">
            <el-radio-group v-model="deptStatus" size="small" @change="loadDeptIssues">
              <el-radio-button label="">全部</el-radio-button>
              <el-radio-button label="pending">待处理</el-radio-button>
              <el-radio-button label="processing">整改中</el-radio-button>
              <el-radio-button label="reviewing">待验收</el-radio-button>
              <el-radio-button label="closed">已关闭</el-radio-button>
            </el-radio-group>
          </div>
        </div>
        <el-table :data="deptIssues" v-loading="deptLoading" size="small" stripe max-height="360" empty-text="暂无问题">
          <el-table-column label="编号" width="130"><template #default="{row}">{{ row.id || row._id }}</template></el-table-column>
          <el-table-column label="标题" min-width="150" show-overflow-tooltip><template #default="{row}">{{ row.title || row.description?.slice(0,20) }}</template></el-table-column>
          <el-table-column prop="category" label="类别" width="85" />
          <el-table-column label="等级" width="75"><template #default="{row}"><span :class="severityClass(row.severity)">{{ SEVERITY_MAP[row.severity] || '一般' }}</span></template></el-table-column>
          <el-table-column label="状态" width="75"><template #default="{row}"><span :class="statusClass(row.status)">{{ STATUS_MAP[row.status] || row.status }}</span></template></el-table-column>
          <el-table-column label="位置" min-width="130" show-overflow-tooltip><template #default="{row}">{{ row.location || '—' }}</template></el-table-column>
          <el-table-column label="整改期限" width="100"><template #default="{row}">{{ (row.dueDate||row.deadline||'').slice(0,10) || '—' }}</template></el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{row}">
              <el-button text type="primary" :icon="View" @click="openIssueDetail(row)">详情</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button @click="deptVisible=false">返 回</el-button>
      </template>
    </el-dialog>

    <!-- 问题详情（仪表盘内快速预览） -->
    <el-dialog v-model="issueVisible" width="720px" top="6vh" :close-on-click-modal="false">
      <template #header>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="back-inline" @click="issueVisible=false" title="返回"><ArrowLeft style="width:16px;height:16px" /></span>
          <span style="font-weight:600">问题详情</span>
        </div>
      </template>
      <div v-if="issueDetail" style="max-height:68vh;overflow:auto;padding-right:6px">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="编号" :span="2">{{ issueDetail.id || issueDetail._id }}</el-descriptions-item>
          <el-descriptions-item label="标题" :span="2">{{ issueDetail.title || '—' }}</el-descriptions-item>
          <el-descriptions-item label="类别">{{ issueDetail.category }}</el-descriptions-item>
          <el-descriptions-item label="等级"><span :class="severityClass(issueDetail.severity)">{{ SEVERITY_MAP[issueDetail.severity] || '一般' }}</span></el-descriptions-item>
          <el-descriptions-item label="部门">{{ issueDetail.department }}</el-descriptions-item>
          <el-descriptions-item label="责任人">{{ issueDetail.assigneeName }}</el-descriptions-item>
          <el-descriptions-item label="位置">{{ issueDetail.location || '—' }}</el-descriptions-item>
          <el-descriptions-item label="状态"><span :class="statusClass(issueDetail.status)">{{ STATUS_MAP[issueDetail.status] || issueDetail.status }}</span></el-descriptions-item>
          <el-descriptions-item label="整改期限">{{ (issueDetail.dueDate||issueDetail.deadline||'').slice(0,10) || '—' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ fmtDate(issueDetail.createdAt) }}</el-descriptions-item>
        </el-descriptions>
        <h3 style="margin:14px 0 8px;color:#fff">描述</h3>
        <div style="color:var(--c-text-soft);font-size:13px;line-height:1.6">{{ issueDetail.description || '—' }}</div>

        <h3 style="margin:14px 0 8px;color:#fff">现场照片</h3>
        <div v-if="issueDetail.photos && issueDetail.photos.length" style="display:flex;gap:8px;flex-wrap:wrap">
          <el-image v-for="(img,i) in issueDetail.photos" :key="i" :src="img" :preview-src-list="issueDetail.photos" style="width:90px;height:90px;border-radius:8px;border:1px solid var(--c-border)" fit="cover" />
        </div>
        <span v-else style="color:var(--c-text-soft);font-size:13px">暂无图片</span>

        <h3 style="margin:14px 0 8px;color:#fff">整改后照片</h3>
        <div v-if="issueDetail.rectificationPhotos && issueDetail.rectificationPhotos.length" style="display:flex;gap:8px;flex-wrap:wrap">
          <el-image v-for="(img,i) in issueDetail.rectificationPhotos" :key="i" :src="img" :preview-src-list="issueDetail.rectificationPhotos" style="width:90px;height:90px;border-radius:8px;border:1px solid var(--c-border)" fit="cover" />
        </div>
        <span v-else style="color:var(--c-text-soft);font-size:13px">暂无整改图片</span>
      </div>
      <template #footer>
        <el-button @click="issueVisible=false"><ArrowLeft style="width:14px;height:14px;margin-right:4px" />返 回</el-button>
        <el-button type="primary" @click="goToHazards(issueDetail)">前往隐患页处理</el-button>
      </template>
    </el-dialog>
  </div>`,
  setup() {
    const { ref, reactive, onMounted, onBeforeUnmount, nextTick, watch } = Vue;
    const { ElMessage } = ElementPlus;
    const { View, ArrowLeft } = ElementPlusIconsVue;

    const s = reactive({
      counts: { total: 0, pending: 0, processing: 0, reviewing: 0, closed: 0, overdue: 0 },
      byDepartment: [], byDepartmentDetail: [], bySeverity: {},
      byCategory: [], repeatLocations: [], trend: [],
      comparison: {}, alerts: []
    });
    const messages = ref([]);
    // 业务范围：默认取账号首个业务；仅归属单业务时整个仪表盘固定为该业务
    const _bizInfos = businessInfos(store.user);
    const bizList = ref(_bizInfos.length ? _bizInfos : BUSINESS_OPTS.map(o => ({ code: o.value, name: o.label })));
    const filterBiz = ref(bizList.value[0] ? bizList.value[0].code : 'SAFE');
    let allHazards = [];
    function bizFiltered() { return allHazards.filter(h => businessOf(h) === filterBiz.value); }
    function applyBiz() {
      Object.assign(s, computeStats(bizFiltered()));
      render();
    }
    const chartEl = ref(null);
    const pieEl = ref(null);
    const trendEl = ref(null);
    const severityEl = ref(null);
    const barEl = ref(null);
    const categoryEl = ref(null);
    let chart = null, pie = null, trend = null, severity = null, bar = null, category = null;
    const nowText = ref('');
    // 自动更新
    const checking = ref(false);
    async function manualCheck() {
      if (checking.value) return;
      checking.value = true;
      try {
        const r = await fetchLatest();
        if (r.error) { ElMessage.warning('检查更新失败：' + r.error); return; }
        if (r.hasUpdate) { await promptAndUpdate(r); }
        else { ElMessage.success('已是最新版本 v' + r.current); }
      } catch (e) {
        ElMessage.error('检查更新出错：' + (e && e.message));
      } finally {
        checking.value = false;
      }
    }
    // 数据实际取回的时刻（与 nowText 区分：本地缓存会先渲染旧数据，
    // 再后台刷新，因此把更新时间显式告知用户，避免误以为是实时数据）
    const dataUpdatedAt = ref('');

    // 弹窗
    const deptVisible = ref(false);
    const deptData = ref(null);
    const deptTitle = ref('');
    const deptIssues = ref([]);
    const deptStatus = ref('');
    const deptLoading = ref(false);
    const issueVisible = ref(false);
    const issueDetail = ref(null);
    // 公告栏
    const announcements = ref([]);
    const annRead = ref({});
    const annVisible = ref(false);
    const annDetail = ref(null);
    const annHtml = ref('');

    // 返回按钮处理：弹窗打开时优先关闭弹窗
    function closeTopDialog() {
      if (annVisible.value) { annVisible.value = false; return true; }
      if (issueVisible.value) { issueVisible.value = false; return true; }
      if (deptVisible.value) { deptVisible.value = false; return true; }
      return false;
    }
    watch([issueVisible, deptVisible, annVisible], (vals) => {
      store.backHandler = vals.some(v => v) ? closeTopDialog : null;
    });

    async function load() {
      try {
        nowText.value = new Date().toLocaleString('zh-CN', { hour12: false });
        const user = store.user;
        // 全量列表一次取回，按当前业务过滤后再聚合（管理员与普通用户同路径，
        // 便于业务切换时无需重新请求）
        const hr = await api.hazards({ page: 1, size: 0 });
        allHazards = filterIssuesByRole(user, hr.list || []);
        const res = computeStats(bizFiltered());
        Object.assign(s, res);
        store.unread = res.unreadMessages || 0;
        const m = await api.messages({});
        const visible = filterMessagesByUser(user, m.list || []);
        messages.value = visible.slice(0, 6);
        // 未读：管理员沿用 api.stats 的口径（全部消息未读数）；普通用户按可见消息
        if (isAdmin(user)) store.unread = (m.list || []).filter(x => x.isRead === false).length;
        else store.unread = visible.filter(x => x.isRead !== true).length;
        await loadAnnouncements(user);
        // 取缓存中数据的真实取数时刻，而不是本次渲染时刻：
        // 冷启动会先渲染磁盘上的旧数据，若显示渲染时刻会把陈旧数据说成"刚更新"
        const ts = cachedAt('col:');
        dataUpdatedAt.value = ts
          ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
          : '';
        await nextTick();
        render();
      } catch (e) {
        console.error('[dashboard] load failed:', e);
        ElMessage.error('仪表盘数据加载失败：' + e.message);
      }
    }

    async function loadDeptIssues() {
      if (!deptData.value) return;
      deptLoading.value = true;
      try {
        const r = await api.hazards({ department: deptData.value.name, status: deptStatus.value, page: 1, size: 0 });
        deptIssues.value = filterIssuesByRole(store.user, r.list || []);
      } catch (e) {
        ElMessage.error('加载问题清单失败：' + e.message);
        deptIssues.value = [];
      } finally {
        deptLoading.value = false;
      }
    }

    // 首页公告：只取前 5 条作预览。
    // 权限过滤必须放在前端——云端 query 不过滤公告，普通用户能看到草稿。
    async function loadAnnouncements(user) {
      try {
        const r = await api.announcements({ includeExpired: true });
        const visible = visibleAnnouncements(user, r.list || [], Date.now())
          .filter(a => matchTargetDept(a, currentDept()));
        announcements.value = visible.slice(0, 5);
        const ids = announcements.value.map(a => a._id);
        annRead.value = ids.length ? await api.announcementStats(ids, user) : {};
      } catch (e) {
        // 公告集合可能尚未在云端创建，此时不应拖垮整个仪表盘
        console.warn('[dashboard] 公告加载失败:', e && e.message);
        announcements.value = [];
        annRead.value = {};
      }
    }

    async function openAnnouncement(a) {
      annDetail.value = a;
      annHtml.value = await resolveHtmlImages(sanitizeHtml(a.content));
      annVisible.value = true;
      try {
        const added = await api.markAnnouncementRead(a._id, store.user);
        if (added) {
          const prev = annRead.value[a._id] || { views: 0, read: false };
          annRead.value[a._id] = { views: prev.views + 1, read: true };
        }
      } catch (e) {
        console.warn('[dashboard] 标记已读失败:', e && e.message);
      }
    }

    function openDept(row) {
      deptData.value = row;
      deptTitle.value = '车间/部门：' + row.name;
      deptStatus.value = '';
      deptVisible.value = true;
      loadDeptIssues();
    }

    async function openIssueDetail(row) {
      try {
        const h = await api.getHazard(row._id);
        const issue = h || row;
        await resolveIssuePhotos(issue);
        issueDetail.value = issue;
        issueVisible.value = true;
      } catch (e) {
        ElMessage.error('加载详情失败：' + e.message);
      }
    }

    // 仪表盘「详情」：跳转到催办页并自动打开对应详情，避免只弹 toast 看不到完整内容
    function openMsg(row) {
      store.pendingMessageId = row._id;
      navigate('/messages');
    }

    function goToHazards(keyOrIssue) {
      let filter;
      if (typeof keyOrIssue === 'string') {
        if (keyOrIssue === 'overdue') filter = { overdue: true };
        else if (keyOrIssue) filter = { status: keyOrIssue };
        else filter = {};
      } else if (keyOrIssue && typeof keyOrIssue === 'object') {
        issueVisible.value = false;
        deptVisible.value = false;
        const issue = keyOrIssue;
        filter = {
          status: issue.status || '',
          department: issue.department || '',
          keyword: issue.title || ''
        };
      } else {
        filter = {};
      }
      store.pendingHazardFilter = filter;
      navigate('/hazards');
    }

    function render() {
      if (trendEl.value && !trend) trend = echarts.init(trendEl.value, 'dark', { renderer: 'canvas' });
      if (severityEl.value && !severity) severity = echarts.init(severityEl.value, 'dark', { renderer: 'canvas' });
      if (barEl.value && !bar) bar = echarts.init(barEl.value, 'dark', { renderer: 'canvas' });
      if (pieEl.value && !pie) pie = echarts.init(pieEl.value, 'dark', { renderer: 'canvas' });
      if (categoryEl.value && !category) category = echarts.init(categoryEl.value, 'dark', { renderer: 'canvas' });

      const commonAxis = {
        axisLabel: { color: '#e5e7eb' },
        axisLine: { lineStyle: { color: 'var(--c-border)' } },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } }
      };

      // 趋势（30 天）
      if (trend) trend.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(11,18,32,.95)', borderColor: 'var(--c-border)', textStyle: { color: '#fff' } },
        legend: { textStyle: { color: '#e5e7eb' }, top: 0 },
        grid: { left: 40, right: 20, top: 36, bottom: 40 },
        xAxis: { type: 'category', data: s.trend.map(x => x.date.slice(5)), axisLabel: { color: '#e5e7eb', interval: 3 }, axisLine: { lineStyle: { color: 'var(--c-border)' } } },
        yAxis: { type: 'value', minInterval: 1, ...commonAxis },
        series: [
          { name: '新增', type: 'line', smooth: true, data: s.trend.map(x => x.created), itemStyle: { color: '#00e5a0' }, lineStyle: { width: 3, shadowColor: 'rgba(0,229,160,.5)', shadowBlur: 12 }, areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(0,229,160,.35)'},{offset:1,color:'rgba(0,229,160,.02)'}]) } },
          { name: '闭环', type: 'line', smooth: true, data: s.trend.map(x => x.closed), itemStyle: { color: '#38bdf8' }, lineStyle: { width: 2, type: 'dashed' } }
        ]
      }, true);

      // 等级分布
      if (severity) severity.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', backgroundColor: 'rgba(11,18,32,.95)', borderColor: 'var(--c-border)', textStyle: { color: '#fff' } },
        legend: { bottom: 0, textStyle: { color: '#e5e7eb' } },
        series: [{
          type: 'pie', radius: ['0%', '60%'], center: ['50%', '45%'],
          itemStyle: { borderRadius: 6, borderColor: 'var(--c-bg)', borderWidth: 2 },
          label: { color: '#fff' },
          data: [
            { name: SEVERITY_MAP.general, value: s.bySeverity.general || 0, itemStyle: { color: '#34d399' } },
            { name: SEVERITY_MAP.serious, value: s.bySeverity.serious || 0, itemStyle: { color: '#f59e0b' } },
            { name: SEVERITY_MAP.critical, value: s.bySeverity.critical || 0, itemStyle: { color: '#f87171' } }
          ]
        }]
      }, true);

      // 部门柱状
      if (bar) bar.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(11,18,32,.95)', borderColor: 'var(--c-border)', textStyle: { color: '#fff' } },
        grid: { left: 50, right: 20, top: 20, bottom: 50 },
        xAxis: { type: 'category', data: s.byDepartment.map(d => d.name), axisLabel: { interval: 0, rotate: 30, color: '#e5e7eb', fontSize: 11, hideOverlap: true }, axisLine: { lineStyle: { color: 'var(--c-border)' } } },
        yAxis: { type: 'value', minInterval: 1, ...commonAxis },
        series: [{ type: 'bar', data: s.byDepartment.map(d => d.value), itemStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'#f59e0b'},{offset:1,color:'#b45309'}]), borderRadius: [4,4,0,0] }, label: { show: true, position: 'top', color: '#fff' } }]
      }, true);

      // 状态分布
      if (pie) pie.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', backgroundColor: 'rgba(11,18,32,.95)', borderColor: 'var(--c-border)', textStyle: { color: '#fff' } },
        legend: { bottom: 0, textStyle: { color: '#e5e7eb' } },
        series: [{
          type: 'pie', radius: ['42%', '66%'], center: ['50%', '45%'],
          itemStyle: { borderRadius: 6, borderColor: 'var(--c-bg)', borderWidth: 2 },
          label: { color: '#fff' },
          data: [
            { name: STATUS_MAP.pending, value: s.counts.pending, itemStyle: { color: '#f59e0b' } },
            { name: STATUS_MAP.processing, value: s.counts.processing, itemStyle: { color: '#38bdf8' } },
            { name: STATUS_MAP.reviewing, value: s.counts.reviewing, itemStyle: { color: '#a78bfa' } },
            { name: STATUS_MAP.closed, value: s.counts.closed, itemStyle: { color: '#34d399' } }
          ]
        }]
      }, true);

      // 问题类型
      if (category) category.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', backgroundColor: 'rgba(11,18,32,.95)', borderColor: 'var(--c-border)', textStyle: { color: '#fff' } },
        legend: { bottom: 0, textStyle: { color: '#e5e7eb' } },
        series: [{
          type: 'pie', radius: ['40%', '70%'], center: ['50%', '45%'],
          itemStyle: { borderRadius: 6, borderColor: 'var(--c-bg)', borderWidth: 2 },
          label: { color: '#fff' },
          data: (s.byCategory || []).map((c, i) => ({ name: c.name, value: c.value, itemStyle: { color: DEPT_COLORS[i % DEPT_COLORS.length] } }))
        }]
      }, true);

      // chartEl 与 pieEl 是旧 dashboard 用的，这里已并到 trend/pie，置空保留引用避免影响
      chartEl.value = null; pieEl.value = null;
    }

    function onResize() {
      trend && trend.resize(); severity && severity.resize(); bar && bar.resize();
      pie && pie.resize(); category && category.resize();
    }
    window.addEventListener('resize', onResize);

    // 缓存后台刷新完成后自动刷新界面（SWR 的第二步）。
    // 多个集合会先后刷新完成，这里做防抖合并成一次渲染，避免图表反复重绘。
    // 不会产生死循环：刷新成功后数据变为"新鲜"，下次 load 不会再触发后台刷新；
    // 后台刷新失败时不会通知（保留旧值），因此也不会循环。
    let reloadTimer = null;
    const offUpdate = onUpdate(() => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { load(); }, 300);
    });

    onMounted(() => { load(); silentStartupCheck(); });
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize);
      offUpdate();
      clearTimeout(reloadTimer);
      trend && trend.dispose(); severity && severity.dispose(); bar && bar.dispose();
      pie && pie.dispose(); category && category.dispose();
      if (chart) chart.dispose(); if (pie) pie.dispose();
    });
    return {
      s, cards: CARD_CFG, messages,
      // 业务切换
      bizList, filterBiz, applyBiz, businessLabelOf,
      // 公告栏
      announcements, annRead, annVisible, annDetail, annHtml, openAnnouncement, ANN_CATEGORY_MAP,
      trendEl, severityEl, barEl, pieEl, categoryEl,
      // 弹窗状态
      deptVisible, deptData, deptTitle, deptIssues, deptStatus, deptLoading,
      issueVisible, issueDetail,
      // 工具
      DEPT_COLORS, STATUS_COLORS, STATUS_MAP, SEVERITY_MAP,
      navigate, goToHazards, loadDeptIssues, openDept, openIssueDetail, openMsg,
      titleOf, isRead, fmtArrow, statusClass, severityClass, fmtDate,
      View, ArrowLeft, nowText, dataUpdatedAt, checking, manualCheck
    };
  }
};