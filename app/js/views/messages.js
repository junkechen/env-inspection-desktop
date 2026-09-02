import { api } from '../api.js';
import { store } from '../store.js';
import { navigate } from '../router.js';
import { isAdmin, filterMessagesByUser } from '../permission.js';
import { resolveHtmlImages } from '../image_utils.js';

// 云端 message 集合实测字段：
//   content / fromUserId / fromUserName / toUserId / toUserName / isRead / type / createdAt
// 以真实字段为主，保留旧命名兜底以防历史脏数据。
function isRead(row) { return row.isRead === true || row.read === true || row.status === 'read'; }
function titleOf(row) { return row.title || row.subject || row.content || '催办通知'; }
function contentOf(row) { return row.content || row.message || row.description || row.text || ''; }
function toOf(row) { return row.toUserName || row.toUser || row.receiverName || '—'; }
function fromOf(row) { return row.fromUserName || row.fromUser || row.senderName || '系统'; }
function fmtDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }

export default {
  template: `
  <div>
    <h2 class="page-title">消息催办</h2>
    <p class="page-sub">系统催办与通知（与移动端同源）</p>
    <div class="toolbar">
      <el-select v-model="filterRead" placeholder="全部" clearable style="width:120px" @change="onFilterChange">
        <el-option label="未读" value="false" />
        <el-option label="已读" value="true" />
      </el-select>
      <el-button :icon="Refresh" @click="refresh">刷新</el-button>
      <span class="spacer"></span>
      <el-button type="primary" :icon="Check" @click="readAll">全部标记已读</el-button>
    </div>
    <div class="card">
      <div class="table-wrap">
        <el-table :data="pagedList" v-loading="loading" stripe style="width:100%" table-layout="fixed">
          <el-table-column label="标题" width="160" show-overflow-tooltip>
            <template #default="{row}">{{ titleOf(row) }}</template>
          </el-table-column>
          <el-table-column label="内容" min-width="200" show-overflow-tooltip>
            <template #default="{row}">{{ contentOf(row) }}</template>
          </el-table-column>
          <el-table-column label="接收人" width="100">
            <template #default="{row}">{{ toOf(row) }}</template>
          </el-table-column>
          <el-table-column label="发送人" width="100">
            <template #default="{row}">{{ fromOf(row) }}</template>
          </el-table-column>
          <el-table-column label="时间" width="150">
            <template #default="{row}">{{ fmtDate(row.createdAt || row._createTime) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="84">
            <template #default="{row}"><span :class="isRead(row) ? 'tag-closed' : 'tag-overdue'">{{ isRead(row) ? '已读' : '未读' }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{row}">
              <el-button text type="primary" @click="openDetail(row)">详情</el-button>
              <el-button text type="success" :disabled="isRead(row)" @click="readOne(row)">已读</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        :total="filteredTotal"
        class="pager"
        @change="onPageChange"
      />
    </div>

    <!-- 消息详情弹窗 -->
    <el-dialog v-model="detailVisible" width="680px" top="8vh" :close-on-click-modal="false">
      <template #header>
        <div style="display:flex;align-items:center;gap:8px">
          <span :class="detail && isRead(detail) ? 'tag-closed' : 'tag-overdue'">{{ detail && isRead(detail) ? '已读' : '未读' }}</span>
          <span style="font-weight:600">{{ (detail && titleOf(detail)) || '消息详情' }}</span>
        </div>
      </template>
      <div v-if="detail" class="msg-detail">
        <div class="msg-detail-meta">
          <span>发送人：{{ fromOf(detail) }}</span>
          <span>接收人：{{ toOf(detail) }}</span>
          <span>时间：{{ fmtDate(detail.createdAt || detail._createTime) }}</span>
          <span v-if="detail.type">类型：{{ detail.type }}</span>
        </div>
        <div class="msg-detail-body" v-html="detailHtml"></div>
        <div v-if="relatedIssue" style="margin-top:16px">
          <h4 style="margin:0 0 8px;color:#fff">关联整改</h4>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="编号" :span="2">{{ relatedIssue.id || relatedIssue._id }}</el-descriptions-item>
            <el-descriptions-item label="标题" :span="2">{{ relatedIssue.title || '—' }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ relatedIssue.status || '—' }}</el-descriptions-item>
            <el-descriptions-item label="责任人">{{ relatedIssue.assigneeName || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div style="margin-top:10px;display:flex;gap:8px">
            <el-button type="primary" size="small" @click="goIssue(relatedIssue)">前往处理</el-button>
            <el-button size="small" @click="detailVisible=false">关 闭</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="detailVisible=false">关 闭</el-button>
        <el-button type="primary" :disabled="!detail || isRead(detail)" @click="readDetail">标记已读</el-button>
      </template>
    </el-dialog>
  </div>`,
  setup() {
    const { ref, onMounted, computed } = Vue;
    const { ElMessage } = ElementPlus;
    const { Refresh, Check } = ElementPlusIconsVue;
    const list = ref([]);
    const loading = ref(false);
    const filterRead = ref('');
    const page = ref(1);
    const pageSize = ref(20);
    const detailVisible = ref(false);
    const detail = ref(null);
    const detailHtml = ref('');
    const relatedIssue = ref(null);

    // 前端缓存完整数据；分页、筛选均在内存中做，避免反复请求
    let allMessages = [];

    const filteredList = computed(() => {
      let data = allMessages;
      if (filterRead.value === 'false') data = data.filter(m => !isRead(m));
      else if (filterRead.value === 'true') data = data.filter(m => isRead(m));
      return data;
    });
    const filteredTotal = computed(() => filteredList.value.length);
    const pagedList = computed(() => {
      const start = (page.value - 1) * pageSize.value;
      return filteredList.value.slice(start, start + pageSize.value);
    });

    async function load() {
      loading.value = true;
      try {
        // 不携带 read 参数：一次取回全部，前端做筛选/分页，减少重复拉取
        const r = await api.messages({ page: 1, size: 0 });
        const user = store.user;
        allMessages = isAdmin(user) ? (r.list || []) : filterMessagesByUser(user, r.list || []);
        // 按时间倒序
        allMessages.sort((a, b) => fmtDate(b.createdAt || b._createTime).localeCompare(fmtDate(a.createdAt || a._createTime)));
        store.unread = r.unread;
        list.value = allMessages;
        // 仪表盘跳转过来要求自动打开某条详情
        if (store.pendingMessageId) {
          const target = allMessages.find((x) => x._id === store.pendingMessageId);
          store.pendingMessageId = null;
          if (target) openDetail(target);
        }
      } catch (e) { ElMessage.error(e.message); }
      finally { loading.value = false; }
    }

    function onFilterChange() { page.value = 1; }
    function onPageChange() {}

    async function readOne(row) {
      try {
        await api.readMessage(row._id);
        const item = allMessages.find((x) => x._id === row._id);
        if (item) { item.isRead = true; }
        store.unread = Math.max(0, (store.unread || 0) - 1);
        ElMessage.success('已标记已读');
      } catch (e) { ElMessage.error(e.message); }
    }
    async function readDetail() {
      if (!detail.value) return;
      await readOne(detail.value);
      detailVisible.value = false;
    }
    async function readAll() {
      const ids = allMessages.filter((x) => !isRead(x)).map((x) => x._id);
      if (!ids.length) { ElMessage.info('没有未读消息'); return; }
      loading.value = true;
      let msg = ElMessage({ message: '正在标记已读…', type: 'info', duration: 0 });
      try {
        await api.readAllMessages(ids, (cur, total) => {
          msg.close && msg.close();
          msg = ElMessage({ message: `正在标记已读 ${cur}/${total}…`, type: 'info', duration: 0 });
        });
        msg.close && msg.close();
        allMessages.forEach((x) => { if (ids.includes(x._id)) { x.isRead = true; } });
        store.unread = 0;
        ElMessage.success('已全部标记已读');
      } catch (e) {
        msg.close && msg.close();
        ElMessage.error(e.message);
      } finally { loading.value = false; }
    }
    // 「刷新」由用户主动触发，先失效缓存再取数；
    // 否则在 TTL 内点击会直接命中缓存，看起来像刷新没生效。
    function refresh() { api.refreshCache('message'); load(); }

    async function openDetail(row) {
      detail.value = row;
      detailHtml.value = await resolveHtmlImages(contentOf(row));
      relatedIssue.value = null;
      detailVisible.value = true;
      // 尝试查找关联整改（message 里常见的 issueId / issue_id / taskId / id）
      const issueId = row.issueId || row.issue_id || row.taskId || row.task_id || row.hazardId || row.hazard_id;
      if (issueId) {
        try { relatedIssue.value = await api.getHazard(issueId); } catch (e) { /* 忽略 */ }
      }
    }
    function goIssue(issue) {
      store.pendingHazardFilter = { status: issue.status || '', department: issue.department || '', keyword: issue.title || '' };
      detailVisible.value = false;
      navigate('/hazards');
    }

    onMounted(load);
    return {
      list, pagedList, filteredTotal, loading, filterRead, page, pageSize,
      load, refresh, readOne, readAll, readDetail, openDetail, goIssue,
      onFilterChange, onPageChange,
      titleOf, contentOf, toOf, fromOf, isRead, fmtDate,
      detailVisible, detail, detailHtml, relatedIssue,
      Refresh, Check
    };
  }
};
