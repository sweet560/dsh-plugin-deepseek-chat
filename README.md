# dsh-plugin-deepseek-chat

[English](README.en.md) | 中文

在 **DeepSeek Harness（DSH）桌面版**的左侧栏加入 **DeepSeek 聊天** 入口，点开后 `chat.deepseek.com` 直接占满主内容区，并记住上次所在的会话。

> 仓库：[GitHub](https://github.com/sweet560/dsh-plugin-deepseek-chat) ｜ [Gitee 镜像](https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat)

![面板截图](docs/screenshot.png)

## 功能

- 左侧栏图标入口，排在「插件」和「自动化任务」之间。
- 主内容区全宽内嵌 `https://chat.deepseek.com/`（Electron `<webview>`，走桌面壳的 guest 租约桥 `window.dshDesktop.browser`）。
- **记住上次会话**：切到别的面板、切换会话、重启 App 后再进来，直接回到上次那条对话，而不是新对话。
- 登录/鉴权页不会覆盖记忆；记住的会话失效或打不开时自动回退到首页。
- **崩溃隔离**：内嵌页进程退出、被销毁或启动超时，只在面板里显示「重试」，不会再出现整个 App 变空白窗口的问题（v0.4.0 修复，见下文）。
- 纯 Web 表层（`dsh web` 在浏览器里打开）自动不注册——该站点 `frame-ancestors 'none'`，iframe 嵌不了，guest 租约桥也只有桌面壳提供。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | 桌面版 `0.2.1-rc.2` 或更新 |
| 平台 | Windows / macOS / Linux 桌面壳 |
| git | 仅「GitHub 安装」方式需要（pnpm 通过 git 拉取仓库） |

## 安装

### 方式一：插件页安装（推荐）

1. 打开 DSH 桌面版，左侧栏点 **插件**。
2. 点列表上方的 **安装第三方插件**。
3. 在「包名或地址」里填入：

   ```
   github:sweet560/dsh-plugin-deepseek-chat
   ```

   也可以填 `https://github.com/sweet560/dsh-plugin-deepseek-chat`。
4. 点 **安装**，等 pnpm 跑完（首次会拉取仓库并安装依赖）。
5. 安装完成后插件自动启用，左侧栏出现 **DeepSeek 聊天**。

### 方式二：命令行

```powershell
dsh plugin --profile desktop add github:sweet560/dsh-plugin-deepseek-chat
```

装完打开 **插件 → 已安装插件**，确认「DeepSeek 聊天」处于启用状态（命令行只负责装依赖，启用状态以插件页为准）。

### 方式三：本地目录（二次开发）

```powershell
dsh plugin --profile desktop add file:"<本仓库绝对路径>"
```

## 使用

- 第一次打开会停在 chat.deepseek.com 的登录页，登录一次即可。
- 本次 App 运行期间，切换面板/会话不需要重新登录。
- **重启 DSH 后需要重新登录一次**：DSH 目前给内嵌浏览器的是内存分区（`dsh-sidebar-browser-<uuid>`，没有 `persist:` 前缀），进程退出即清空 cookie。本插件不修改 DSH 的安装文件，所以不会绕过这一限制；想做到「登录一次、长期免登录」，可直接运行仓库自带的补丁脚本 **[docs/patch-dsh-persistent-partition.cjs](docs/patch-dsh-persistent-partition.cjs)**（已适配 `0.2.1-rc.3` 的 ASAR integrity，支持 `--dry-run`、自动备份与全量校验），说明见 **[docs/login-persistence.md](docs/login-persistence.md)**。
- 会话链接记在 App 的 localStorage（key `dsh-plugin-deepseek-chat:last-url`），重启后仍会打开上次的会话（前提是已登录且该会话仍存在）。

## 登录态持久化（可选，免登录）

DSH 目前给内嵌浏览器分配的是**内存分区**（`dsh-sidebar-browser-${randomUUID()}`，无 `persist:` 前缀），所以每次重启 App 都会清空 cookie。想做到「登录一次、以后不再登录」，需要把桌面主进程里的那行分区名改成固定且带 `persist:` 前缀的值——两条语句**字节数相同**，可以直接在 `resources/app.asar` 里原地替换。

完整原因、脚本、验证步骤、回滚方式和各平台路径都整理在这里：

**→ [docs/login-persistence.md](docs/login-persistence.md)**

补丁脚本（仓库自带，Node 18+，零依赖）：

```powershell
# 打补丁（自动备份）
node docs/patch-dsh-persistent-partition.cjs "F:\DeepSeek Harness\resources\app.asar"

# 只检查、不写盘
node docs/patch-dsh-persistent-partition.cjs "F:\DeepSeek Harness\resources\app.asar" --dry-run
```

脚本已适配 `0.2.1-rc.3` 的逐文件 ASAR `integrity`（自动重算并同步 `lib/main.js` 的 SHA256），支持幂等重跑（已打补丁直接返回 0）、自动备份、写入前后全量校验，以及 `--dry-run` 预演。

注意：这属于对已安装应用的修改，不在 DSH 支持范围内；DSH 升级会覆盖 `app.asar`，需要重新打补丁（`Partitions` 里的登录数据不会丢）。请先备份，风险自负。

## 已知限制

- chat.deepseek.com 会检测 Electron 内嵌环境，偶尔弹出「使用环境异常…建议使用官方产品」的提示；这是站点侧行为，与本插件无关。
- 仅桌面版有效；`dsh web` 在浏览器里打开时不显示入口。
- 站点若调整会话 URL 规则（当前识别 `/a/chat/s/<id>` 形式），「记住会话」可能失效并回退到首页。

## 崩溃隔离（v0.4.0）

早期版本出现过：点开面板、聊天页正常显示 1~2 秒后**整个 App 变成空白窗口**（只剩原生菜单和窗口按钮），没有崩溃对话框也没有 `crash-*.log`。

根因是 React 卸载面板时**先移除 DOM、后执行 effect 清理**，而 Electron 的 `<webview>` 一旦脱离文档，`getURL()` 就会抛错；DSH 把插件里任何未捕获异常都当作 `slot entry crashed in 'root'`，直接卸载 `root` slot —— 整个 App UI 因此消失。

现在的实现：

- 所有 guest 调用先判断 `element.isConnected` 再 `try/catch`，清理阶段「先读 URL、再移除元素」；
- 每个事件处理器都包 `try/catch`，异常只落在面板自己的状态里；
- 面板外包一层 React 错误边界；
- 监听 `render-process-gone` / `destroyed` / `did-fail-load`，guest 出问题时面板内显示「重试」；
- 15 秒启动看门狗，guest 一直不 `dom-ready` 就转重试卡片。

## 开发

```powershell
git clone https://github.com/sweet560/dsh-plugin-deepseek-chat.git
cd dsh-plugin-deepseek-chat
node test/check-client.mjs
```

`test/check-client.mjs` 是离线自检：在 `node:vm` 里加载 `lib/client.js`，用假的 React/DOM/租约桥验证注册、会话记忆、租约释放和崩溃隔离（DOM 先移除再清理不抛错、guest 崩溃不逃逸、反复开关不漏租约）。

目录：

```
lib/index.js           宿主半侧（空实现，只为让 client bundle 有 Loader 入口）
lib/client.js          浏览器半侧：入口、面板、webview 生命周期、崩溃隔离
cordis.patch.yml       bundle 补丁：插入本插件的 Loader 行
locale/zh.json         插件页显示名称/描述（中文）
locale/en.json         插件页显示名称/描述（英文）
icon.svg               插件页图标
test/check-client.mjs  离线自检
```

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-plugin-deepseek-chat
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
