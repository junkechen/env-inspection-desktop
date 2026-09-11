// 更新检查（渲染进程侧逻辑）：仅检查版本并提示，不下载、不自替换。
// 弱化版：去掉"联网下载 EXE + PowerShell 静默替换自己"的行为，避免被 360 等
// 杀软误判为木马下载器/自我改写。发现新版本时仅弹窗引导用户去浏览器下载。
// 分发渠道：把 version.json 与带版本号的 EXE 作为 GitHub Release 资产上传；
// 程序读取 update_config.json 的 versionUrl（指向 <release>/latest/download/version.json）
// 获取最新版本、下载地址与发行页。

const API = window.electronAPI;

let startupChecked = false;

export function parseVersion(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : [0, 0, 0];
}

export function isNewer(latest, current) {
  const x = parseVersion(latest), y = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

// 拉取远端版本信息并对比。返回 { current, latest, info, hasUpdate, releasePage, error }
export async function fetchLatest(opts) {
  opts = opts || {};
  const current = (await API.getAppVersion()) || '0.0.0';
  const cfg = await API.getUpdateConfig();
  if (!cfg || !cfg.versionUrl) return { current, error: 'no-version-url' };
  const res = await API.fetchText({ url: cfg.versionUrl, timeout: opts.timeout || 15000 });
  if (res.error) return { current, error: res.error };
  let info;
  try {
    info = JSON.parse(res.text);
  } catch (e) {
    return { current, error: 'bad-json' };
  }
  return {
    current,
    latest: info.version,
    info,
    hasUpdate: isNewer(info.version, current),
    releasePage: cfg.releasePage || info.releasePage || info.exeUrl
  };
}

// 发现新版本时弹窗引导用户前往下载页（由主进程用浏览器打开，不在程序内下载/自替换）。
export async function promptAndUpdate(result) {
  const { ElMessageBox } = window.ElementPlus || {};
  const info = result.info || {};
  const notes = info.notes ? '\n\n更新内容：' + info.notes : '';
  const page = result.releasePage || info.exeUrl;
  try {
    await ElMessageBox.confirm(
      `发现新版本 v${info.version}（当前 v${result.current}）。${notes}\n\n点击下方按钮在浏览器中打开下载页，关闭本程序后运行新版本即可完成更新。`,
      '发现新版本',
      { confirmButtonText: '前往下载', cancelButtonText: '稍后', type: 'info' }
    );
    if (page) await API.openExternal(page);
  } catch (e) {
    return { skipped: true };
  }
  return { opened: true };
}

// 启动后静默检查一次（整个进程生命周期内仅一次）
export async function silentStartupCheck() {
  if (startupChecked) return;
  startupChecked = true;
  try {
    const r = await fetchLatest();
    if (!r.error && r.hasUpdate) await promptAndUpdate(r);
  } catch (e) {
    // 静默失败：网络异常、无权限等都不影响正常使用
  }
}
