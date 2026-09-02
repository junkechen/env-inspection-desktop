// 自研轻量富文本编辑器（Vue 组件）
// 选型理由：项目 vendor 里没有任何编辑器，新增 Quill 等依赖会带来约 200KB 体积
// 与 Win7 渲染验证成本；公告场景只需标题/加粗/列表/链接/图片，contenteditable +
// execCommand 足以覆盖，且零依赖、离线可用、Electron22(Chromium 108) 下稳定。
//
// 两个易踩的坑（已处理，勿改）：
//  1. 工具栏按钮点击会抢走焦点 → 选区丢失，execCommand 作用到空选区。
//     解法：按钮加 @mousedown.prevent，阻止默认聚焦行为。
//  2. 打开链接输入框/图片选择框同样会丢选区 → 先 saveRange()，完成后 restoreRange()。
import { uploadFiles } from './image_upload.js';
import { sanitizeHtml } from './announcement.js';
import { api } from './api.js';
import { resolveImageUrl } from './image_utils.js';

const { ref, watch, onMounted, onBeforeUnmount } = Vue;

// 粘贴内容消毒：先过白名单，再剔除 data: 图片
// （粘贴的 base64 图片动辄数 MB，直接入库会撑爆文档，且难以清理）
function sanitizePaste(html) {
  let s = sanitizeHtml(html);
  s = s.replace(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*data:[^"']*["'][^>]*>/gi, '');
  return s;
}

export default {
  name: 'RichTextEditor',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '请输入公告正文…' },
    disabled: { type: Boolean, default: false },
    minHeight: { type: String, default: '240px' }
  },
  emits: ['update:modelValue'],
  template: `
  <div class="rte" :class="{ 'is-disabled': disabled }">
    <div class="rte-bar">
      <button type="button" class="rte-btn" title="二级标题" @mousedown.prevent @click="block('h2')">H2</button>
      <button type="button" class="rte-btn" title="三级标题" @mousedown.prevent @click="block('h3')">H3</button>
      <button type="button" class="rte-btn" title="正文" @mousedown.prevent @click="block('p')">正文</button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" title="加粗" @mousedown.prevent @click="exec('bold')"><b>B</b></button>
      <button type="button" class="rte-btn" title="斜体" @mousedown.prevent @click="exec('italic')"><i>I</i></button>
      <button type="button" class="rte-btn" title="下划线" @mousedown.prevent @click="exec('underline')"><u>U</u></button>
      <button type="button" class="rte-btn" title="删除线" @mousedown.prevent @click="exec('strikeThrough')"><s>S</s></button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" title="无序列表" @mousedown.prevent @click="exec('insertUnorderedList')">• 列表</button>
      <button type="button" class="rte-btn" title="有序列表" @mousedown.prevent @click="exec('insertOrderedList')">1. 列表</button>
      <span class="rte-sep"></span>
      <button type="button" class="rte-btn" title="插入链接" @mousedown.prevent @click="insertLink">🔗 链接</button>
      <button type="button" class="rte-btn" title="插入图片" :disabled="uploading" @mousedown.prevent @click="pickImage">
        {{ uploading ? '上传中…' : '🖼 图片' }}
      </button>
      <button type="button" class="rte-btn" title="清除格式" @mousedown.prevent @click="clearFormat">🧹 清除</button>
      <span class="rte-sep"></span>
      <span class="rte-count">{{ textLen }} 字</span>
    </div>
    <div class="rte-body" ref="ed" contenteditable="true" :data-placeholder="placeholder"
         :style="{ minHeight: minHeight }" @input="onInput" @paste="onPaste" @blur="onInput"></div>
    <input ref="fileEl" type="file" accept="image/*" style="display:none" @change="onFile" />
  </div>`,
  setup(props, { emit }) {
    const ed = ref(null);
    const fileEl = ref(null);
    const uploading = ref(false);
    const textLen = ref(0);
    let savedRange = null;
    let internalUpdate = false; // 标记自身引起的变更，避免 watch 回写导致光标跳到开头

    function syncLen() {
      const el = ed.value;
      if (!el) return;
      textLen.value = (el.innerText || '').replace(/\s+/g, '').length;
    }

    function onInput() {
      const el = ed.value;
      if (!el) return;
      internalUpdate = true;
      emit('update:modelValue', el.innerHTML);
      syncLen();
      // watch 是同步触发的，这里立刻复位标记
      internalUpdate = false;
    }

    function exec(cmd, val) {
      if (props.disabled) return;
      const el = ed.value;
      if (el) el.focus();
      try { document.execCommand(cmd, false, val); } catch (e) { /* 个别命令在空选区会抛错，忽略 */ }
      onInput();
    }

    function block(tag) {
      // formatBlock 在部分浏览器要求 <h2> 形式，这里兼容两种
      try {
        document.execCommand('formatBlock', false, tag);
      } catch (e) {
        try { document.execCommand('formatBlock', false, '<' + tag + '>'); } catch (e2) { /* ignore */ }
      }
      onInput();
    }

    function clearFormat() {
      try {
        document.execCommand('removeFormat', false, null);
        document.execCommand('formatBlock', false, 'p');
      } catch (e) { /* ignore */ }
      onInput();
    }

    function saveRange() {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
    }
    function restoreRange() {
      const el = ed.value;
      if (!el || !savedRange) return;
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }

    async function insertLink() {
      if (props.disabled) return;
      saveRange();
      let url = '';
      try {
        const r = await ElementPlus.ElMessageBox.prompt('请输入链接地址（http/https）', '插入链接', {
          inputPattern: /^(https?:\/\/|mailto:).+/i,
          inputErrorMessage: '请输入以 http:// 或 https:// 开头的合法地址',
          confirmButtonText: '插入',
          cancelButtonText: '取消'
        });
        url = r && r.value ? String(r.value).trim() : '';
      } catch (e) { return; } // 用户取消
      if (!url) return;
      restoreRange();
      exec('createLink', url);
    }

    function pickImage() {
      if (props.disabled || uploading.value) return;
      saveRange();
      if (fileEl.value) fileEl.value.click();
    }

    async function onFile(e) {
      const files = e && e.target && e.target.files;
      if (!files || !files.length) return;
      uploading.value = true;
      try {
        const urls = await uploadFiles(files, api, { maxFiles: 9 });
        restoreRange();
        for (const raw of urls) {
          // 云存储返回的多为 cloud:// fileID，浏览器无法直接加载，需刷新为临时 https
          const u = await resolveImageUrl(raw);
          try { document.execCommand('insertImage', false, u); } catch (err) { /* ignore */ }
        }
        onInput();
        if (urls.length) ElementPlus.ElMessage.success('已插入 ' + urls.length + ' 张图片');
      } catch (err) {
        ElementPlus.ElMessage.error((err && err.message) || '图片上传失败');
      } finally {
        uploading.value = false;
        if (fileEl.value) fileEl.value.value = ''; // 允许再次选择同一文件
      }
    }

    function onPaste(e) {
      // 拦截粘贴：剥掉外站样式与脚本，避免把 Word/网页的脏 HTML 或 XSS 带进公告正文
      const cd = e && e.clipboardData;
      if (!cd) return;
      const html = cd.getData('text/html');
      if (!html) return; // 纯文本走浏览器默认行为即可
      e.preventDefault();
      const clean = sanitizePaste(html);
      try {
        document.execCommand('insertHTML', false, clean);
      } catch (err) {
        // 兜底：插入纯文本
        const txt = cd.getData('text/plain') || '';
        document.execCommand('insertText', false, txt);
      }
      onInput();
    }

    watch(() => props.modelValue, (v) => {
      const el = ed.value;
      if (!el) return;
      if (internalUpdate) return;
      // 仅当外部值与编辑器当前内容不一致时才回写，避免打断输入与光标位置
      const next = v || '';
      if (el.innerHTML !== next) el.innerHTML = next;
      syncLen();
    });

    onMounted(() => {
      const el = ed.value;
      if (!el) return;
      el.innerHTML = props.modelValue || '';
      // 关闭 styleWithCSS：让加粗产出 <b> 而不是 <span style="font-weight:bold">，
      // 生成的 HTML 更短，也更利于消毒白名单保留
      try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* ignore */ }
      syncLen();
    });

    onBeforeUnmount(() => { savedRange = null; });

    return {
      ed, fileEl, uploading, textLen,
      exec, block, clearFormat, insertLink, pickImage, onFile, onPaste, onInput
    };
  }
};
