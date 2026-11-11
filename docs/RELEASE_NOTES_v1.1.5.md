# dsh-plugin-deepseek-chat v1.1.5 发布说明

**DeepSeek Harness（DSH）桌面版「DeepSeek 聊天」插件 —— 功能迭代版：移除账号状态、会话顶栏标签页、设置页、网页铺满会话区、插件基础信息与「检查更新」按钮。**

本次是把 v1.1.2 之后在本地迭代、此前未单独发版的 **v1.1.3 / v1.1.4 / v1.1.5** 三个版本一次性发布为 `1.1.5`。它**不是崩溃修复版**：v1.1.2 已修复的 web boot 启动失败（`duplicate factory registration`）在本版中保持修复状态，工厂 id 与包名一致性的回归断言依然保留；本版聚焦的是界面与功能迭代。

## Requires（环境要求）

| 项 | 要求 |
|---|---|
| DSH Desktop | `>= 0.2.2-rc.1`（含 `0.2.2-rc.1`） |
| Node.js | `>= 20` |
| 平台 | Windows / macOS / Linux 桌面壳 |

## 版本更迭（1.1.2 → 1.1.5）

npm registry 上此前最后发布的是 `1.1.2`；`1.1.3`、`1.1.4`、`1.1.5` 均只存在于本地，未推送到 npm。本版把三者的改动合并发布：

### v1.1.3 —— 移除账号状态显示，新增会话顶栏标签页

- **彻底移除账号状态条**：删掉面板顶部「账号状态不可用，会话按本地模式保存」状态条，以及背后的账号同步 store、5 秒轮询、账号探测、`ctx.on("connection/reset")` 订阅。面板挂载即申请 guest 租约、立即启动，不再等待任何异步账号流程。纯网页聊天，主内容区只留 `<webview>`。
- **新增会话顶栏标签页**：通过官方 `conversation.view` 槽（`id: deepseek-chat-view`、`order: 100`）在「对话 / 轨迹 / 上下文 / 压缩 / 编队 / 统计」那一行加入标签，与左侧栏图标入口并存、共用同一个网页聊天组件与同一个固定分区 `panel:deepseek-chat`。
- **注册健壮性**：旧的 main / sidebar.panellist 两处 `ctx.slots.inject` 从「同一个 try/catch」改为各处独立 try/catch，避免单点失败连带其它入口不注册。

### v1.1.4 —— 设置页、标签页可配置、网页铺满会话区、灰色占位提示

- **新增设置页**：通过官方 `settings.section` 槽注册「DeepSeek 聊天」设置页（左侧「设置」弹窗导航里，`id: deepseek-chat-settings`、`order: 48`），沿用 localStorage 配置范式（键 `dsh-plugin-deepseek-chat:config`）。
  - **显示顶部标签栏**（`showTab`，默认 `true`）：关闭后移除 `conversation.view` 注册，只保留左侧栏图标 + 全屏主面板入口。
  - **顶部标签栏名称**（`tabLabel`，默认 `DeepSeek 聊天`）：可自定义，留空自动回退默认，最长 40 字。
  - 标签行只在注册项增删时重算，因此改开关 / 改名会 `dispose` 后重新 `inject("conversation.view", ...)`，即时生效。
- **网页铺满会话区（图3 修复）**：选中顶栏标签时，网页现在撑满整个会话区、盖住 DSH 自己的对话消息与底部输入框；切回「对话」标签即恢复。根因是 `viewArea` 与 `composerSeat` 是上下并列兄弟、active 阶段 `viewArea` 为 `flex:1 0 auto` 导致 `height:100%` 无确定父高；顶栏入口改用不透明绝对定位浮层（`inset:0`、`z-index:50`）覆盖会话 body，header 里的标签行仍在上方、随时可点回。
- **灰色占位提示（打磨）**：名称输入框默认为空白，仅以灰色 placeholder 显示默认名；点击输入框即可直接输入新名字，无需先删默认文字；清空后恢复灰提示。组件内用本地 `draft` state 实现，配置层零改动，默认标签名仍是「DeepSeek 聊天」。
- 图2 红框（网页内自带的「DSH认证失败修复」会话标题胶囊）经用户确认「先不处理」——那是 chat.deepseek.com 网页内部元素，插件不注入样式隐藏、不改第三方网页。

