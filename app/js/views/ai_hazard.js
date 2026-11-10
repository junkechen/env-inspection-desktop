import { api, STATUS_MAP, SEVERITY_MAP } from '../api.js';
import { store } from '../store.js';
import { uploadFiles, fileToBase64, compressImage } from '../image_upload.js';
import { isAdmin, canCreate } from '../permission.js';
import { businessOptions, deptOf, visibleBizCodes, businessesForDept } from '../business.js';
import { currentDept, categoryOptions } from '../dept.js';

// AI 隐患识别：与 APK ai_hazard_service.dart 同协议。
// 网关对请求体限制约 100KB，base64 有 ~33% 膨胀，故图片压缩到 50KB 以内、最多 1 张。
// 返回 analysis：{ hasHazard, title, category(中文), businessType, severity(中文), description, riskPoints[], suggestion, confidence }
const SEV_ZH2EN = { '一般': 'general', '较大': 'serious', '重大': 'critical' };

function fmtDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }

export default {
  template: `
  <div>
    <h2 class="page-title neon-title">AI 隐患识别</h2>
    <p class="page-sub">上传 / 粘贴现场照片，AI 智能研判隐患并一键转为正式上报 · 与移动端同源</p>

    <div class="card" style="min-width:0;margin-bottom:18px">
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
        <!-- 左侧：图片与操作 -->
        <div style="flex:1 1 320px;min-width:280px">
          <div
            class="ai-drop"
            :class="{ over: dragOver }"
            @dragover.prevent="dragOver=true"
            @dragleave.prevent="dragOver=false"
            @drop.prevent="onDrop"
            style="border:1.5px dashed var(--c-border);border-radius:10px;padding:18px;text-align:center;cursor:pointer;background:rgba(255,255,255,.02)"
            @click="pickFile">
            <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onPick" />
            <div v-if="previewUrl" style="position:relative;display:inline-block">
              <img :src="previewUrl" style="max-width:100%;max-height:280px;border-radius:8px;border:1px solid var(--c-border)" />
            </div>
            <div v-else style="color:var(--c-text-soft);padding:30px 0">
              <div style="font-size:40px">📷</div>
              <div>点击上传 / 拖拽图片到此处</div>
              <div style="font-size:12px;margin-top:6px">也可点击下方「从剪贴板粘贴」</div>
            </div>
          </div>
          <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
            <el-button :icon="Upload" @click="pickFile">选择图片</el-button>
            <el-button :icon="DocumentCopy" :loading="pasting" @click="pasteFromClipboard">从剪贴板粘贴</el-button>
            <el-button v-if="previewUrl" :icon="Delete" type="danger" plain @click="clearImage">清除</el-button>
          </div>
          <div style="color:var(--c-text-soft);font-size:12px;margin-top:8px">提示：最多 1 张，建议 ≤ 1MB，系统会自动压缩后上传。</div>
          <el-form label-width="70px" style="margin-top:14px">
            <el-form-item label="位置"><el-input v-model="location" placeholder="现场位置（选填）" /></el-form-item>
            <el-form-item label="备注"><el-input v-model="note" type="textarea" :rows="2" placeholder="补充描述（选填）" /></el-form-item>
          </el-form>
          <el-button type="primary" :icon="MagicStick" :loading="recognizing" :disabled="!previewUrl" style="width:100%" @click="recognize">开始 AI 识别</el-button>
        </div>

        <!-- 右侧：识别结果 -->
        <div style="flex:1 1 360px;min-width:300px">
          <div v-if="!analysis && !recognizing" style="color:var(--c-text-soft);text-align:center;padding:40px 0">
            <div style="font-size:40px">🤖</div>
            <div>上传图片并点击「开始 AI 识别」查看研判结果</div>
          </div>
          <div v-else-if="recognizing" style="color:var(--c-text-soft);text-align:center;padding:40px 0">
            <el-icon class="is-loading" style="font-size:36px"><Loading /></el-icon>
            <div style="margin-top:10px">AI 正在研判（最长约 120 秒），请稍候…</div>
          </div>
          <div v-else-if="analysis">
            <div v-if="!analysis.hasHazard" class="card" style="padding:16px;text-align:center">
              <div style="font-size:30px">✅</div>
              <div style="color:#34d399;font-weight:600;margin-top:6px">未识别出明显隐患</div>
              <div style="color:var(--c-text-soft);font-size:13px;margin-top:6px">{{ analysis.suggestion || '' }}</div>
            </div>
            <template v-else>
              <div class="card" style="padding:16px;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                  <b style="color:#fff;font-size:15px">{{ analysis.title || 'AI 识别隐患' }}</b>
                  <el-tag :type="sevType(analysis.severity)">{{ analysis.severity || '一般' }}</el-tag>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--c-text-soft);margin-bottom:10px">
                  <span>类别：<b style="color:#fff">{{ analysis.category || '—' }}</b></span>
                  <span>业务：<b style="color:#fff">{{ analysis.businessType || '—' }}</b></span>
                  <span>置信度：<b style="color:#38bdf8">{{ analysis.confidence != null ? (analysis.confidence*100).toFixed(0)+'%' : '—' }}</b></span>
                </div>
                <div style="font-size:13px;color:var(--c-text-soft);margin-bottom:8px"><b style="color:#fff">描述：</b>{{ analysis.description || '—' }}</div>
                <div v-if="analysis.riskPoints && analysis.riskPoints.length" style="margin-bottom:8px">
                  <b style="color:#fff;font-size:13px">风险点：</b>
                  <div v-for="(p,i) in analysis.riskPoints" :key="i" style="font-size:13px;color:#fca5a5;margin:2px 0">• {{ p }}</div>
                </div>
                <div style="font-size:13px;color:var(--c-text-soft)"><b style="color:#fff">整改建议：</b>{{ analysis.suggestion || '—' }}</div>
              </div>
              <el-button type="success" :icon="Promotion" :loading="converting" style="width:100%;margin-top:14px" @click="openConvert">转为正式上报</el-button>
            </template>
            <div v-if="rawText" style="margin-top:12px">
              <el-collapse>
                <el-collapse-item title="查看原始识别文本">
                  <pre style="white-space:pre-wrap;color:var(--c-text-soft);font-size:12px;max-height:200px;overflow:auto">{{ rawText }}</pre>
                </el-collapse-item>
              </el-collapse>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 转为正式上报 -->
    <el-dialog v-model="convertVisible" title="转为正式隐患上报" width="640px" :close-on-click-modal="false">
      <el-form :model="cf" label-width="100px">
        <el-form-item label="标题" required><el-input v-model="cf.title" /></el-form-item>
        <el-form-item label="业务" required>
          <el-select v-model="cf.businessType" style="width:100%" @change="onBiz">
            <el-option v-for="o in bizOpts" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="类别" required><el-select v-model="cf.category" style="width:100%"><el-option v-for="o in CATEGORY_OPTS" :key="o" :label="o" :value="o" /></el-select></el-form-item>
        <el-form-item label="等级" required><el-select v-model="cf.severity" style="width:100%"><el-option v-for="o in SEVERITY_OPTS" :key="o.value" :label="o.label" :value="o.value" /></el-select></el-form-item>
        <el-form-item label="部门" required><el-select v-model="cf.department" style="width:100%"><el-option v-for="d in depts" :key="d.name" :label="d.name" :value="d.name" /></el-select></el-form-item>
        <el-form-item label="位置"><el-input v-model="cf.location" /></el-form-item>
        <el-form-item label="整改责任人" required>
          <el-select v-model="cf.assigneeId" style="width:100%" @change="onAssignee" filterable>
            <el-option v-for="u in rectifiers" :key="u._id" :label="u.name + ' ('+ (u.department||'未分配') +')'" :value="u._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="整改期限"><el-date-picker v-model="cf.dueDate" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="描述" required><el-input v-model="cf.description" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="现场照片">
          <div v-if="cf.photos.length" style="display:flex;gap:6px;flex-wrap:wrap">
            <el-image v-for="(p,i) in cf.photos" :key="i" :src="p" style="width:60px;height:60px;border-radius:6px;border:1px solid var(--c-border)" fit="cover" />
          </div>
          <span v-else style="color:var(--c-text-soft);font-size:12px">将自动采用识别所用图片</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="convertVisible=false">取消</el-button>
        <el-button type="primary" :loading="converting" @click="submitConvert">提交上报</el-button>
      </template>
    </el-dialog>
  </div>`,
  setup() {
    const { ref, reactive, onMounted, onBeforeUnmount, computed } = Vue;
    const { ElMessage } = ElementPlus;
    const { Upload, DocumentCopy, Delete, MagicStick, Promotion, Loading } = ElementPlusIconsVue;

    const previewUrl = ref('');
    const imageFile = ref(null); // 压缩后的 File，用于上传
    const imageB64 = ref('');    // 压缩后的 base64，用于 AI 识别
    const dragOver = ref(false);
    const location = ref('');
    const note = ref('');
    const recognizing = ref(false);
    const analysis = ref(null);
    const rawText = ref('');
    const converting = ref(false);
    const pasting = ref(false);

    const convertVisible = ref(false);
    const depts = ref([]);
    const rectifiers = ref([]);
    const cf = reactive({ title: '', businessType: 'SAFE', category: '其他', severity: 'general', department: '', location: '', assigneeId: '', assigneeName: '', dueDate: '', description: '', photos: [] });

    const bizOpts = computed(() => {
      const opts = visibleBizCodes(store.user).map(code => ({ value: code, label: (businessOptions().find(o => o.value === code) || {}).label || code }));
      return opts.length ? opts : businessOptions();
    });
    const CATEGORY_OPTS = computed(() => categoryOptions(cf.businessType));
    const SEVERITY_OPTS = [
      { value: 'general', label: '一般' },
      { value: 'serious', label: '较大' },
      { value: 'critical', label: '重大' }
    ];

    function sevType(zh) {
      if (zh === '重大') return 'danger';
      if (zh === '较大') return 'warning';
      return 'info';
    }

    // 压缩图片并产出 preview/base64/file（供 AI 与上报共用）
    async function ingest(file) {
      if (!file || !file.type || !file.type.startsWith('image/')) { ElMessage.error('请选择图片文件'); return; }
      try {
        const compressed = await compressImage(file, 50);
        const b64 = await fileToBase64(compressed);
        imageB64.value = b64;
        imageFile.value = compressed;
        previewUrl.value = URL.createObjectURL(compressed);
      } catch (e) { ElMessage.error('图片处理失败：' + e.message); }
    }
    function pickFile() { fileInput.value && fileInput.value.click(); }
    function onPick(e) { const f = e.target.files && e.target.files[0]; if (f) ingest(f); e.target.value = ''; }
    function onDrop(e) { dragOver.value = false; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) ingest(f); }
    function clearImage() { previewUrl.value = ''; imageB64.value = ''; imageFile.value = null; analysis.value = null; rawText.value = ''; }
    async function pasteFromClipboard() {
      pasting.value = true;
      try {
        if (!navigator.clipboard || !navigator.clipboard.read) { ElMessage.warning('当前环境不支持剪贴板读取，请改用文件选择'); return; }
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types && item.types.find(t => t.startsWith('image/'));
          if (type) { const blob = await item.getType(type); await ingest(blob); return; }
        }
        ElMessage.warning('剪贴板中没有图片');
      } catch (e) { ElMessage.warning('读取剪贴板失败（可能缺少权限）：' + e.message); }
      finally { pasting.value = false; }
    }

    async function recognize() {
      if (!imageB64.value) { ElMessage.warning('请先上传或粘贴图片'); return; }
      recognizing.value = true;
      analysis.value = null; rawText.value = '';
      try {
        // 仅取纯 base64 data（去掉 data:... 前缀）
        const b64 = imageB64.value.split(',')[1] || imageB64.value;
        const r = await api.aiHazard([b64], { location: location.value, note: note.value });
        if (r.analysis) {
          analysis.value = r.analysis;
          rawText.value = r.raw || '';
        } else if (r.raw) {
          rawText.value = r.raw;
          ElMessage.warning('AI 返回了原始文本，未能解析为结构化结果');
        } else {
          ElMessage.warning('AI 未返回可用结果');
        }
      } catch (e) { ElMessage.error('识别失败：' + e.message); }
      finally { recognizing.value = false; }
    }

    function openConvert() {
      const a = analysis.value || {};
      const biz = a.businessType || bizOpts.value[0] && bizOpts.value[0].value || 'SAFE';
      cf.title = a.title || '';
      cf.businessType = (bizOpts.value.find(o => o.value === biz) ? biz : (bizOpts.value[0] ? bizOpts.value[0].value : 'SAFE'));
      cf.category = a.category || (categoryOptions(cf.businessType)[0] || '其他');
      cf.severity = SEV_ZH2EN[a.severity] || 'general';
      cf.location = location.value || (a.location || '');
      cf.department = depts.value[0] ? depts.value[0].name : '';
      cf.assigneeId = '';
      cf.assigneeName = '';
      cf.dueDate = '';
      cf.description = a.description || '';
      cf.photos = [];
      convertVisible.value = true;
    }
    function onBiz() { /* 类别下拉随业务级联由 computed CATEGORY_OPTS 处理 */ }
    function onAssignee(id) { const u = rectifiers.value.find(x => x._id === id); cf.assigneeName = u ? u.name : ''; }
    async function submitConvert() {
      if (!cf.title || !cf.department || !cf.description || !cf.assigneeId) { ElMessage.warning('请填写标题、部门、责任人和描述'); return; }
      converting.value = true;
      try {
        // 把识别所用图片先上传到云端，作为隐患现场照
        let photos = [];
        if (imageFile.value) {
          photos = await uploadFiles([imageFile.value], api, { targetKb: 50, maxFiles: 1 });
        }
        cf.photos = photos;
        const u = store.user || {};
        const now = new Date().toISOString();
        const biz = cf.businessType;
        await api.createHazard({
          title: cf.title,
          businessType: biz,
          deptCode: deptOf(biz) || 'JN',
          category: cf.category,
          severity: cf.severity,
          department: cf.department,
          location: cf.location,
          assigneeId: cf.assigneeId,
          assigneeName: cf.assigneeName,
          reporterId: u._id || '',
          reporterName: u.name || u.username || '',
          dueDate: cf.dueDate ? new Date(cf.dueDate).toISOString() : '',
          deadline: cf.dueDate ? new Date(cf.dueDate).toISOString() : '',
          description: cf.description,
          status: 'pending',
          photos,
          rectificationPhotos: [],
          createdAt: now,
          updatedAt: now
        });
        ElMessage.success('已转为正式上报，可在「隐患管理」查看');
        convertVisible.value = false;
        clearImage();
      } catch (e) { ElMessage.error(e.message); }
      finally { converting.value = false; }
    }

    const fileInput = ref(null);
    onMounted(async () => {
      const [d, u] = await Promise.all([api.departments(), api.users({})]);
      depts.value = d;
      rectifiers.value = (u.list || []).filter(x => x.status !== 'disabled' && !isAdmin(x));
    });

    return {
      previewUrl, dragOver, location, note, recognizing, analysis, rawText, converting, pasting,
      convertVisible, depts, rectifiers, cf, fileInput,
      bizOpts, CATEGORY_OPTS, SEVERITY_OPTS,
      sevType, pickFile, onPick, onDrop, clearImage, pasteFromClipboard, recognize, openConvert, onBiz, onAssignee, submitConvert,
      Upload, DocumentCopy, Delete, MagicStick, Promotion, Loading, STATUS_MAP, SEVERITY_MAP, canCreate
    };
  }
};
