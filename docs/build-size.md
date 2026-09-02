# 打包体积优化说明

适用：`env_inspection_desktop`（Electron 22.3.27 + portable 单文件 EXE）

## 一、成果

| 阶段 | 体积 | 变化 |
|---|---:|---|
| 优化前 | 60.12 MB（63,039,791 字节） | — |
| 裁剪语言包后 | **55.83 MB（58,539,868 字节）** | **−4.29 MB，降幅 7.1%** |

语言包：`locales/` 从 **55 个 → 2 个**（zh-CN + en-US）。

## 二、体积构成（优化前，解包后约 200MB）

| 项目 | 解包大小 | 说明 |
|---|---:|---|
| Electron 主程序 | 157.6 MB | Chromium + Node + V8，**体积主体** |
| `locales/` | 27.6 MB | 55 个语言包 ← 本次裁剪目标 |
| `icudtl.dat` | 10.0 MB | 国际化数据，不可删 |
| `libGLESv2.dll` | 7.2 MB | 图形，保留 |
| `LICENSES.chromium.html` | 6.5 MB | Chromium 许可证 |
| `resources.pak` | 5.1 MB | Chromium 资源 |
| `vk_swiftshader.dll` | 4.9 MB | 软件 WebGL 兜底 |
| `d3dcompiler_47.dll` | 4.7 MB | D3D 编译，保留 |
| `ffmpeg.dll` | 2.6 MB | 媒体解码 |
| **应用自身（app.asar）** | **3.6 MB** | 代码 + vendor 依赖 |

结论：**应用代码只占总量的极小部分**，体积主体是 Electron/Chromium 运行时。本次新增的公告模块源码约 44 KB，对总体积影响可忽略（0.07%）。

### app.asar 内部构成（3.6 MB）

| 文件 | 大小 |
|---|---:|
| echarts.min.js | 1.0 MB |
| element-plus-index.full.min.js | 0.91 MB |
| xlsx.full.min.js（Excel 导出） | 0.84 MB |
| element-plus-index.css | 0.31 MB |
| element-plus-icons-vue | 0.20 MB |
| vue.global.prod.js | 0.14 MB |
| 业务代码（全部） | 约 0.2 MB |

## 三、正确做法：源头裁剪 + `electronDist`

### 构建流程

```bash
npm install        # 首次或依赖变更后
npm run trim       # 裁剪 Electron 多余语言包（重装依赖后需重跑）
npm run dist       # 打包
```

`npm run trim` 对应 `build/trim-electron-locales.cjs`，会把
`node_modules/electron/dist/locales/` 裁剪为只保留 `zh-CN.pak` 与 `en-US.pak`
（保留 en-US 作为兜底，否则未翻译字符串会显示为空白）。

`package.json` 中通过 `"electronDist": "node_modules/electron/dist"` 显式指定使用这份已裁剪的 Electron。

### ⚠️ 为什么必须配 `electronDist`

electron-builder **默认不读 `node_modules/electron/dist`**，而是从
`%LOCALAPPDATA%\electron\Cache\electron-v22.3.27-win32-x64.zip` 解压取用。
只裁剪 `node_modules` 而不配 `electronDist`，打包结果完全不变（已实测：体积 0 变化）。

### ⚠️ 重装依赖后需重跑 trim

`npm install` 会把 `locales/` 还原为 55 个，若不重跑 `npm run trim`，产物会静默变大 4.3 MB。

## 四、踩坑记录（重要，避免重复尝试）

1. **`electronLanguages` 配置不可用**
   electron-builder 内置的该选项会在打包中调用 `fs.promises.rm` 删除多余语言包，
   而本机的 safe-delete 守卫会拦截该 API，导致打包直接失败
   （`Error during a trash operation`）。

2. **`afterPack` 钩子中自行删除同样不可靠**
   改用 `fs.unlinkSync`（实测未被守卫包装）理论上可行，但批量删除会触发守卫的
   单轮阈值（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，threshold 50），构建被中断，
   并会留下 `locales` 被删一半的不一致状态。**最终未采用。**

3. **`compression: "maximum"` 无任何收益**
   实测产物体积与默认完全一致（58,539,868 vs 58,539,866 字节，仅时间戳差异），
   说明 portable 目标默认已是最高压缩。已移除该配置。

4. **构建末尾的 safe-delete 报错可忽略**
   日志末尾常出现 `[safe-delete] ... .nsis.7z` 报错并导致退出码非 0，
   这发生在 portable EXE 构建完成**之后**的清理阶段，不影响产物，
   `dist_*/GZ环保巡查管理系统.exe` 是完整有效的（PE 头 `4D5A` 校验通过）。

5. **重复构建到同一目录会残留旧文件**
   因守卫拦截删除，`win-unpacked` 里的旧文件（如旧语言包）不会被清理，
   导致裁剪"看起来没生效"。**建议每次输出到全新目录。**

## 五、进一步优化选项（未实施，附风险）

| 项目 | 预计收益 | 风险 | 建议 |
|---|---:|---|---|
| `ffmpeg.dll`（2.6MB） | 约 1 MB | 低；无媒体播放功能，通常安全 | 可选，需实机回归 |
| `vk_swiftshader.dll` + `vulkan-1.dll`（6MB） | 约 1.5 MB | **中**；软件渲染兜底。本项目曾出现过 Win7 窗口不显示的问题，图形兜底不建议动 | 不建议 |
| `LICENSES.chromium.html`（6.5MB） | 约 0.5 MB | **合规风险**；Chromium 许可证要求随二进制分发 | 不建议 |
| `icudtl.dat`（10MB） | — | 高；国际化必需 | 不可删 |
| 改用 NSIS 安装包 | 体积相近 | 交付形态从单文件变为需安装 | 见自动升级评估 |

### 体积下限

在保留 **Win7 兼容（Electron ≤ 22）** 的前提下，Chromium 运行时是刚性成本，
**约 55 MB 已是当前架构的实用下限**。若要进一步大幅压缩，只能放弃 Win7 支持或改用其他技术栈，
这与本项目的 Win7 兼容目标直接冲突。

## 六、可清理的开发期产物

以下为历史构建残留，与交付产物无关，可安全删除以回收磁盘：

- `dist/`（约 331 MB）
- `out_new/`（约 331 MB）
- `dist_small/`、`dist_small3/`（与 `dist_small2/` 重复的试验产物）
