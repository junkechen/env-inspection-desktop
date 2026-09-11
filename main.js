// GZ环保巡查管理系统 - 桌面客户端（Electron）
//
// 设计要点：
// 1. 内置零依赖静态服务器（见 static_server.js），把 app/ 目录托管在 127.0.0.1 随机端口。
//    原因：网页端使用 ES Module（<script type="module">），file:// 协议下浏览器会拦截模块加载，
//    必须用 http:// 提供资源。
// 2. BrowserWindow 加载 http://127.0.0.1:PORT/ ，网页端业务代码（app/js）零改动。
// 3. 安全：nodeIntegration=false + contextIsolation=true，渲染进程不暴露 Node 能力。
// 4. 前端依赖（Vue/ElementPlus/echarts 等）已本地化到 app/vendor，离线可用、首屏更快。
// 5. 退出时关闭本地服务器。

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const { startStaticServer } = require('./static_server');

const APP_ROOT = path.join(__dirname, 'app');

// 日志文件延迟到 app ready 后初始化：app.getPath 必须在 app ready 之后调用，
// 否则在部分系统上会抛错导致主进程直接崩溃、窗口永不显示。
let LOG_FILE = null;
let rendererCrashedOnce = false;

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (!LOG_FILE) {
    try { LOG_FILE = path.join(app.getPath('userData'), 'desktop-client.log'); } catch (e) { return; }
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('write log failed', e);
  }
}

// ============================================================
// Windows 7/8 兼容性
// Electron 23 起彻底放弃 Windows 7/8/8.1 支持（Chromium 内核无法初始化）。
// 当前锁定的 Electron 22 是最后一个支持 Win7 的版本。但即便如此，Win7 上的
// GPU/D3D11 合成仍不稳定，需强制软件渲染并关闭沙箱，否则窗口渲染进程起不来，
// 表现为「任务管理器有进程、但窗口不显示」。
// ============================================================
function isLegacyWindows() {
  try {
    const parts = (os.release() || '').split('.');
    const major = parseInt(parts[0], 10) || 0;
    const minor = parseInt(parts[1], 10) || 0;
    // 6.0=Vista, 6.1=Win7, 6.2/6.3=Win8/8.1；10.0=Win10/11
    return major < 10 && (major < 6 || (major === 6 && minor <= 3));
  } catch (e) {
    return false;
  }
}

if (isLegacyWindows()) {
  app.commandLine.appendSwitch('--disable-gpu');
  app.commandLine.appendSwitch('--disable-gpu-compositing');
  app.commandLine.appendSwitch('--disable-d3d11');
  app.commandLine.appendSwitch('--no-sandbox');
  app.disableHardwareAcceleration();
  // 记录一次到临时目录，便于在 Win7 上排查（此时 app.getPath 尚不可用）
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), 'gz_env_win7_compat.log'),
      `[${new Date().toISOString()}] legacy windows detected (${os.release()}), applied gpu/sandbox workarounds\n`
    );
  } catch (e) { /* ignore */ }
}

let mainWindow = null;
let staticServer = null;

