# dsh-plugin-deepseek-chat

[English](README.en.md) | 中文

> **当前版本：v1.1.1** ｜适配 DSH **0.2.2-rc.1**

在 **DeepSeek Harness（DSH）桌面版**的左侧栏加入 **DeepSeek 聊天** 入口，点开后 `chat.deepseek.com` 直接占满主内容区，记住上次所在的会话，并显示当前 DSH 账号状态。

> 仓库：[GitHub](https://github.com/sweet560/dsh-plugin-deepseek-chat) ｜ [Gitee 镜像](https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat)

![面板截图](docs/screenshot.png)

## 功能

- 左侧栏图标入口，排在「插件」和「自动化任务」之间。
- 主内容区全宽内嵌 `https://chat.deepseek.com/`（Electron `<webview>`，走桌面壳的 guest 租约桥 `window.dshDesktop.browser`）。
- **记住上次会话**：切到别的面板、切换会话、重启 App 后再进来，直接回到上次那条对话，而不是新对话。
- 登录/鉴权页不会覆盖记忆；记住的会话失效或打不开时自动回退到首页。
- **稳定的登录会话（v1.1.1 修复）**：guest 分区固定为 `panel:deepseek-chat`，切换面板/会话回来不会重建分区、不会重新要求扫码。
- **DSH 账号状态展示**：面板顶部条显示「已与 DSH 登录账号同步 · 昵称」/「未登录」/「账号状态不可用」，通过官方 `ctx.remote.account` 读取；**仅作展示，绝不参与 guest 生命周期**。
- **崩溃隔离**：内嵌页进程退出、被销毁或启动超时，只在面板里显示「重试」，不会再出现整个 App 变空白窗口的问题（v0.4.0 修复，见下文）。
- 纯 Web 表层（`dsh web` 在浏览器里打开）自动不注册——该站点 `frame-ancestors 'none'`，iframe 嵌不了，guest 租约桥也只有桌面壳提供。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | 桌面版 `0.2.2-rc.1` 或更新 |
| 平台 | Windows / macOS / Linux 桌面壳 |
| git | 仅「GitHub 安装」方式需要（pnpm 通过 git 拉取仓库） |

## 安装

npm 包名：**`@tianyulinfeng1/dsh-plugin-deepseek-chat`**（GitHub 仓库名仍是 `dsh-plugin-deepseek-chat`）。

### 方式一：npm（推荐）

```powershell
dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat
```

插件页的「安装第三方插件」里也可以直接填包名 `@tianyulinfeng1/dsh-plugin-deepseek-chat`。

### 方式二：插件页安装（GitHub）

1. 打开 DSH 桌面版，左侧栏点 **插件**。
2. 点列表上方的 **安装第三方插件**。
3. 在「包名或地址」里填入：

   ```
   github:sweet560/dsh-plugin-deepseek-chat
   ```

   也可以填 `https://github.com/sweet560/dsh-plugin-deepseek-chat`。
4. 点 **安装**，等 pnpm 跑完（首次会拉取仓库并安装依赖）。
5. 安装完成后插件自动启用，左侧栏出现 **DeepSeek 聊天**。

### 方式三：命令行（GitHub）

```powershell
dsh plugin --profile desktop add github:sweet560/dsh-plugin-deepseek-chat
```

装完打开 **插件 → 已安装插件**，确认「DeepSeek 聊天」处于启用状态（命令行只负责装依赖，启用状态以插件页为准）。

### 方式四：本地目录（二次开发）

```powershell
dsh plugin --profile desktop add file:"<本仓库绝对路径>"
```

## 关于「免扫码 / 与 DSH 账号同步」的真相

**纯插件做不到让 chat.deepseek.com 直接复用 DSH 已登录的账号**，这不是实现遗漏，而是 DSH 的架构限制（已在 0.2.2-rc.1 源码中逐项核对）：

| 项 | DSH 桌面版账号 | chat.deepseek.com 网页版 |
|---|---|---|
| 凭据 | platform.deepseek.com 的 `x-dsh-auth-token`（Host-only `getPlatformSession()`） | 站点自带的 Token（`api/v0/users/current` 无 token 返回 `40002 Missing Token`） |
| 存放 | Host 进程凭据存储 | guest session 的 httpOnly cookie |
| 兑换入口 | **无**；归档中 `chat.deepseek.com` 零引用，无 SSO、无 cookie 注入 | — |

- 渲染层桥 `globalThis.dshDesktop` 只有 `browser.acquire/release/onOpenRequested` 等，**没有** `getAuthToken`、写 cookie、打开 Platform 取 token 的 API；`getAuthToken()` 只存在于桌面壳内嵌 Platform 页（`usage` / `top_up`）的专用 preload，且受主帧 + origin 限制。
- `browserAcquire` IPC 只按 workspace 字符串分配分区/租约，`configureSession()` 只设权限与下载拦截，**不注入任何凭据**；guest 被强制 `sandbox/contextIsolation/webSecurity`。
- 因此：DSH 账号状态只能**显示**在面板上，无法换成网页版登录态；首次仍需在网页里扫码一次。

**v1.1.0 的教训（v1.1.1 已修复）**：曾把 guest 分区绑到异步账号探测结果上。DSH 的 `getState()` 在重连/切会话时会瞬时失败，分区一变就等于换了个全新 cookie 罐 → 每次切回面板都要求重新扫码。现在：

- `acquire()` 的 workspace 恒为 `panel:deepseek-chat`，会话记忆 key 恒为 `dsh-plugin-deepseek-chat:last-url`；
- 账号状态变化只更新显示条，不 bump epoch、不重建 guest、不换分区；
- 瞬时 `unknown` 被忽略，只有明确的 `signed-out` 才更新显示；
- guest 在挂载时立即启动，不再等待异步 Remote 探测（探测失败也不阻塞聊天）；
- 弹窗导航只放行 `chat.deepseek.com` 与 `platform.deepseek.com`（HTTPS、默认端口）。

> 想做到「重启 DSH 后也不用重新扫码」，需要按 [docs/login-persistence.md](docs/login-persistence.md) 把 DSH 的随机内存分区改成**确定性的 `persist:` 分区**（运行 [scripts/patch-dsh-persistent-partition.cjs](scripts/patch-dsh-persistent-partition.cjs)，属修改已安装应用，风险自负）。**该脚本会同步 `0.2.2-rc.1` 的 ASAR 逐文件 SHA256 integrity**，纯字节替换会让 DSH 重启崩溃，切勿使用废弃的 `.mjs` 版本。补丁要求完全退出 DSH 后才能写入 `app.asar`，且只解决「重启后保留网页 cookie」，不能让网页复用 DSH token。

## 使用

- 第一次打开会停在 chat.deepseek.com 的登录页，登录一次即可。
- 本次 App 运行期间，切换面板/会话**不需要**重新登录（v1.1.1 起分区固定）。
- **重启 DSH 后仍需要重新登录一次**：DSH 目前给内嵌浏览器的是随机内存分区（`dsh-sidebar-browser-<uuid>`，没有 `persist:` 前缀），进程退出即清空 cookie。本插件不修改 DSH 的安装文件；想做到「登录一次、长期免登录」，可按 **[docs/login-persistence.md](docs/login-persistence.md)** 做一次等长字节替换（含脚本、验证与回滚）。
- 会话链接记在 App 的 localStorage（固定 key `dsh-plugin-deepseek-chat:last-url`），重启后仍会打开上次的会话（前提是已登录且该会话仍存在）。

## 登录态持久化（可选，免登录）

DSH 目前给内嵌浏览器分配的是**内存分区**（`dsh-sidebar-browser-${randomUUID()}`，无 `persist:` 前缀），所以每次重启 App 都会清空 cookie。想做到「登录一次、以后不再登录」，需要把桌面主进程里的那行分区名改成固定且带 `persist:` 前缀的值——两条语句**字节数相同**，可以直接在 `resources/app.asar` 里原地替换。

完整原因、脚本、验证步骤、回滚方式和各平台路径都整理在这里：

**→ [docs/login-persistence.md](docs/login-persistence.md)**

注意：这属于对已安装应用的修改，不在 DSH 支持范围内；DSH 升级会覆盖 `app.asar`，需要重新打补丁（`Partitions` 里的登录数据不会丢）。请先备份，风险自负。

## 已知限制

- chat.deepseek.com 会检测 Electron 内嵌环境，偶尔弹出「使用环境异常…建议使用官方产品」的提示；这是站点侧行为，与本插件无关。
- 仅桌面版有效；`dsh web` 在浏览器里打开时不显示入口。
- 站点若调整会话 URL 规则（当前识别 `/a/chat/s/<id>` 形式），「记住会话」可能失效并回退到首页。
- DSH 账号状态只作展示，不能把 DSH 的 OAuth token 兑换成 chat.deepseek.com 的网页会话；首次仍需在该网页登录一次（见上文）。
- `getProfile()` 只用于显示昵称；该接口暂不可用时显示状态可能短暂滞后，但**绝不影响** guest 与登录态。
- 重启 DSH 后仍需重新登录网页版 chat，除非按 [docs/login-persistence.md](docs/login-persistence.md) 打持久分区补丁。

## 崩溃隔离（v0.4.0）

早期版本出现过：点开面板、聊天页正常显示 1~2 秒后**整个 App 变成空白窗口**（只剩原生菜单和窗口按钮），没有崩溃对话框也没有 `crash-*.log`。

根因是 React 卸载面板时**先移除 DOM、后执行 effect 清理**，而 Electron 的 `<webview>` 一旦脱离文档，`getURL()` 就会抛错；DSH 把插件里任何未捕获异常都当作 `slot entry crashed in 'root'`，直接卸载 `root` slot —— 整个 App UI 因此消失。

现在的实现：

- 所有 guest 调用先判断 `element.isConnected` 再 `try/catch`，清理阶段「先读 URL、再移除元素」；
- 每个事件处理器都包 `try/catch`，异常只落在面板自己的状态里；
- 面板外包一层 React 错误边界；
- 监听 `render-process-gone` / `destroyed` / `did-fail-load`，失败时**先移除失效的 guest 元素**再显示「重试」，避免重试叠加 webview；
- 15 秒启动看门狗，guest 一直不 `dom-ready` 就转重试卡片；
- 事件监听器若注册失败则不启动 guest；弹窗 URL 走白名单校验（v1.1.0）。

## 版本历史

| 版本 | 内容 |
|---|---|
| **1.1.1** | **修复每次切回面板/重启都要重新扫码的回归**：guest 分区与会话 key 固定为常量，账号状态仅作展示、不参与 guest 生命周期；瞬时 `unknown` 被忽略；guest 不再等待异步账号探测；自检改为验证固定分区与状态抖动不重建（35 项）。明确记录「纯插件无法免扫码复用 DSH token」的源码结论。 |
| 1.1.0 | 支持 DSH `0.2.2-rc.1`：新增 DSH 账号状态条；修正生成式 Remote 信封解析；收紧会话 URL 与弹窗 URL 校验；失败时移除失效 guest。**此版把分区绑到账号状态，导致登录态抖动（已由 1.1.1 修复）**。 |
| 1.0.0 | 首个本地版本：侧栏入口、全宽内嵌聊天、会话记忆、崩溃隔离。 |

## 开发

```powershell
git clone https://github.com/sweet560/dsh-plugin-deepseek-chat.git
cd dsh-plugin-deepseek-chat
node test/check-client.mjs
```

`test/check-client.mjs` 是离线自检：在 `node:vm` 里加载 `lib/client.js`，用假的 React/DOM/租约桥验证注册、Remote 信封解析、固定分区与会话 key、状态抖动不重建 guest、切换面板复用分区、会话记忆、租约释放、弹窗白名单和崩溃隔离。

目录：

```
lib/index.js           宿主半侧（空实现，只为让 client bundle 有 Loader 入口）
lib/client.js          浏览器半侧：入口、面板、账号状态展示、webview 生命周期、崩溃隔离
cordis.patch.yml       bundle 补丁：插入本插件的 Loader 行
locale/zh.json         插件页显示名称/描述（中文）
locale/en.json         插件页显示名称/描述（英文）
icon.svg               插件页图标
docs/login-persistence.md  可选：DSH 内存分区改持久分区的字节补丁
test/check-client.mjs  离线自检
```

## 卸载

```powershell
dsh plugin --profile desktop remove @tianyulinfeng1/dsh-plugin-deepseek-chat
```

## 作者

- **作者**：伍悦匿匿
- **联系方式**：437830488@qq.com
- **GitHub**：https://github.com/sweet560
- **博客园**：https://www.cnblogs.com/wuyuenini/
- **CSDN**：https://blog.csdn.net/weixin_42076389
- **Gitee**：https://gitee.com/wtt520wyl
- **Gitee 镜像仓库**：https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat

## 许可证

[MIT](LICENSE)
