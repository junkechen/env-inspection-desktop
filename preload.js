// 预加载脚本：以 contextIsolation 模式安全地向渲染进程暴露本地能力。
// 渲染进程通过 window.electronAPI 调用；所有文件写入/弹窗都在主进程完成，
// 渲染进程（网页代码）不直接接触 Node / fs，保持 contextIsolation 安全边界。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 保存二进制文件（如生成的 xlsx buffer）。payload: { ext, defaultName, buffer }
  // 返回 { canceled, filePath } 或 { error }
  saveBuffer: (payload) => ipcRenderer.invoke('app:save-buffer', payload),

  // 保存 xlsx 并在主进程做排版增强 + 图片内嵌注入。
  // payload: { defaultName, buffer, plan }；注入失败时自动退回原始 xlsx，保证一定有文件产出。
  saveXlsxEnhanced: (payload) => ipcRenderer.invoke('app:save-xlsx-enhanced', payload),

  // 由 HTML 字符串生成 PDF 并保存。payload: { defaultName, html, landscape }
  // 返回 { canceled, filePath } 或 { error }
  exportPdf: (payload) => ipcRenderer.invoke('app:export-pdf', payload),

  // 导出结果弹窗「打开所在文件夹」：在系统文件管理器中定位已导出的文件。
  // 对应移动端系统分享面板的等价动作；返回 { ok } 或 { error }。
  showItemInFolder: (filePath) => ipcRenderer.invoke('app:show-item-in-folder', filePath),

  // Win10/Win7 图片兜底：主进程下载图片（忽略证书错误）并返回 data URL，
  // 绕开 Chromium 证书/TLS 限制。调用方可直接传 URL 字符串或 { url } 对象。
  fetchImageUrl: (payload) => {
    const args = typeof payload === 'string' ? { url: payload } : payload;
    return ipcRenderer.invoke('app:fetch-image-url', args);
  },

  // 更新检查相关能力（主进程完成网络读取与打开浏览器；不在程序内下载/自替换）
  getAppVersion: () => ipcRenderer.invoke('app:get-app-version'),
  getUpdateConfig: () => ipcRenderer.invoke('app:get-update-config'),
  fetchText: (payload) => ipcRenderer.invoke('app:fetch-text', payload),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url)
});
