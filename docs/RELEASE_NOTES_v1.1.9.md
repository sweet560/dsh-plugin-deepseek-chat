# dsh-plugin-deepseek-chat v1.1.9 发布说明

## 一句话

修复「重启 DSH 桌面端后，必须到设置里把右边栏卡片关一次再开一次才出现」的 bug，并按用户想法把右边栏卡片改成**双路径**：better-sidebar 正常运行时走它，没正常运行（含未安装 / 启动晚）时直注 DSH 自带原生右侧栏。

## 需求来源

- 用户 m04145：「修复 bug，重启 DSH 桌面端后，需要手动到设置里面点击一下关闭再点击打开，才能让右侧边栏出现卡片……应该是启动顺序的原因」。
- 用户 m04201：「不一定其他适用 DSH 的人就都有装这个插件……新增一条检测功能，用于检测是否有安装 DSH-better-sidebar 插件，并且该插件是否已经正常使用，正常使用的情况下，再执行右边栏卡片注入的功能。如果检测到没有安装……执行全新的实现方式，直接注入到右侧边栏」。
- 用户 m04379 简化判据：「不用区分 better-sidebar 装了但启动晚 和根本没装，直接以，检测 better-sidebar 插件是否正常运行为准……正常运行就走 better-sidebar 注入，没正常运行就走直接注入」。
- 用户 m04395 补充关键证据：「better-sidebar 0.31.1 的 `ctx.provide('betterSidebar', service)` 在它自己的 `apply()` 内（index.tsx:175），而它声明了 `remote` / `remote.session` / `connection` 等 Host 传输服务（index.tsx:53）——冷启动时这些服务要先就绪，better-sidebar 的 fiber 才会 active、provide 才发生，也是判断是否正常运行的关键」。
- 中文卡片确认：scope「完整双路径（按你的想法，推荐）」；release「升 1.1.9，先不发布（推荐）」。

## 根因（为什么每次重启都要手动开关一次）

v1.1.8 用「`CARD_RETRY_DELAY = 500` × `CARD_RETRY_MAX = 40` ≈ 20 秒」的**有限**就绪重试窗口，等待 `ctx.get("betterSidebar")` 返回可用服务。

better-sidebar 0.31.1 声明 `inject = ['slots','sessions','locale','modules','connection','remote','remote.session']`（`F:\DeepSeek Harness workspace\profiles\desktop\node_modules\dsh-better-sidebar\src\client\index.tsx:53`），冷启动必须等这些 Host 传输服务就绪、其 fiber 才转为 active（state 2），位于 `apply()` 内的 `ctx.provide('betterSidebar', service)`（`index.tsx:175`）才会发生；Cordis 的 `get(name, strict=true)` 明确 `if (strict && impl.ctx.fiber.state !== 2) return;`（`cordis/lib/index.js:1354`），提供方未 active 时 `ctx.get` 返回 `undefined`。

若 20 秒窗口在服务就绪前耗尽，`scheduleCardRetry` 因达到上限直接 return，`registerTab` 永远不会被调用，卡片就一直不出现；手动关/开设置开关触发 `sync()` 重读，此时服务早已就绪，于是「救回来」。桌面日志无任何 v1.1.8 的 `betterSidebar` / `registerTab` 报错，印证「不是抛错，是重试窗口耗尽后不再尝试」。

**「已安装」≠「正常运行」**：manifest 里能查到包名只说明装了，服务没起来照样不能用；因此按用户要求，判据只取「`ctx.get('betterSidebar')` 是否返回带 `registerTab` 的可用服务」。

## 修复内容

### 1. 就绪机制根治（去掉硬上限）

不再设 `CARD_RETRY_MAX`，改为三层触发、任一层到位即 `syncCard()` 注册：

1. **服务就绪事件**：`ctx.on('internal/service', (name, value) => { if (name === 'betterSidebar' || name === 'sidebarRightTabs') syncCard(); }, { global: true })`。Cordis 在 `provide()` / provider fiber 变 active 时会 `emit('internal/service', name, value)`；`{ global: true }` 绕过 context filter，动态插件也能收到（guard 的 `CTX_VERBS` 含 `on`，允许转发）。监听 disposer 由 `ctx.effect` 持有。
2. **无界但可取消的兜底**：500ms 间隔的浏览器全局 `setTimeout` / `clearTimeout`，`cancelCardRetry()` 在服务到位 / 开关关闭 / 卸载时清除。不能用 `ctx.setTimeout`（guard 的 `TIMER_VERBS` 要求声明 `'timer'`），也不能用 `ctx.inject`（动态插件 guarded ctx 无该动词）。
3. **每次 `sync()` 重读**：`subscribeConfig(sync)` 保证配置变化时也重读。

所有 disposer、事件监听、timer 由 `ctx.effect` 返回的闭包 disposer 统一清理，HMR / 卸载无残留。仍**不**把服务写进 `exports.inject`（runner 在「声明了但缺失的服务」时会把整个插件 fiber park，其余表面全失效）。

### 2. 检测 + 双路径（按「是否正常运行」）

`getService(name, method)` 每次 `ctx.get(name)` 并校验 `typeof service[method] === 'function'`：

