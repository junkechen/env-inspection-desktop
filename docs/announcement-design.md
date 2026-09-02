# 公告栏模块设计说明 & 自动升级可行性评估

版本：v1.0　｜　日期：2026-08-29　｜　适用：`env_inspection_desktop`（Electron 22.3.27 + Vue3 + ElementPlus）

---

## 一、模块概述

为桌面端新增公告栏模块，管理员可发布/编辑/删除/置顶公告，普通用户仅可查看。公告同时出现在**首页仪表盘顶部**与**侧边栏「公告栏」菜单**中。

### 新增/改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `app/js/announcement.js` | 新增 | 数据模型 + 纯业务逻辑（无 DOM/网络依赖，可单测） |
| `app/js/richtext.js` | 新增 | 自研轻量富文本编辑器组件（零新增依赖） |
| `app/js/views/announcements.js` | 新增 | 公告栏页面（列表/详情/编辑/预览/审计） |
| `app/js/api.js` | 改动 | 新增公告数据访问层（CRUD/已读/审计/自动归档） |
| `app/js/permission.js` | 改动 | 新增 `canManageAnnouncement` |
| `app/js/image_utils.js` | 改动 | 新增 `resolveHtmlImages`（富文本内 cloud:// 图片解析） |
| `app/js/views/dashboard.js` | 改动 | 首页公告栏卡片 + 公告预览弹窗 |
| `app/js/app.js` | 改动 | 菜单项与路由注册 |
| `app/css/style.css` | 改动 | 公告样式 + 富文本样式 + 移动端适配 |
| `test/announcement.test.mjs` | 新增 | 22 项逻辑单测 |
| `test/views.smoke.test.mjs` | 新增 | 8 项视图冒烟测试 |

---

## 二、⚠️ 上线前必做：创建云端集合

公告数据存放在 CloudBase 的 `announcement` 集合。**该集合目前不存在，且云端函数无法自动创建**（实测 `createCollection` 返回「未知操作」），必须人工在控制台创建，否则发布会报错。

### 操作步骤

1. 登录腾讯云控制台 → **云开发 CloudBase**
2. 选择环境：`anuanbu1-1-6gjqaydwd067dbb1`
3. 左侧菜单 → **数据库**
4. 点击「**新建集合**」，集合名称填：`announcement`（单数，注意不是 announcements）
5. 权限建议：选择「**仅管理端可写，所有人可读**」或自定义安全规则

> 集合未创建时的表现：`query` 会静默返回空列表（界面显示"暂无公告"），而发布/保存会失败。
> 代码已做翻译处理，此时会明确提示："保存失败：云端 announcement 集合尚未创建……"，不会出现难以定位的原始报错（`添加失败，未返回ID`）。

---

## 三、数据模型

采用**单集合 + docType 区分**的设计，因此只需创建 1 个集合即可支撑公告、已读记录、审计日志三类数据。

### 3.1 公告文档（docType = `announcement`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `docType` | string | 固定 `announcement` |
| `title` | string | 公告标题（必填，≤80 字） |
| `content` | string | 富文本正文（HTML，入库前经消毒白名单） |
| `category` | string | **分类字段（预留）**：`notice` 通知公告 / `regulation` 制度规范 / `safety` 安全警示 / `training` 培训活动 / `holiday` 节假日安排 / `other` 其他 |
| `status` | string | `draft` 草稿 / `published` 已发布 / `archived` 已归档 |
| `expireAt` | string | **过期时间字段（预留）**，ISO 字符串；留空表示长期有效 |
| `pinned` | boolean | 是否置顶 |
| `pinnedAt` | string | 置顶时间，用于置顶区内部排序 |
| `publishedAt` | string | 发布时间 |
| `attachments` | string[] | 图片附件 URL 列表（最多 9 张，自动压缩） |
| `authorId` / `authorName` | string | 发布人 |
| `createdAt` / `updatedAt` | string | 创建/更新时间 |
| `isDeleted` | boolean | 软删除标记（云端无 remove 动作） |
| `archivedAt` / `deletedAt` / `deletedBy` | string | 归档/删除审计信息 |

### 3.2 已读记录（docType = `read`）

`{ docType:'read', announcementId, userId, userName, readAt }`

**设计考量**：一条 (公告, 用户) 对应一个独立文档，而不是在公告上维护 `readBy` 数组。原因是后者需要「读-改-写」，多人同时阅读时后写会覆盖先写、导致已读记录丢失；新增文档则无此竞态。查询侧借助云端支持的 `$in` 一次取回整批公告的已读数据，不会增加请求轮次。

### 3.3 审计日志（docType = `audit`）