async function createWindow() {
  log('APP', `starting, __dirname=${__dirname}, APP_ROOT=${APP_ROOT}`);

  const { server, port } = await startStaticServer(APP_ROOT);
  staticServer = server;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'GZ环保巡查管理系统',
    backgroundColor: '#0f1c17',
    show: false, // 等加载完成再显示，避免白屏闪烁
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // 允许本地页面向云函数网关跨域请求（网关已开启 CORS）
      preload: path.join(__dirname, 'preload.js') // 暴露 window.electronAPI（文件导出等本地能力）
    }
  });

  mainWindow.removeMenu();

  // 显示时机：优先用 ready-to-show（窗口首次可渲染即触发，比 did-finish-load 更可靠）。
  // 再加 8 秒兜底强制显示，防止极端情况下事件不触发导致窗口永远不出现
  // （典型如 Win7 渲染进程早期崩溃时 did-finish-load 不会触发）。
  let shown = false;
  const doShow = () => {
    if (mainWindow && !shown) { shown = true; mainWindow.show(); }
  };
  mainWindow.once('ready-to-show', () => {
    log('RENDER', 'ready-to-show');
    doShow();
  });
  const forceShowTimer = setTimeout(() => {
    log('RENDER', 'force-show fallback (ready-to-show not fired within 8s)');
    doShow();
  }, 8000);
  mainWindow.once('show', () => clearTimeout(forceShowTimer));

  // 加载失败、控制台报错、进程崩溃等全部落日志
  mainWindow.webContents.on('did-finish-load', () => {
    log('RENDER', 'page did-finish-load');
    mainWindow.setTitle('GZ环保巡查管理系统 · 桌面客户端');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log('RENDER', `did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('RENDER', `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    // 渲染进程异常崩溃（非主动关闭）时，给一次自动重载机会，避免窗口卡在黑屏
    if (mainWindow && details.reason && details.reason !== 'clean-exit' && !rendererCrashedOnce) {
      rendererCrashedOnce = true;
      log('RENDER', 'attempting one reload after render crash');
      try { mainWindow.webContents.reload(); } catch (e) { /* ignore */ }
    }
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelText = ['debug', 'info', 'warn', 'error'][level] || String(level);
    log('CONSOLE', `[${levelText}] ${sourceId}:${line} ${message}`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    log('RENDER', 'page unresponsive');
  });

  // 打开调试快捷键（Ctrl+Shift+I），并自动打开 DevTools 便于首次排查
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  const url = `http://127.0.0.1:${port}/`;
  log('APP', `loading ${url}`);
  await mainWindow.loadURL(url);
  // 默认不自动打开 DevTools；如需排查，按 Ctrl+Shift+I 打开

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================
// 导出能力：原生「另存为」对话框 + 本地写入 + PDF 打印
// 渲染进程（网页）只负责拼数据，文件落盘与弹窗都在主进程完成。
// ============================================================

// 保存二进制文件（buffer 为 ArrayBuffer / Uint8Array，经 IPC 结构化克隆传入）
ipcMain.handle('app:save-buffer', async (_event, { ext, defaultName, buffer }) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: defaultName || `export.${ext}`,
      filters: [{ name: (ext || '').toUpperCase() + ' 文件', extensions: [String(ext || 'bin').replace(/^\./, '')] }]
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, Buffer.from(buffer));
    log('EXPORT', `saved buffer -> ${filePath} (${Buffer.from(buffer).length} bytes)`);
    return { canceled: false, filePath };
  } catch (e) {
    log('EXPORT', `save-buffer error: ${e && e.message}`);
    return { error: e && e.message ? e.message : String(e) };
  }
});

