// 自动更新（渲染进程侧逻辑）：检查版本、下载、触发主进程自替换重启。
// 分发渠道：把 version.json 与带版本号的 EXE（如 GZ环保巡查管理系统_v1.0.1.exe）
// 作为 GitHub Release 资产上传；程序读取 update_config.json 的 versionUrl
// （指向 <release>/latest/download/version.json）获取最新版本与下载地址。

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
    releasePage: cfg.releasePage
  };
}

// 弹窗确认并下载应用。主进程下载完成后会生成更新脚本并退出重启。
export async function promptAndUpdate(result) {
  const { ElMessageBox, ElMessage } = window.ElementPlus || {};
  const info = result.info || {};
  const notes = info.notes ? '\n\n更新内容：' + info.notes : '';
  try {
    await ElMessageBox.confirm(
      `发现新版本 v${info.version}（当前 v${result.current}）。${notes}\n\n是否立即更新并重启？`,
      '发现新版本',
      { confirmButtonText: '立即更新', cancelButtonText: '稍后', type: 'info' }
    );
  } catch (e) {
    return { skipped: true };
  }
  if (ElMessage) ElMessage.info('正在下载更新…');
  const dl = await API.downloadFile({ url: info.exeUrl, fileName: info.exeName });
  if (dl.error) {
    if (ElMessage) ElMessage.error('下载失败：' + dl.error);
    return { error: dl.error };
  }
  if (ElMessage) ElMessage.info('下载完成，即将重启更新…');
  await API.applyUpdate({ tmpExe: dl.dest, exeName: info.exeName });
  return { applied: true }; // 主进程会退出并重启
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