`{ docType:'audit', announcementId, action, operatorId, operatorName, detail, createdAt }`

覆盖动作：新建 / 编辑 / 发布 / 转为草稿 / 置顶 / 取消置顶 / 删除 / 自动归档 / 恢复。

---

## 四、权限矩阵

| 操作 | 管理员 | 检查员 | 整改负责人 | 督查员 | 只读查看员 |
|---|:--:|:--:|:--:|:--:|:--:|
| 查看已发布公告 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 查看草稿/已归档/已过期 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 发布 / 编辑 / 删除 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 置顶 / 取消置顶 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 查看操作审计日志 | ✅ | ❌ | ❌ | ❌ | ❌ |

- 判定函数：`permission.js` 的 `canManageAnnouncement(user)`，**严格 `role === 'admin'`**
- 前端按钮按权限显隐；同时 `visibleAnnouncements()` 在数据层二次过滤，不依赖 UI 显隐作为唯一闸口

---

## 五、功能实现对照

| 需求 | 实现 | 位置 |
|---|---|---|
| 发布/编辑/删除/置顶，权限限于管理员 | ✅ | `announcements.js` + `canManageAnnouncement` |
| 首页与侧边栏展示 | ✅ 首页顶部公告栏卡片 + 侧边栏菜单 | `dashboard.js` / `app.js` |
| 区分「已发布」与「草稿」 | ✅ 状态标签 + 管理员可按状态筛选 | `announcement.js` |
| 分类字段（预留） | ✅ `category`，6 个预置分类 | `CATEGORY_MAP` |
| 过期时间字段（预留） | ✅ `expireAt`，留空长期有效 | `isExpired()` |
| 富文本与图片附件 | ✅ 自研编辑器 + 独立附件区（自动压缩，最多 9 张） | `richtext.js` |
| 置顶数量上限及排序规则 | ✅ 上限 3；置顶优先→置顶内按置顶时间倒序→其余按发布时间倒序 | `MAX_PINNED` / `sortAnnouncements()` |
| 过期自动隐藏或归档 | ✅ 到点自动转为「已归档」+ 取消置顶 + 写审计日志，普通用户不可见 | `collectExpiredForArchive()` |
| 阅读量统计与已读/未读标记 | ✅ 已读人数去重统计 + 未读红点 | `readStats()` |
| 草稿自动保存 | ✅ 编辑时 800ms 防抖写入 localStorage，重开提示恢复，7 天失效 | `draftKey()` / `parseDraft()` |
| 操作审计日志 | ✅ 抽屉时间轴展示 | `announcementAudits()` |
| 移动端兼容展示 | ✅ 窄屏卡片纵向堆叠、弹窗 96% 宽、触摸友好 | `style.css` @media |
| 搜索与筛选 | ✅ 关键词（标题+正文）、分类、状态 | `filterAnnouncements()` |
| 发布前预览 | ✅ 独立预览弹窗，按真实展示效果渲染 | `previewVisible` |
| 自动升级新版本 | ❌ 见第六节评估 | — |

---

## 六、自动升级功能可行性评估

### 6.1 结论先行

**当前形态（portable 单文件 EXE）下无法直接内置自动升级。** 建议分阶段实施：先做「新版本检测 + 升级提示」（低成本、零风险），再视需要决定是否改造为 NSIS 安装版。

### 6.2 关键约束（均已核实）

| 约束 | 依据 |
|---|---|
| **portable 目标不支持自动更新** | electron-builder 官方明确列出可自动更新目标为：macOS DMG、Linux AppImage/DEB/RPM、**Windows 仅 NSIS**。本项目 `package.json` 的 `win.target` 为 `["portable"]`，不在支持范围内 |
| **Electron 版本被锁定在 22.3.27** | 为兼容 Win7 而降级（Electron 23+ 起放弃 Win7）。任何升级方案都不得破坏这一点 |
| **打包产物 63MB 单文件** | 全量替换下载成本高，差量更新在自研方案下需自行实现 |
| **暂无现成的更新源** | 云端是云函数 API 网关，非文件托管；自动升级需要一个可公开访问的版本清单与安装包存放位置 |

### 6.3 三个方案对比

#### 方案 A：新版本检测 + 升级提示（**推荐先做**）

启动时请求一个版本清单（如 `https://<静态托管>/version.json`），与本地版本比对，若有新版则弹窗提示并引导下载。

- **改动量**：约 60 行（`main.js` + 一个清单文件）
- **优点**：不动打包形态、不影响 Win7 兼容性、无二进制自替换风险；解决了"用户不知道有新版本"这个核心痛点
- **缺点**：需用户手动下载安装
- **前置条件**：需要一个可托放 `version.json` 与新版本 EXE 的位置（CloudBase 静态托管 / 对象存储 / GitHub Releases 均可）