### v1.1.5 —— 关于本插件 + 检查更新

- **基础信息区块**：设置页展示插件版本号（`1.1.5`）、作者（`sweet560`）、功能简介、开源许可证（`MIT`），以及 npm 插件页面 / GitHub 仓库两个 `https` 外链（`target="_blank"`，由桌面壳用系统浏览器打开）。这些值以模块级常量保存（client bundle 不能 import package.json），并由离线自检逐字段断言与 `package.json` 一致。
- **「检查更新」按钮**：点击后从公开 JSON 接口读取最新发布版本号，**npm 优先、GitHub 兜底**：
  - npm：`https://registry.npmjs.org/-/package/@tianyulinfeng1%2fdsh-plugin-deepseek-chat/dist-tags`（取 `latest`）；
  - GitHub：`https://raw.githubusercontent.com/sweet560/dsh-plugin-deepseek-chat/main/package.json`（取 `version`，避开 `api.github.com` 的限流）。
  两处都带宽松 CORS、主窗口未设置 `connect-src` CSP 限制，因此直接用 renderer 的 `fetch()` 即可，**不新增 Host 同源回环路由**、`lib/index.js` 空宿主半侧保持不变。每个请求带 8 秒 `AbortController` 超时。
- **版本比较用数字逐段比较**（`compareVersion()`），不用字符串相等：本地尚未发版的 `1.1.5` 会领先已发布的 `latest`（发布前实测为 `1.1.2`），此时显示「已是最新版本」而非误报有更新；仅当远端版本更高才显示「发现新版本」。
- **文字状态 + 跳转链接**：状态行显示「点击按钮… / 正在检查更新… / 已是最新版本 / 发现新版本 x.y.z / 检查更新失败：原因」，并在检查结束后附带 npm / GitHub 跳转链接。检查中按钮禁用且忽略重复点击；网络不可用、两个来源都失败、没有可用 fetch 时都给出失败兜底，异常不外泄。

## 关于 v1.1.2 的 web boot 崩溃（历史，保持已修复）

v1.1.2 的发布说明 `docs/RELEASE_NOTES_v1.1.2.md` 已完整记录崩溃日志 `crash-2026-11-09T08-27-01-314Z-web-boot.log` 的逐条根因：`package.json` 的 `name` 是带 scope 的 `@tianyulinfeng1/dsh-plugin-deepseek-chat`，而当时 `lib/client.js` 里 `window.__ModuleLoader__.load({ id })` 的工厂 id 仍是旧短名 `dsh-plugin-deepseek-chat`；DSH Host 以包名作图行 id，检查 `factories.has(<行 id>)` 为 false 便重复执行同一 bundle，第二遍注册短名工厂时抛出 `client-modules: duplicate factory registration for "dsh-plugin-deepseek-chat"`，最终 `web boot: 1 entry did not activate`、整个页面打不开。v1.1.2 把工厂 id 对齐为完整包名并新增回归断言。

**本版 `1.1.5` 的工厂 id 仍为 `@tianyulinfeng1/dsh-plugin-deepseek-chat`、与 `package.json` 的 `name` 完全一致**，`test/check-client.mjs` 中「工厂 id 必须等于包名」的断言继续通过，该回归不会被重新引入。本版没有改动这一修复，也没有出现新的崩溃日志。

## What changed（逐文件改动，相对 npm 上的 1.1.2）

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 移除账号状态条与账号同步 store；新增 `conversation.view` 顶栏标签注册；新增 `settings.section` 设置页与 localStorage 配置层（`showTab` / `tabLabel`）；顶栏入口改用绝对定位浮层铺满会话区；新增「关于本插件」基础信息、`checkForUpdates` / `fetchLatestVersion` / `compareVersion` / `versionFromPayload` 等；名称输入框改灰色 placeholder + 本地 `draft` state。工厂 id 保持不变。 |
| `test/check-client.mjs` | 全文重写为中文输出：删账号用例，新增四处槽位注册、配置层、设置页联动、顶栏浮层、基础信息常量一致性、语义版本比较、载荷解析、npm/GitHub 兜底、检查更新各分支与设置页点击联动等断言；mock fetch 覆盖全部网络分支。 |
| `package.json` | `version` `1.1.2` → `1.1.5`；description 同步；`files` 新增本发布说明。 |
| `locale/zh.json` / `locale/en.json` | description 同步（设置页 / 顶栏标签 / 基础信息 / 检查更新 / 无账号状态）。 |
| `CHANGELOG.md` | 新增 `1.1.5`、`1.1.4`、`1.1.3` 章节。 |
| `README.md` / `README.en.md` | 当前版本 v1.1.5；功能 / 使用 / 版本历史 / 开发 / 目录树同步三轮改动。 |
| `docs/login-persistence.md` | 注明 v1.1.3 起彻底移除账号状态条 / 探测 / 轮询 / 同步 store。 |
| `docs/RELEASE_NOTES_v1.1.5.md` | 本文件，完整发布说明。 |
| `lib/index.js` / `.github/workflows/*` / `cordis.patch.yml` | 未改动：空宿主半侧、CI、bundle patch 保持原样。 |

