# GZ环保巡查管理系统 · 桌面客户端

基于 Electron 把原网页端管理后台套壳为 Windows 桌面程序（EXE）。
**与手机 APP 共享同一套腾讯云 CloudBase 数据**，独立项目，不修改 APP 任何代码。

## 原理
- 网页端业务代码（Vue3 + Element Plus，位于 `app/`）**零改动**。
- `main.js` 内置一个零依赖的本地静态服务器，把 `app/` 托管在 `http://127.0.0.1:随机端口`。
  （ES Module 在 `file://` 下会被浏览器拦截，必须用 http 提供资源。）
- Electron 窗口加载该本地地址；前端直接调用云函数 HTTP 网关，登录由云端校验。
- 前端依赖（Vue、ElementPlus、图标库、echarts、中文语言包）已**本地化到 `app/vendor/`，离线可用、启动更快**。
- 打包用 `electron-builder`，产出 **portable 单文件 EXE**（双击即运行，无需安装）。

## 目录
```
env_inspection_desktop/
├── main.js            # Electron 主进程：本地静态服务器 + 窗口 + 日志
├── package.json       # 依赖与打包配置
├── app/               # 网页端静态资源（复制自 public/，独立副本）
│   ├── index.html
│   ├── css/
│   ├── js/            # api.js / app.js / router.js / store.js / views/*
│   └── vendor/        # 本地化的前端依赖（Vue/ElementPlus/echarts/图标库）
└── dist/              # 打包产物（npm run dist 后生成）
```

## 开发 / 本地运行
```bash
npm install        # 安装 electron + electron-builder（首次较慢，会下载 Chromium）
npm start          # 以开发模式启动桌面窗口
```
按 `Ctrl+Shift+I` 可打开开发者工具排错。

## 打包成 EXE
```bash
npm run dist       # 在 dist/ 生成「GZ环保巡查管理系统.exe」
```
- 默认 target = `portable`，产出单个 `.exe`，可拷贝到任何 Windows 10/11 机器直接运行。
- 运行时**不需要再拉 CDN**，前端依赖已内嵌；但仍需联网访问云函数网关。

## 登录
- 云端账号与手机 APP 完全一致（多数账号密码默认 `123456`）。
- 登录支持输入**用户名**或**姓名**；云端 `login` 走服务端校验，前端不缓存明文密码。
- 已修复原网页端用 `name` 字段登录的问题，现在同时发送 `username` + `name`。

## 排错
打包后的 EXE 启动时会**自动打开开发者工具（DevTools）**，Console 里的红字就是白屏/空白的原因。

主进程日志文件位置：
```
%APPDATA%\GZ环保巡查管理系统\desktop-client.log
```
常见空白原因：
- 本地静态服务器 404：看日志里 `404` 记录。
- JS 执行报错：看 DevTools Console。
- 云函数网关不通：看 Network 面板 `/api` 请求是否失败。

## 安全提示
- 桌面端登录走云端 `login` 校验，本身不缓存明文密码。
- 若要彻底杜绝「公开 query 返回明文密码」的隐患，仍需在云函数侧部署加固版（按 Origin 脱敏）。
- 更换云函数网关地址：改 `app/js/api.js` 顶部的 `GW` 常量。