#### 方案 B：改为 NSIS 安装版 + electron-updater（真正的自动更新）

把 `win.target` 从 `portable` 改为 `nsis`，引入 `electron-updater`。

- **改动量**：中等（打包配置 + 约 30 行接入代码 + 更新源托管）
- **优点**：官方方案成熟，支持差量更新、灰度发布、下载进度
- **缺点**：
  1. **交付形态改变**：从「拷贝即用」的单文件 EXE 变为需要安装的程序，与现有分发习惯冲突
  2. 需验证 electron-updater 与 Electron 22 的组合，以及 Win7 上的安装/更新行为
  3. 未代码签名的安装包在 Win7/Win10 上会触发 SmartScreen 警告
- **前置条件**：更新源（GitHub Releases 或自建 generic HTTP 服务器）

#### 方案 C：保留 portable，自研可写目录覆盖更新器

让 `main.js` 优先读取用户可写目录（如 `%APPDATA%\GZ环保巡查\app\`）里的前端文件，不存在时回退到包内文件；更新时把新文件下载到可写目录再重启。

- **改动量**：较大（目录优先级改造 + 清单/校验 + 原子替换 + 回滚）
- **优点**：保持单文件便携体验
- **缺点**：自研更新器最易出问题的地方是「更新中断导致应用损坏」，必须实现原子替换与失败回滚，测试成本高

### 6.4 建议路线

1. **立即做**：方案 A —— 提供版本清单与提示，先解决信息触达问题
2. **观察后再定**：若确实需要无人值守的自动更新，再评估方案 B（需接受改为安装版）或方案 C（需接受较高开发与测试成本）

> 无论选哪个方案，都需要先确定**更新源托管位置**。这是本项目的外部依赖，代码侧无法自行解决。

---

## 七、安全设计

- **富文本 XSS 防护**：公告正文以 `v-html` 渲染，是典型 XSS 入口。采用白名单标签 + 白名单属性 + URL 协议校验的消毒器（`sanitizeHtml`），覆盖 `<script>` 整块移除、`on*` 事件属性剔除、`javascript:`/`data:text/html` 协议拒绝、含 `url()`/`expression()` 的 `style` 整体丢弃等场景
- **双重消毒**：保存入库前消毒一次，渲染展示前再消毒一次（纵深防御）
- **粘贴拦截**：从网页/Word 粘贴的富文本会先消毒再插入，并剔除 base64 图片（避免数 MB 的 base64 撑爆文档）
- **权限双层校验**：UI 按钮显隐 + 数据层过滤，不以前端显隐为唯一依据

---

## 八、已知限制

1. **新建公告时审计日志可能缺失**：云端 `add` 动作不回传 `_id`（实测如此），因此"新建公告"这一条日志无法关联到具体公告，代码会跳过写入。编辑、置顶、删除等能拿到 id 的操作不受影响。若后续云函数补充返回 `_id`，此限制自动解除。
2. **云端无硬删除**：`remove` 动作不存在，删除为软删除（`isDeleted:true`），数据在库中保留。
3. **云端无批量更新**：`updateMany` 不存在，自动归档等批量操作按条执行；公告量级下无性能问题。
4. **审计日志由客户端写入**：与项目现有架构一致（所有数据均由客户端直连云函数），非防篡改设计。若需强审计，应在云函数侧实现。

---

## 九、测试情况

全部测试通过，共 **130 项断言，0 失败**：

| 测试文件 | 结果 |
|---|---|
| `test/announcement.test.mjs` | 22 通过 / 0 失败 |
| `test/api.test.mjs` | 14 通过 / 0 失败 |
| `test/permission.test.mjs` | 45 通过 / 0 失败 |
| `test/stats_utils.test.mjs` | 18 通过 / 0 失败 |
| `test/export.test.mjs` | 10 通过 / 0 失败 |
| `test/views.smoke.test.mjs` | 8 通过 / 0 失败 |
| `test/image_utils.test.mjs` | 5 通过 / 0 失败 |
| `test/server.test.js` | 8 通过 / 0 失败 |

`views.smoke.test.mjs` 在 node 侧用模拟的 Vue/ElementPlus 全局真实导入全部视图模块，并自动校验模板引用的变量是否都在 `setup()` 返回值中——用于拦截"模板引用了未暴露的函数"这类最常见的运行期崩溃。

> 说明：本环境无法启动 Electron GUI，功能验证以单元测试、模块导入冒烟测试与模板绑定校验为准。建议在 Win7 目标机上做一次实机验收（重点：富文本编辑、图片插入、置顶上限提示）。
