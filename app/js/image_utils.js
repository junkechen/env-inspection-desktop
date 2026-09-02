// 图片 URL 解析工具：把 cloud:// fileID 刷新为临时 HTTPS URL，与 APK 行为一致。
// 结果按 fileID 做内存缓存，避免同一张图片反复请求云函数。
import { api } from './api.js';

const cache = new Map(); // cloud://fileID -> { url, ts }
const CACHE_TTL = 2 * 60 * 1000; // 临时 URL 签名可能过期，缓存 2 分钟

function isCloudFile(url) {
  return typeof url === 'string' && url.startsWith('cloud://');
}

export async function resolveImageUrl(url, force = false) {
  if (!url) return url;
  if (!isCloudFile(url)) return url; // http(s) 或本地路径原样返回
  const now = Date.now();
  const cached = cache.get(url);
  if (!force && cached && (now - cached.ts) < CACHE_TTL) return cached.url;
  try {
    const resolved = await api.getFileUrl(url);
    if (resolved && /^https?:\/\//.test(resolved)) {
      cache.set(url, { url: resolved, ts: now });
      return resolved;
    }
  } catch (e) {
    console.warn('[image] resolve failed:', url, e && e.message);
  }
  // 失败但缓存仍在且未严重过期，先返回旧缓存避免 UI 空链
  if (cached && (now - cached.ts) < CACHE_TTL * 3) return cached.url;
  return url; // 失败时返回原值，避免 UI 出现空链
}

// 批量解析对象内所有照片字段（photos / rectificationPhotos / rectificationHistory[].photos）
export async function resolveIssuePhotos(issue) {
  if (!issue) return issue;
  const tasks = [];

  const resolveArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const u = arr[i];
      if (isCloudFile(u)) {
        tasks.push((async () => { arr[i] = await resolveImageUrl(u); })());
      }
    }
  };

  resolveArray(issue.photos);
  resolveArray(issue.rectificationPhotos);
  if (Array.isArray(issue.rectificationHistory)) {
    issue.rectificationHistory.forEach(r => resolveArray(r.photos));
  }

  await Promise.all(tasks);
  return issue;
}

// 解析富文本 HTML 中的 cloud:// 图片地址为可访问的 https 地址。
// 用于公告正文（v-html 渲染）里内联的 <img>，否则浏览器无法加载 cloud:// 协议。
// Electron 端会进一步将 https 经主进程下载为 data URL，绕开 Win10 的证书/TLS 限制。
export async function resolveHtmlImages(html) {
  if (!html || typeof html !== 'string') return html;
  const srcs = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const s = m[1];
    if ((isCloudFile(s) || /^https?:\/\//i.test(s)) && srcs.indexOf(s) < 0) srcs.push(s);
  }
  if (!srcs.length) return html;
  const electronApi = (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.fetchImageUrl)
    ? window.electronAPI : null;
  const pairs = await Promise.all(srcs.map(async (s) => {
    let to = await resolveImageUrl(s); // cloud:// -> https
    if (electronApi && to && typeof to === 'string' && /^https?:\/\//i.test(to.trim())) {
      const u = to.trim();
      try {
        let r = await electronApi.fetchImageUrl(u);
        if (r && r.dataUrl) {
          to = r.dataUrl;
        } else if (r && r.error && String(r.error).includes('403') && isCloudFile(s)) {
          // 签名过期：强制刷新临时 URL 后重试一次
          console.log('[正文图片代理] 403 刷新签名:', s);
          const fresh = await resolveImageUrl(s, true);
          if (fresh && fresh !== u) {
            r = await electronApi.fetchImageUrl(fresh);
            if (r && r.dataUrl) to = r.dataUrl;
            else if (r && r.error) console.error('[正文图片代理失败]', fresh, '->', r.error);
          }
        } else if (r && r.error) {
          console.error('[正文图片代理失败]', u, '->', r.error);
        }
      } catch (e) { console.error('[正文图片代理异常]', u, e && e.message); }
    }
    return [s, to];
  }));
  let out = html;
  for (const [from, to] of pairs) {
    if (to && to !== from) {
      // 把该地址的所有出现位置替换掉
      out = out.split(from).join(to);
    }
  }
  return out;
}

// 批量解析 issue 列表内所有照片（用于导出）
export async function resolveIssuesPhotos(issues) {
  if (!Array.isArray(issues)) return issues;
  await Promise.all(issues.map(resolveIssuePhotos));
  return issues;
}