## Verification（验证结果）

- `node --check lib/client.js` → 通过（`NODE_CHECK_OK`）。
- `npm test` → 全部通过（`RESULT: PASS`），含工厂 id === 包名、四处槽位注册、配置层与设置页联动、顶栏浮层样式、基础信息常量与 package.json 一致、语义版本比较、更新载荷解析、npm/GitHub 兜底、检查更新各状态分支、以及全部 guest 租约生命周期回归用例。
- `git diff --check` → 通过。
- `npm pack --dry-run` / `npm pack` → 打包清单包含 `lib/`、`locale/`、发布说明、README、CHANGELOG、LICENSE、icon、patch 等；`package.json` 的 `version` 为 `1.1.5`。

## Upgrade（如何升级）

> 建议先退出 DSH 桌面版再升级，升级完成后重新启动。已从 v1.1.2（或更早版本）安装的，直接覆盖安装即可；也可先 `remove` 再 `add`。

### 方式一：npm（推荐）

```powershell
dsh plugin --profile desktop remove @tianyulinfeng1/dsh-plugin-deepseek-chat
dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat
```

插件页「安装第三方插件」里也可以直接填包名 `@tianyulinfeng1/dsh-plugin-deepseek-chat`（会拉取最新版本 `1.1.5`）。

### 方式二：GitHub

```powershell
dsh plugin --profile desktop add github:sweet560/dsh-plugin-deepseek-chat
```

### 方式三：Gitee 镜像

```powershell
dsh plugin --profile desktop add https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat
```

### 方式四：本地 tgz / 目录

```powershell
dsh plugin --profile desktop add file:"<dsh-plugin-deepseek-chat-1.1.5.tgz 的绝对路径>"
```

装完打开 **插件 → 已安装插件**，确认「DeepSeek 聊天」处于启用状态，并确认版本显示为 `1.1.5`；在左侧「设置」弹窗里可找到「DeepSeek 聊天」设置页。

## Assets（发布产物）

- `dsh-plugin-deepseek-chat-1.1.5.tgz` —— 完整可安装的 npm / bundle 包（沿用 v1.1.1 起的 Release 附件命名；`npm pack` 对 scoped 包的原生输出名为 `tianyulinfeng1-dsh-plugin-deepseek-chat-1.1.5.tgz`）。
- `Source code (zip / tar.gz)` —— 由 GitHub / Gitee 自动生成的源码归档。

## Honest limitation（诚实限制）

沿用既有源码结论：**纯插件无法让 `chat.deepseek.com` 复用 DSH 已登录的账号、做不到免扫码**。DSH 桌面版用的是 platform.deepseek.com 的 `x-dsh-auth-token`，网页版用的是站点自带的 Token；渲染层桥 `globalThis.dshDesktop` 没有读 token / 写 cookie / 打开 Platform 取 token 的 API，归档里也没有 SSO 或 cookie 注入入口。因此首次仍需在网页里扫码登录一次。可选的「持久分区补丁」（见 [login-persistence.md](login-persistence.md)）只能让这次登录的 cookie 在重启 DSH 后保留，并不能把 DSH token 兑换成网页登录态。

此外：纯 Web 表层（`dsh web` 在浏览器里打开）自动不注册——该站点 `frame-ancestors 'none'`，iframe 嵌不了，guest 租约桥也只有桌面壳提供。
