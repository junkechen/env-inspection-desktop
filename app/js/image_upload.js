// 图片上传工具：对齐 APK 的压缩与上传行为
// - 自动把图片压缩到目标大小以内（默认 50KB，与 APK 一致）
// - 输出统一为 JPEG
// - 上传前校验格式与大小
// - 支持批量，最多 9 张（APK 上限）

const DEFAULT_TARGET_KB = 50;
const DEFAULT_MAX_FILES = 9;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 原图不能超过 5MB

export async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 用 canvas 把图片压缩到 targetKb 以内；逐级降低 quality 和分辨率
export async function compressImage(file, targetKb = DEFAULT_TARGET_KB) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let width = img.width;
      let height = img.height;

      const encode = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        // 先填白色背景，避免 png 透明变黑色
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        let quality = 0.85;
        const step = () => {
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          const sizeKb = (dataUrl.length * 0.75) / 1024;
          if (sizeKb <= targetKb || quality <= 0.2) {
            // dataUrl -> File
            const byteString = atob(dataUrl.split(',')[1]);
            const ab = new ArrayBuffer(byteString.length);
            const ia = new Uint8Array(ab);
            for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
            const blob = new Blob([ab], { type: 'image/jpeg' });
            const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
            resolve(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
            return;
          }
          quality -= 0.12;
          // quality 降到 0.5 还超，则同步降低分辨率再试
          if (quality <= 0.5 && (width > 400 || height > 300)) {
            width = Math.max(400, Math.round(width * 0.7));
            height = Math.max(300, Math.round(height * 0.7));
            encode();
          } else {
            step();
          }
        };
        step();
      };
      encode();
    };
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = url;
  });
}

function isImage(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext);
}

export async function uploadFiles(files, api, { targetKb = DEFAULT_TARGET_KB, maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!files || !files.length) return [];
  if (files.length > maxFiles) throw new Error(`最多上传 ${maxFiles} 张图片`);
  const urls = [];
  for (const file of files) {
    if (!isImage(file)) throw new Error(`${file.name || '文件'} 不是图片`);
    if (file.size > maxBytes) throw new Error(`图片 ${file.name} 过大（>5MB）`);
    const compressed = await compressImage(file, targetKb);
    const b64 = await fileToBase64(compressed);
    const r = await api.upload(compressed.name, b64);
    // 优先使用 cloud:// fileID（永久引用），避免存储「有效期有限的临时 URL」。
    // 临时 URL 过期后，移动端打开公告/隐患图片会显示「图片加载失败」。
    // 电脑端渲染时会用 resolveImageUrl 把 cloud:// 刷新为临时 https，移动端同理。
    urls.push(r.fileId || r.url);
  }
  return urls;
}