// 由 HTML 字符串生成 PDF（利用内置 Chromium 渲染 + 系统字体，无需嵌入中文字体）
ipcMain.handle('app:export-pdf', async (_event, { defaultName, html, landscape }) => {
  let win = null;
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出 PDF',
      defaultPath: defaultName || 'export.pdf',
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { canceled: true };

    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { webSecurity: false, contextIsolation: true, nodeIntegration: false }
    });

    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html || '');
    await win.loadURL(dataUrl);

    // 等待页面中的图片（远程照片）加载完成再打印，避免 PDF 空白图；最多等 5 秒
    try {
      await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const imgs = Array.from(document.images);
        if (!imgs.length) return resolve(true);
        let pending = imgs.length;
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(true); } };
        imgs.forEach((img) => {
          if (img.complete) { if (--pending === 0) finish(); }
          else {
            img.addEventListener('load', () => { if (--pending === 0) finish(); });
            img.addEventListener('error', () => { if (--pending === 0) finish(); });
          }
        });
        setTimeout(finish, 5000);
      })`);
    } catch (e) {
      log('EXPORT', `pdf wait-images warn: ${e && e.message}`);
    }

    const buf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: !!landscape,
      marginsType: 1, // 无边距（由 HTML body margin 控制），避免 margins 对象触发 pageSize 校验错误
      pageSize: 'A4'
    });
    fs.writeFileSync(filePath, Buffer.from(buf));
    log('EXPORT', `saved pdf -> ${filePath} (${Buffer.from(buf).length} bytes)`);
    return { canceled: false, filePath };
  } catch (e) {
    log('EXPORT', `export-pdf error: ${e && e.message}`);
    return { error: e && e.message ? e.message : String(e) };
  } finally {
    if (win) { try { win.destroy(); } catch (e) {} }
  }
});

// Win10/Win7 兜底：旧系统 Chromium 无法验证云存储证书链（Win11 正常），
// 导致隐藏在 el-image / v-html <img> 里的公告图片加载失败。
// 这里由 Node 主进程直接下载图片（忽略证书错误），以 data URL 回传渲染进程，
// 彻底绕开 Chromium 的证书/TLS 策略。Node 的 http.get 不会自动跟随重定向，
// 而云存储临时 URL 偶尔 301/302 跳转到 CDN，故这里手动跟随（最多 4 次）。
// 仅 Electron 端使用，Web 端走浏览器原生加载。
ipcMain.handle('app:fetch-image-url', (_event, { url }) => {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      resolve({ error: 'invalid url: ' + (typeof url) + ' ' + (url ? url.toString().slice(0, 80) : 'empty') });
      return;
    }
    let redirects = 0;
    let finished = false;
    const done = (v) => { if (!finished) { finished = true; resolve(v); } };
    const fetchOnce = (target) => {
      const lib = target.toLowerCase().startsWith('https') ? https : http;
      let inner = false;
      const innerDone = (v) => { if (!inner) { inner = true; done(v); } };
      const req = lib.get(target, { rejectUnauthorized: false, timeout: 30000 }, (res) => {
        const status = res.statusCode || 0;
        // 跟随重定向（云存储临时 URL 偶尔 301/302 到 CDN，浏览器会自动跟随但 Node 不会）
        if (status >= 300 && status < 400 && res.headers.location && redirects < 4) {
          redirects++;
          res.resume();
          log('IMG', `redirect ${status} ${target} -> ${res.headers.location}`);
          try { fetchOnce(new URL(res.headers.location, target).href); } catch (e) { innerDone({ error: 'redirect error: ' + e.message }); }
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume(); // 消费掉响应体，避免 socket 泄漏
          innerDone({ error: 'status ' + status });
          return;
        }
        const ct = (res.headers && res.headers['content-type']) || 'image/jpeg';
        if (!/^image\//i.test(ct)) {
          res.resume();
          innerDone({ error: 'not image, content-type=' + ct });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            innerDone({ dataUrl: 'data:' + ct + ';base64,' + buf.toString('base64') });
          } catch (e) {
            innerDone({ error: e && e.message });
          }
        });
      });
      req.on('error', (e) => { log('IMG', `fetch error ${target}: ${e && e.message}`); innerDone({ error: e && e.message }); });
      req.setTimeout(30000, () => { try { req.destroy(); } catch (e) {} innerDone({ error: 'timeout' }); });
    };
    fetchOnce(url);
  });
});

// ============================================================
// 自动更新（基于 Git / Release 分发）
// 渲染进程读取 update_config.json 的 versionUrl（指向 GitHub Release latest 的
// version.json），对比本地版本；若有新版，下载 EXE 并生成 PowerShell 更新脚本，
// 待本进程退出后替换文件并重启。
// ============================================================
function httpsGetText(u, timeoutMs, redirects) {
  timeoutMs = timeoutMs || 15000;
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const lib = u.toLowerCase().startsWith('https') ? https : http;
    const req = lib.get(u, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        httpsGetText(next, timeoutMs, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) { res.resume(); reject(new Error('status ' + status)); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) {} reject(new Error('timeout')); });
  });
}

function httpsDownload(u, dest, timeoutMs, redirects) {
  timeoutMs = timeoutMs || 120000;
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const lib = u.toLowerCase().startsWith('https') ? https : http;
    const req = lib.get(u, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        httpsDownload(next, dest, timeoutMs, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) { res.resume(); reject(new Error('status ' + status)); return; }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (e) => { try { fs.unlinkSync(dest); } catch (e2) {} reject(e); });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) {} reject(new Error('timeout')); });
  });
}

ipcMain.handle('app:get-app-version', () => {
  try { return app.getVersion(); } catch (e) { return '1.0.1'; }
});

ipcMain.handle('app:get-update-config', () => {
  try {
    const cfgPath = path.join(__dirname, 'app', 'update_config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    return { versionUrl: '', releasePage: '' };
  }
});

ipcMain.handle('app:fetch-text', async (_event, { url, timeout }) => {
  try { return { text: await httpsGetText(url, timeout || 15000) }; }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});

// 弱化更新：仅用系统默认浏览器打开下载页，不在程序内下载/自替换，避免被杀软误判。
ipcMain.handle('app:open-external', async (_event, url) => {
  try {
    if (!url || typeof url !== 'string') return { error: 'invalid-url' };
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
});

app.whenReady().then(() => {
  // 部分 Win10 系统缺少 CloudBase 存储域名 (*.tcb.qcloud.la) 的根证书更新，
  // Chromium 会报证书错误导致图片加载失败（Win11 通常已包含最新根证书）。
  // 这里仅对公告/隐患中使用的腾讯云存储域名放宽证书校验，其他域名保持系统默认。
  try {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const host = request.hostname || '';
      if (host.endsWith('.tcb.qcloud.la') || host.endsWith('.qcloud.la') || host.endsWith('.qcloud.com')) {
        callback(0); // 0 = 验证通过
      } else {
        callback(-3); // -3 = 使用系统默认验证结果
      }
    });
    log('APP', 'setCertificateVerifyProc for tcb.qcloud.la applied');
  } catch (e) {
    log('APP', 'setCertificateVerifyProc error: ' + (e && e.message));
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (staticServer) { try { staticServer.close(); } catch (e) {} staticServer = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