- `ctx.get('betterSidebar')` 可用（带 `registerTab`）→ **better-sidebar 路径**：`service.registerTab(cardDescriptor())`（沿用 v1.1.7 的 descriptor：`id`、`title` thunk、`order: 60`、`single: true`、复用网页聊天 webview）。
- 不可用（未安装 / 装了但服务还没起来）→ **DSH 原生路径**：`ctx.get('sidebarRightTabs').register(nativeCardDefinition())` 注册 tab 类型，再 `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: CARD_ID }, CardView))` 注册正文槽。`definition.title(address)` 提供 chip 文字，按官方契约可**省略** `sidebar.right.pane.tab.title` 槽。原生服务由 shipped 包 `@deepseek-ai/dsh-client-ui-sidebar-right` 在 `apply()` 顶层 `ctx.reflect.provide('sidebarRightTabs', tabs)` 提供，无启动竞态。
- **两路径互斥**：`activeCardPath` 记录当前路径，相同则跳过（避免无谓重建 webview）；晚到的 betterSidebar 服务经 `internal/service` 事件把原生卡片注销、自动切换到 better-sidebar 卡片。

### 3. 保留

`config.showCard` 开关、`cardLabel` 与 `title` thunk、Web 表层 inert 守卫、四处槽位注册（main / sidebar.panellist / settings.section / conversation.view）、关于本插件与检查更新、会话记忆与崩溃隔离，全部不变。

## 逐文件改动

| 文件 | 内容 |
|---|---|
| `lib/client.js` | 头注释 / `PLUGIN_VERSION` 升 1.1.9；去掉 `CARD_RETRY_MAX`；新增 `CardGuideIcon` / `nativeCardDefinition()`；`apply()` 重构为双路径（`getService` / `getNativeRegistry` / `registerNativeCard` / `composeDisposers` / `clearCard` / `activeCardPath`）；新增 `ctx.on('internal/service', {global:true})` 监听；`ctx.effect` 清理增加移除监听与注销双路径卡片；COPY 里两处用户可见提示改为双路径描述 |
| `test/check-client.mjs` | 头注释升 1.1.9；测试桩增加 `sidebarRightTabs` / `nativeRegistrations` / `serviceListeners` / `ctx.on` / `emitService` / `makeNativeRegistry`；卡片测试块整体重写为 6 组双路径断言 |
| `package.json` | version `1.1.9`、`files` 加入本发布说明、description 改双路径 |
| `README.md` / `README.en.md` | 当前版本、功能段、设置页说明、v1.1.9 本版横幅、版本历史新增 1.1.9 行、开发段与目录树同步 |
| `CHANGELOG.md` | 新增 1.1.9 段 |
| `locale/zh.json` / `locale/en.json` | 描述改为双路径 |
| `docs/RELEASE_NOTES_v1.1.9.md` | 本文件（新建） |
| `docs/RELEASE_NOTES_v1.1.8.md` 及其更早版本 | 历史，保留原样 |

未改动：`lib/index.js`（空宿主半侧）、`cordis.patch.yml`、`icon.svg`、`scripts/`、`.github/workflows/*`。`dsh.client.inject` 仍为 `["@deepseek-ai/dsh-client-ui-sidebar"]`，`exports.inject` 仍为 `["slots"]`。

## Verification（本版验证）

- `node --check lib/client.js`：通过。
- `npm test`：`RESULT: PASS`。新增断言覆盖：两服务全缺席 → 零卡片 + 排 1 个无上限 timer；better 正常运行 → 只走 `registerTab`、原生直注跳过（互斥）+ descriptor 字段 + 改名 `title` thunk 独立；better 未运行但原生 registry 可用 → 原生直注（type + body 槽）+ `nativeCardDefinition` 契约 + 改名 + show-card 开关注销/重注册；`ctx.on('internal/service', {global:true})` 监听 + 服务晚到事件把原生卡片切换为 better 卡片；无界 timer 推进 50 轮（> 旧上限 40）仍可注册；cleanup 注销卡片 / 移除监听 / 取消 timer。测试桩用可控 fake timer 与 `internal/service` 事件模拟，不让真实 500ms timer 拖慢进程。原有配置层、关于信息 + 检查更新、设置页美化与对齐、顶栏浮层、11 组 guest 生命周期断言全部继续通过。
- `git diff --check`：通过（仅 LF→CRLF 换行警告）。

## 升级安装

- npm：`dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat`
- GitHub：`github:sweet560/dsh-plugin-deepseek-chat`
- Gitee 镜像：`https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat`
- 本地 tgz：`dsh-plugin-deepseek-chat-1.1.9.tgz`（`npm pack` 原生名 `tianyulinfeng1-dsh-plugin-deepseek-chat-1.1.9.tgz`）
- 因为是 `link:` 本地安装，改完仓库源码后需**从托盘彻底退出 DSH 再重启**才会加载新 bundle；纯 Web 表层（`dsh web`）无桌面壳 guest 租约桥，插件 inert 属正常。

## Assets

本版按用户确认**先不推送发布**：不 commit / 不 push / 不 tag / 不建 Release，不生成对外资产；等用户重启桌面端确认「不用手动开关也能出卡片」后再决定是否一起发布。

## Honest limitation（如实说明）

- 纯插件无法让 chat.deepseek.com 复用 DSH 已登录账号，仍需扫码一次；「重启后不用重新扫码」依赖 [docs/login-persistence.md](docs/login-persistence.md) 的持久分区补丁，DSH 升级覆盖 `app.asar` 后需重打。
- 原生右侧栏路径下，卡片不会出现在 better-sidebar 的「侧边卡片」设置列表里（那是 better-sidebar 自己的 UI）；这是两条路径各自的正常表现。
- 原生路径复用 `CardView`（网页聊天 webview），需要桌面壳 guest 租约桥；纯 Web 表层 inert。
