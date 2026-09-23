import { api, ENV } from '../api.js';
import { store } from '../store.js';
import { uploadFiles } from '../image_upload.js';
import { resolveHtmlImages, resolveImageUrl } from '../image_utils.js';
import RichTextEditor from '../richtext.js';
import {
  STATUS, STATUS_MAP, CATEGORY_MAP, MAX_PINNED, AUDIT_ACTION_MAP,
  canManage, canPin, visibleAnnouncements, statusText, isPinned,
  matchTargetDept, sanitizeHtml, stripTags, draftKey, parseDraft
} from '../announcement.js';
import { currentDept } from '../dept.js';

function fmtDate(v) {
  if (!v) return '—';
  return String(v).slice(0, 16).replace('T', ' ');
}
function statusClassOf(a, now) {
  const t = statusText(a, now);
  if (t === '已发布') return 'tag-closed';
  if (t === '草稿') return 'tag-processing';
  if (t === '已过期') return 'tag-overdue';
  return '';
}

export default {
  components: { RichTextEditor },
  template: `
  <div>
    <h2 class="page-title">公告栏</h2>
    <p class="page-sub">管理员可发布、编辑、置顶与删除公告；其他用户仅可查看</p>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索标题或正文" clearable style="width:200px"
                @keyup.enter="load" @clear="load" />
      <el-select v-model="category" placeholder="全部分类" clearable style="width:130px" @change="load">
        <el-option v-for="(v,k) in CATEGORY_MAP" :key="k" :label="v" :value="k" />
      </el-select>
      <el-select v-if="isManager" v-model="status" placeholder="全部状态" clearable style="width:120px" @change="load">
        <el-option label="草稿" value="draft" />
        <el-option label="已发布" value="published" />
        <el-option label="已归档" value="archived" />
      </el-select>
      <el-button :icon="Refresh" @click="refresh">刷新</el-button>
      <span class="spacer"></span>
      <span v-if="isManager" class="ann-pin-info">置顶 {{ pinnedCount }}/{{ MAX_PINNED }}</span>
      <el-button v-if="isManager" type="primary" :icon="Plus" @click="openCreate">新建公告</el-button>
    </div>

    <div class="card">
      <div v-if="!pagedList.length && !loading" class="ann-empty">
        {{ keyword || category || status ? '没有匹配的公告' : '暂无公告' }}
      </div>
      <div v-for="a in pagedList" :key="a._id" class="ann-item" :class="{ 'is-pinned': a.pinned }">
        <div class="ann-item-main" @click="openDetail(a)">
          <div class="ann-title-row">
            <span v-if="a.pinned" class="ann-pin-badge">置顶</span>
            <span v-if="!isRead(a)" class="ann-unread-dot" title="未读"></span>
            <span class="ann-title">{{ a.title || '(无标题)' }}</span>
            <span class="ann-cat">{{ CATEGORY_MAP[a.category] || '其他' }}</span>
          </div>
          <div class="ann-summary">{{ summaryOf(a) }}</div>
          <div class="ann-meta">
            <span :class="statusClassOf(a, now)">{{ statusText(a, now) }}</span>
            <span>{{ a.authorName || '—' }}</span>
            <span>{{ fmtDate(a.publishedAt || a.createdAt) }}</span>
            <span>阅读 {{ (readMap[a._id] && readMap[a._id].views) || 0 }}</span>
            <span v-if="a.expireAt">有效期至 {{ fmtDate(a.expireAt) }}</span>
            <span v-if="a.attachments && a.attachments.length">{{ a.attachments.length }} 个附件</span>
          </div>
        </div>
        <div class="ann-actions">
          <el-button text type="primary" @click="openDetail(a)">查看</el-button>
          <template v-if="isManager">
            <el-button text @click.stop="openEdit(a)">编辑</el-button>
            <el-button text :type="a.pinned ? 'warning' : 'success'" @click="togglePin(a)">
              {{ a.pinned ? '取消置顶' : '置顶' }}
            </el-button>
            <el-button text @click="openAudit(a)">日志</el-button>
            <el-button text type="danger" @click="removeOne(a)">删除</el-button>
          </template>
        </div>
      </div>
    </div>

    <div class="pager" v-if="total > size">
      <el-pagination background layout="prev,pager,next" :total="total" :page-size="size"
                     v-model:current-page="page" @current-change="onPage" />
    </div>

    <!-- 详情 -->
    <el-dialog v-model="detailVisible" width="760px" top="6vh" :close-on-click-modal="true">
      <template #header>
        <div style="display:flex;align-items:center;gap:8px">
          <span v-if="current && current.pinned" class="ann-pin-badge">置顶</span>
          <span style="font-weight:600">{{ (current && current.title) || '公告详情' }}</span>
        </div>
      </template>
      <div v-if="current" class="ann-detail">
        <div class="ann-detail-meta">
          <span>{{ CATEGORY_MAP[current.category] || '其他' }}</span>
          <span>发布人：{{ current.authorName || '—' }}</span>
          <span>发布时间：{{ fmtDate(current.publishedAt || current.createdAt) }}</span>
          <span>阅读 {{ (readMap[current._id] && readMap[current._id].views) || 0 }}</span>
          <span v-if="current.expireAt">有效期至 {{ fmtDate(current.expireAt) }}</span>
        </div>
        <div class="ann-detail-body" v-html="detailHtml"></div>
        <div v-if="current.attachments && current.attachments.length" class="ann-attach">
          <div class="ann-attach-title">图片附件（{{ current.attachments.length }}）</div>
          <div class="ann-attach-list">
            <el-image v-for="(u,i) in detailAttachments" :key="i" :src="u.url" :preview-src-list="detailAttachments.map(x=>x.url)"
                      fit="cover" class="ann-thumb">
              <template #error>
                <div class="ann-thumb-error" :title="u.fileId">
                  {{ u.foreign ? '旧环境图片，需在当前环境重传' : '加载失败' }}
                </div>
              </template>
            </el-image>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="detailVisible=false">关 闭</el-button>
      </template>
    </el-dialog>

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="editVisible" :width="dialogWidth" top="4vh" :close-on-click-modal="false"
               @closed="onEditClosed">
      <template #header><span style="font-weight:600">{{ editingId ? '编辑公告' : '新建公告' }}</span></template>
      <el-form label-width="80px">
        <el-form-item label="标题" required>
          <el-input v-model="form.title" maxlength="80" show-word-limit placeholder="请输入公告标题" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.category" style="width:160px">
            <el-option v-for="(v,k) in CATEGORY_MAP" :key="k" :label="v" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="有效期">
          <el-date-picker v-model="form.expireAt" type="datetime" placeholder="留空表示长期有效"
                          value-format="YYYY-MM-DDTHH:mm:ss" style="width:220px" />
          <span style="color:var(--c-text-soft);font-size:12px;margin-left:8px">到点后自动归档，不再对普通用户展示</span>
        </el-form-item>
        <el-form-item label="正文" required>
          <rich-text-editor v-model="form.content" :min-height="'240px'" />
        </el-form-item>
        <el-form-item label="图片附件">
          <input type="file" accept="image/*" multiple @change="onAttach" :disabled="uploading" />
          <div v-if="form.attachments.length" class="ann-attach-list" style="margin-top:8px">
            <div v-for="(u,i) in editAttachments" :key="i" style="position:relative">
              <el-image :src="u.url" fit="cover" class="ann-thumb">
                <template #error>
                  <div class="ann-thumb-error" :title="u.fileId">
                    {{ u.foreign ? '旧环境图片，需重传' : '加载失败' }}
                  </div>
                </template>
              </el-image>
              <el-button circle size="small" class="ann-del" @click="removeAttach(i)">×</el-button>
            </div>
          </div>
          <div style="color:var(--c-text-soft);font-size:12px">最多 9 张，自动压缩后上传</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <span class="ann-autosave-tip">{{ autosaveTip }}</span>
        <el-button @click="editVisible=false">取 消</el-button>
        <el-button :loading="saving" @click="saveDraft">保存草稿</el-button>
        <el-button @click="previewVisible=true">预 览</el-button>
        <el-button type="primary" :loading="saving" @click="publish">
          {{ editingId && form.status === 'published' ? '保存修改' : '发 布' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 发布前预览 -->
    <el-dialog v-model="previewVisible" width="760px" top="6vh" title="发布预览">
      <div class="ann-detail">
        <h3 style="color:#fff;margin:0 0 6px">{{ form.title || '(无标题)' }}</h3>
        <div class="ann-detail-meta">
          <span>{{ CATEGORY_MAP[form.category] || '其他' }}</span>
          <span>发布人：{{ me && (me.name || me.username) }}</span>
          <span>发布时间：{{ fmtDate(new Date()) }}</span>
          <span v-if="form.expireAt">有效期至 {{ fmtDate(form.expireAt) }}</span>
        </div>
        <div class="ann-detail-body" v-html="sanitizeHtml(form.content)"></div>
        <div v-if="form.attachments.length" class="ann-attach">
          <div class="ann-attach-title">图片附件（{{ form.attachments.length }}）</div>
          <div class="ann-attach-list">
            <el-image v-for="(u,i) in previewAttachments" :key="i" :src="u.url" :preview-src-list="previewAttachments.map(x=>x.url)"
                      fit="cover" class="ann-thumb">
              <template #error>
                <div class="ann-thumb-error" :title="u.fileId">
                  {{ u.foreign ? '旧环境图片，需在当前环境重传' : '加载失败' }}
                </div>
              </template>
            </el-image>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="previewVisible=false">返 回</el-button>
      </template>
    </el-dialog>

    <!-- 审计日志 -->
    <el-drawer v-model="auditVisible" title="操作审计日志" size="440px">
      <div v-if="!auditList.length" style="color:var(--c-text-soft)">暂无操作记录</div>
      <el-timeline v-else>
        <el-timeline-item v-for="(l,i) in auditList" :key="i" :timestamp="fmtDate(l.createdAt)" placement="top">
          <div style="color:#fff">{{ AUDIT_ACTION_MAP[l.action] || l.action }}</div>
          <div style="color:var(--c-text-soft);font-size:12px">操作人：{{ l.operatorName || '—' }}</div>
          <div v-if="l.detail" style="color:var(--c-text-soft);font-size:12px">{{ l.detail }}</div>
        </el-timeline-item>
      </el-drawer>
    </el-drawer>
  </div>`,
  setup() {
    const { ref, computed, watch, onMounted, onBeforeUnmount } = Vue;
    const { ElMessage, ElMessageBox } = ElementPlus;
    const { Refresh, Plus } = ElementPlusIconsVue;

    const me = store.user;
    const isManager = computed(() => canManage(me));

    const raw = ref([]);            // 云端原始数据（含草稿/归档，用于归档扫描）
    const list = ref([]);           // 按权限与筛选后的展示列表
    const readMap = ref({});
    const loading = ref(false);
    const saving = ref(false);
    const uploading = ref(false);
    const keyword = ref('');
    const category = ref('');
    const status = ref('');
    const page = ref(1);
    const size = ref(10);
    const now = ref(Date.now());

    const current = ref(null);
    const detailVisible = ref(false);
    const detailHtml = ref('');
    const detailAttachments = ref([]);
    const previewAttachments = ref([]);
    const editAttachments = ref([]);

    const editVisible = ref(false);
    const previewVisible = ref(false);
    const editingId = ref('');
    const form = ref(emptyForm());
    const autosaveTip = ref('');

    const auditVisible = ref(false);
    const auditList = ref([]);

    function emptyForm() {
      return {
        title: '', category: 'notice', content: '', expireAt: '',
        attachments: [], status: STATUS.DRAFT
      };
    }

    const total = computed(() => list.value.length);
    const pagedList = computed(() => {
      const start = (page.value - 1) * size.value;
      return list.value.slice(start, start + size.value);
    });
    const pinnedCount = computed(() => raw.value.filter(a => !a.isDeleted && isPinned(a) && a.status !== STATUS.ARCHIVED).length);
    // 依赖 ref 而非直接读 window.innerWidth，否则 computed 不会随窗口变化重算
    const winWidth = ref(window.innerWidth || 1280);
    const dialogWidth = computed(() => (winWidth.value <= 768 ? '96%' : '820px'));

    function summaryOf(a) {
      const t = stripTags(a.content);
      return t.length > 90 ? t.slice(0, 90) + '…' : (t || '（无正文）');
    }
    // https URL -> cloud://fileID，用于 403 签名过期时刷新
    const attachmentMap = new Map();

    // 提取 cloud:// fileID 所属的 envId，用于识别旧环境遗留图片
    function fileEnvOf(fileId) {
      const m = /^cloud:\/\/([^./]+)/.exec(fileId || '');
      return m ? m[1] : '';
    }
    // 该 fileID 是否属于当前应用环境以外（跨环境签名会 403，属数据问题非客户端 bug）
    function isForeignEnv(fileId) {
      const env = fileEnvOf(fileId);
      return !!env && env !== ENV;
    }

    // 把 cloud:// fileID 批量刷新为可访问的 URL，供 el-image 直接加载。
    // Electron 端进一步经主进程下载为 data URL，绕开 Win10 证书/TLS 限制（Web 端走原生加载）。
    // 返回 { fileId, url, foreign } 以便前端标注旧环境失效图片。
    async function proxyImageUrl(url) {
      const api = (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.fetchImageUrl) ? window.electronAPI : null;
      const u = typeof url === 'string' ? url.trim() : '';
      if (api && u && /^https?:\/\//i.test(u)) {
        try {
          let r = await api.fetchImageUrl(u);
          if (r && r.dataUrl) return r.dataUrl;
          // 403 大概率是跨环境签名无效或签名过期，尝试用原始 cloud:// fileID 重新获取临时 URL 再试一次
          if (r && r.error && String(r.error).includes('403') && attachmentMap.has(u)) {
            const fileId = attachmentMap.get(u);
            console.log('[图片代理] 403 刷新签名:', fileId, 'foreignEnv=', isForeignEnv(fileId));
            const fresh = await resolveImageUrl(fileId, true);
            if (fresh && fresh !== u) {
              attachmentMap.set(fresh, fileId);
              r = await api.fetchImageUrl(fresh);
              if (r && r.dataUrl) return r.dataUrl;
            }
          }
          if (r && r.error) console.error('[图片代理失败]', u, '->', r.error);
        } catch (e) { console.error('[图片代理异常]', u, e && e.message); }
      }
      return url;
    }
    async function resolveAttachments(urls) {
      if (!Array.isArray(urls)) return [];
      return await Promise.all(urls.map(async (u) => {
        const fileId = typeof u === 'string' ? u : '';
        let httpsUrl = fileId;
        if (fileId.startsWith('cloud://')) {
          httpsUrl = await resolveImageUrl(fileId);
          if (httpsUrl !== fileId) attachmentMap.set(httpsUrl, fileId);
        }
        const display = await proxyImageUrl(httpsUrl);
        return { fileId, url: display, foreign: isForeignEnv(fileId) };
      }));
    }
    function isRead(a) {
      const s = readMap.value[a._id];
      return !!(s && s.read);
    }

    async function load() {
      loading.value = true;
      try {
        const r = await api.announcements({
          keyword: keyword.value, category: category.value, status: status.value, includeExpired: true
        });
        // 注意：announcements 返回的是全部文档，必须在前端按角色过滤，
        // 否则普通用户能看到草稿（服务端不过滤，前端是唯一权限闸口）
        raw.value = r.list;

        // 过期自动归档（逐条写回；归档后 status 变化，不会重复触发）
        const n = await api.archiveExpiredAnnouncements(raw.value, me);
        if (n > 0) {
          const again = await api.announcements({
            keyword: keyword.value, category: category.value, status: status.value, includeExpired: true
          });
          raw.value = again.list;
        }

        now.value = Date.now();
        // 【D-6 修复】公告按科室定向：带 targetDept 的公告仅本科室可见；空 targetDept 仍全员可见。
        list.value = visibleAnnouncements(me, raw.value, now.value)
          .filter(a => matchTargetDept(a, currentDept()));
        await loadStats();
      } catch (e) {
        ElMessage.error(e.message);
      } finally {
        loading.value = false;
      }
    }

    async function loadStats() {
      const ids = list.value.map(a => a._id);
      if (!ids.length) { readMap.value = {}; return; }
      try {
        readMap.value = await api.announcementStats(ids, me);
      } catch (e) {
        // 阅读统计失败不应阻断公告浏览
        console.warn('[announcement] 阅读统计失败:', e && e.message);
        readMap.value = {};
      }
    }

    function onPage(p) { page.value = p; }

    // 「刷新」由用户主动触发，先失效缓存再取数；
    // 否则在 TTL 内点击会直接命中缓存，看起来像刷新没生效。
    function refresh() { api.refreshCache('announcement'); load(); }

    async function openDetail(a) {
      current.value = a;
      // 先消毒再解析 cloud:// 图片，保证 v-html 渲染安全且图片可加载
      detailHtml.value = await resolveHtmlImages(sanitizeHtml(a.content));
      detailAttachments.value = await resolveAttachments(a.attachments || []);
      detailVisible.value = true;
      try {
        const added = await api.markAnnouncementRead(a._id, me);
        if (added) {
          // 本地就地更新，避免整表重拉
          const prev = readMap.value[a._id] || { views: 0, read: false };
          readMap.value[a._id] = { views: prev.views + 1, read: true };
        }
      } catch (e) {
        console.warn('[announcement] 标记已读失败:', e && e.message);
      }
    }

    // ---------- 新建 / 编辑 ----------
    let draftTimer = null;
    function scheduleAutosave() {
      if (!isManager.value) return;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        try {
          localStorage.setItem(draftKey(editingId.value || 'new'), JSON.stringify({
            savedAt: new Date().toISOString(), form: form.value
          }));
          autosaveTip.value = '草稿已自动保存 ' + new Date().toLocaleTimeString();
        } catch (e) { /* 隐私模式/配额不足时静默降级，不打断编辑 */ }
      }, 800);
    }
    watch(form, () => { if (editVisible.value) scheduleAutosave(); }, { deep: true });

    function clearDraft(id) {
      try { localStorage.removeItem(draftKey(id || 'new')); } catch (e) { /* ignore */ }
    }

    async function openCreate() {
      editingId.value = '';
      form.value = emptyForm();
      editAttachments.value = [];
      autosaveTip.value = '';
      // 恢复上次未提交的草稿
      let saved = null;
      try { saved = parseDraft(localStorage.getItem(draftKey('new'))); } catch (e) { saved = null; }
      if (saved) {
        try {
          await ElMessageBox.confirm('检测到上次未提交的草稿，是否恢复？选择“取消”将丢弃该草稿。', '恢复草稿', {
            confirmButtonText: '恢复', cancelButtonText: '丢弃', type: 'info'
          });
          form.value = Object.assign(emptyForm(), saved.form);
          editAttachments.value = await resolveAttachments(form.value.attachments);
          ElMessage.success('草稿已恢复');
        } catch (e) { clearDraft(''); }
      }
      editVisible.value = true;
    }

    async function openEdit(a) {
      editingId.value = a._id;
      form.value = Object.assign(emptyForm(), {
        title: a.title || '', category: a.category || 'notice',
        content: a.content || '', expireAt: a.expireAt || '',
        attachments: (a.attachments || []).slice(), status: a.status || STATUS.DRAFT
      });
      editAttachments.value = await resolveAttachments(form.value.attachments);
      autosaveTip.value = '';
      editVisible.value = true;
    }

    function onEditClosed() {
      clearTimeout(draftTimer);
      editingId.value = '';
      autosaveTip.value = '';
    }

    async function onAttach(e) {
      const files = e && e.target && e.target.files;
      if (!files || !files.length) return;
      uploading.value = true;
      try {
        const left = 9 - form.value.attachments.length;
        if (files.length > left) throw new Error('最多 9 张附件，还可添加 ' + left + ' 张');
        const urls = await uploadFiles(files, api, { maxFiles: left });
        form.value.attachments.push(...urls);
        editAttachments.value = await resolveAttachments(form.value.attachments);
        ElMessage.success('已添加 ' + urls.length + ' 张附件');
      } catch (err) { ElMessage.error((err && err.message) || '附件上传失败'); }
      finally {
        uploading.value = false;
        if (e.target) e.target.value = '';
      }
    }
    function removeAttach(i) {
      form.value.attachments.splice(i, 1);
      editAttachments.value.splice(i, 1);
    }

    function validate() {
      if (!form.value.title.trim()) { ElMessage.warning('请填写公告标题'); return false; }
      if (!stripTags(form.value.content)) { ElMessage.warning('请填写公告正文'); return false; }
      return true;
    }

    // 入库前统一消毒：即使编辑器被绕过（粘贴/外部数据），也不把危险 HTML 写进云端
    function payload(extra) {
      return Object.assign({
        title: form.value.title.trim(),
        category: form.value.category,
        content: sanitizeHtml(form.value.content),
        expireAt: form.value.expireAt || '',
        // 【D-6 修复】公告默认定向到当前科室，避免安全科公告推给环保全员、反之亦然。
        // 历史公告 targetDept 为空，仍全员可见（向后兼容）。
        targetDept: form.value.targetDept && form.value.targetDept.length
          ? form.value.targetDept.slice()
          : [currentDept()],
        attachments: form.value.attachments.slice(),
        updatedAt: new Date().toISOString()
      }, extra || {});
    }

    async function saveDraft() {
      if (!form.value.title.trim()) { ElMessage.warning('请至少填写标题后再保存草稿'); return; }
      saving.value = true;
      try {
        const id = await doSave(STATUS.DRAFT);
        ElMessage.success('草稿已保存');
        if (id) await api.writeAnnouncementAudit(id, 'update', me, '保存草稿：' + form.value.title).catch(() => null);
        await finishSave();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    async function publish() {
      if (!validate()) return;
      saving.value = true;
      try {
        const id = await doSave(STATUS.PUBLISHED);
        ElMessage.success('已发布');
        // 新建时云端 add 不回传 _id，此时无法把审计日志关联到具体公告，只能跳过；
        // 编辑/置顶/删除等后续操作都能拿到 id，日志不受影响。
        if (id) {
          await api.writeAnnouncementAudit(id, form.value.status === STATUS.PUBLISHED ? 'update' : 'publish',
            me, '发布公告：' + form.value.title).catch(() => null);
        }
        await finishSave();
      } catch (e) { ElMessage.error(e.message); }
      finally { saving.value = false; }
    }

    // 打开发布前预览时，把附件也刷新为 https，避免 cloud:// 加载失败
    watch(previewVisible, async (v) => {
      if (v) previewAttachments.value = await resolveAttachments(form.value.attachments || []);
    });

    // 新建或更新，返回文档 _id
    async function doSave(targetStatus) {
      const common = payload({
        status: targetStatus,
        authorId: me ? String(me._id || me.id || me.username || '') : '',
        authorName: me ? (me.name || me.username || '') : ''
      });
      if (editingId.value) {
        if (targetStatus === STATUS.PUBLISHED && form.value.status !== STATUS.PUBLISHED) {
          common.publishedAt = new Date().toISOString();
        }
        await api.updateAnnouncement(editingId.value, common);
        return editingId.value;
      }
      if (targetStatus === STATUS.PUBLISHED) common.publishedAt = new Date().toISOString();
      common.createdAt = new Date().toISOString();
      return await api.createAnnouncement(common);
    }

    async function finishSave() {
      clearDraft(editingId.value || 'new');
      editVisible.value = false;
      previewVisible.value = false;
      await load();
    }

    // ---------- 置顶 / 删除 / 日志 ----------
    async function togglePin(a) {
      if (!isManager.value) return;
      try {
        if (a.pinned) {
          await api.updateAnnouncement(a._id, { pinned: false, pinnedAt: '' });
          await api.writeAnnouncementAudit(a._id, 'unpin', me, '取消置顶：' + a.title).catch(() => null);
          ElMessage.success('已取消置顶');
        } else {
          const r = canPin(a, raw.value);
          if (!r.ok) { ElMessage.warning(r.reason); return; }
          await api.updateAnnouncement(a._id, { pinned: true, pinnedAt: new Date().toISOString() });
          await api.writeAnnouncementAudit(a._id, 'pin', me, '置顶公告：' + a.title).catch(() => null);
          ElMessage.success('已置顶');
        }
        await load();
      } catch (e) { ElMessage.error(e.message); }
    }

    async function removeOne(a) {
      try {
        await ElMessageBox.confirm('确定删除公告「' + (a.title || '无标题') + '」？删除后不可恢复。', '删除确认', {
          confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning'
        });
      } catch (e) { return; }
      try {
        await api.deleteAnnouncement(a._id, me ? (me.name || me.username) : '');
        await api.writeAnnouncementAudit(a._id, 'delete', me, '删除公告：' + a.title).catch(() => null);
        ElMessage.success('已删除');
        await load();
      } catch (e) { ElMessage.error(e.message); }
    }

    async function openAudit(a) {
      current.value = a;
      auditVisible.value = true;
      auditList.value = [];
      try { auditList.value = await api.announcementAudits(a._id); }
      catch (e) { ElMessage.error(e.message); }
    }

    function onResize() {
      winWidth.value = window.innerWidth || 1280;
      now.value = Date.now(); // 同时刷新过期状态显示
    }
    window.addEventListener('resize', onResize);
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize);
      clearTimeout(draftTimer);
    });

    onMounted(load);

    return {
      me, isManager, list, pagedList, total, page, size, loading, saving, uploading,
      keyword, category, status, now, readMap, current, detailVisible, detailHtml,
      detailAttachments, previewAttachments, editAttachments,
      editVisible, previewVisible, editingId, form, autosaveTip, auditVisible, auditList,
      CATEGORY_MAP, AUDIT_ACTION_MAP, MAX_PINNED, pinnedCount, dialogWidth,
      load, refresh, onPage, openDetail, openCreate, openEdit, onEditClosed, onAttach, removeAttach,
      saveDraft, publish, togglePin, removeOne, openAudit,
      summaryOf, isRead,       statusText, statusClassOf, fmtDate, sanitizeHtml, Refresh, Plus
    };
  }
};
