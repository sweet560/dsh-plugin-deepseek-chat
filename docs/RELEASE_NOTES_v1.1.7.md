# dsh-plugin-deepseek-chat v1.1.7 发布说明

**发布日期**：2026-11-12
**npm 包名**：`@tianyulinfeng1/dsh-plugin-deepseek-chat`
**版本**：`1.1.7`（在 1.1.6 的 OIDC 可信发布链路测试之后，新增右边栏卡片能力）

---

## 一句话

按 **dsh-better-sidebar** 的接入原理，新增一张**右边栏卡片**（复用网页聊天 webview），并在「DeepSeek 聊天设置」页新增**卡片开关**与**卡片名称**两项设置；接入做成**可选软依赖**，没装 better-sidebar 时其余入口照常、零新增依赖、零报错。

---

## 需求来源

用户 m01901 的两点要求：

1. 「根据 DSH-better-sidebar 插件的原理，新增一个右边栏卡片，看要怎么配置最为简便」；
2. 「在 聊天设置界面，新增 右边栏卡片开关，及右边栏名称修改」。

经中文选择卡片确认的范围：

- **卡片内容**：复用网页聊天（右边栏卡片内嵌 `chat.deepseek.com` webview）；
- **默认值**：默认开启、名称「DeepSeek 聊天」（与顶栏标签名称彼此独立）；
- **发布**：升 `1.1.7` 并推送发布，且生成 GitHub / Gitee Releases。

---

## 「最简便配置」是怎么做到的

本版刻意**不改**下面三处，把改动压到最小：

| 不改的东西 | 原因 |
|---|---|
| `package.json` 的 `dsh.client.inject` | 它是 **client module 图的加载顺序依赖**（按包/行 id 查 `graphRows`），不是 Cordis 服务声明；往里加 `'betterSidebar'` 是错的 |
| `lib/client.js` 的模块级 `exports.inject`（仍 `["slots"]`） | 它是 `ctx.xxx` 直读服务的白名单；软探测不需要声明 |
| `dependencies` / `peerDependencies` / 构建配置 | 不 value-import 任何外部包，构建零耦合 |

运行时改用宿主 guard **明确允许**的软探测：

```js
let betterSidebar;
try {
  if (typeof ctx.get === "function") betterSidebar = ctx.get("betterSidebar");
} catch { betterSidebar = void 0; }
```

- `ctx.get('betterSidebar')` 在未安装时返回 `undefined`（`guard.ts` 的 `readService(name, false)` 不要求 inject 声明）；
- 官方 `providers.ts:42` 原文即「Prefer `ctx.get(name)` with an undefined check; use inject only for hard dependencies.」；
- dsh-sentinel 是官方指南里同样的「可选软依赖」真实案例。

因此：

- **已装** `dsh-better-sidebar`（本机 0.30.1，已确认 `ctx.provide('betterSidebar', service)` 存在）→ 注册一张卡片；
- **未装** → 静默跳过，左侧栏图标 / 会话顶栏标签 / 设置页 / 关于与检查更新全部照常。

---

## 新增：右边栏卡片

通过 `ctx.betterSidebar.registerTab(descriptor)` 注册，**descriptor 只用了最必要的字段**：

| 字段 | 值 | 说明 |
|---|---|---|
| `id` | `@tianyulinfeng1/dsh-plugin-deepseek-chat:card` | 包前缀，避免与内置 6 个 tab（editor / git / subagent / sidechat / terminal-bottom / diff）冲突 |
| `title` | `() => cardLabel()` | **thunk**；better-sidebar 每次渲染都重新求值，改名即时生效，无需重新注册 |
| `description` | `COPY.label` | 「DeepSeek 聊天」 |
| `icon` | `CardGlyph`（复用 `ChatGlyph`） | 宿主 icon 默认 16px |
| `order` | `60` | 排在内置 tab 之后 |
| `single` / `dedupeKey` | `true` / `() => CARD_ID` | 单实例，避免重复打开 |
| `component` | `CardView` | 直接 `return react.createElement(ChatPanelShell)`，复用网页聊天 webview 与固定持久分区 |

生命周期要点（对齐官方指南「注册必须包在 `ctx.effect` 里」）：

- `registerTab` 的返回值是 disposer，由 `ctx.effect` 持有；插件卸载（HMR / 禁用）时自动注销，**不留孤儿 TabDescriptor、下次激活不会抛 `already registered`**；
- `showCard` 关 → dispose 旧注册；开 → 重新 `registerTab`；
- 不用 `available` 置灰（它不拦截 `openTab`、也不从 `+` 菜单隐藏），改用「注销 / 重注册」更干净。

宿主承载面（已核对 `docs/host-contracts.md`）：原生右侧栏 tab 体由 better-sidebar 的 `.nativeTabHost` 包一层确定高度的 `height:100%` 列 flex，本插件 `ChatPanelShell` 的根 `styles.root` 本就是 `display:flex; flex-direction:column; height:100%; min-height:0`，可直接复用。

---

## 新增：设置页两项设置

设置页仍走官方 `settings.section` 槽。原两项（顶栏标签开关 + 名称）扩为**四项**，顶栏与右边栏彼此独立：

1. **显示顶部标签栏**（`showTab`，默认开）——沿用旧逻辑（dispose + 重新 inject `conversation.view` 触发标签行刷新）；
2. **顶部标签栏名称**（`tabLabel`，默认「DeepSeek 聊天」）——灰色占位提示、留空恢复默认、最长 40 字；
3. **显示右边栏卡片**（`showCard`，默认开）——关闭即注销 better-sidebar Tab；
4. **右边栏卡片名称**（`cardLabel`，默认「DeepSeek 聊天」）——同样灰色占位、留空恢复默认、最长 40 字，改名即时生效。

配置层：

- `CONFIG_KEY = "dsh-plugin-deepseek-chat:config"`（与会话记忆 key 分离）；
- `DEFAULTS = { showTab: true, tabLabel: DEFAULT_TAB_LABEL, showCard: true, cardLabel: DEFAULT_CARD_LABEL }`；
- `readConfig()` 按 `typeof` 校验四项字段，损坏 JSON / 错误类型逐项回退默认；
- 名称归一化抽成 `normalizeLabel(value, fallback)`（`trim`、空回退、`slice(0, 40)`），`normalizeTabLabel` 变成它的别名；
- `writeConfig(patch)` 合并四项、`localStorage` 持久化、通知 `configListeners`；
- `apply(ctx)` 用单个 `sync()` 同时驱动 `syncView()` 与 `syncCard()`，由 `subscribeConfig(sync)` 订阅；`ctx.effect` 的清理闭包同时 `unsubscribe()` 并 dispose 顶栏注册与卡片注册。

---

## 版本更迭（历史，保持已修复）

- **v1.1.3**：彻底移除账号状态条、账号探测、5 秒轮询与账号同步 store；新增会话顶栏 `conversation.view` 标签；三处注入改各自独立 try/catch。
- **v1.1.4**：新增设置页（顶栏标签开关 + 自定义名称）；顶栏标签用不透明绝对定位浮层（`inset: 0`、`z-index: 50`）铺满会话区、盖住 composer；图2 网页内标题胶囊按用户确认不处理；名称框改灰色占位 + 组件内 `draft` state。
- **v1.1.5**：设置页新增「关于本插件」（版本号 / 作者 / 功能简介 / 许可证 / npm·GitHub 链接）与「检查更新」按钮（npm 优先、GitHub 兜底、8 秒超时、数字逐段版本比较、文字状态 + 跳转链接）。
- **v1.1.6**：纯 OIDC 可信发布链路测试（`.github/workflows/publish.yml` 启用 `id-token: write`、Node 24（Active LTS）、`npm@latest`、`--provenance`），功能与 1.1.5 相同。
- **v1.1.2 的 web boot 崩溃**（历史，保持已修复）：工厂 id 仍为完整包名 `@tianyulinfeng1/dsh-plugin-deepseek-chat`，「工厂 id 必须等于 `package.json` 的 `name`」回归断言继续通过。

---

## 逐文件改动

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 头注释升 1.1.7；`PLUGIN_VERSION = "1.1.7"`；新增 `CARD_ID` / `CARD_ORDER` / `DEFAULT_CARD_LABEL`；COPY 中英双语各新增 4 个设置文案、`infoSummary` 提到右边栏卡片；配置层扩为四项 + `normalizeLabel` / `cardLabel`；新增 `CardView` / `CardGlyph` / `cardDescriptor`；设置页新增两个控件（data 属性 `show-card` / `card-label`）；`apply(ctx)` 加软探测与 `syncCard`、`ctx.effect` 清理；`exports.__test__` 导出新符号 |
| `test/check-client.mjs` | 配置层断言扩为四项；`makeCtx({ betterSidebar })` + 假 `registerTab` 服务；新增「better-sidebar 缺席 / 在位 / descriptor / title thunk 改名 / 开关注销重注册 / effect cleanup」断言；设置页用 data 属性精确定位两对控件 |
| `package.json` | `version` → `1.1.7`；description 提到「optional dsh-better-sidebar right-sidebar card」；`files` 新增本发布说明 |
| `locale/zh.json` / `locale/en.json` | 插件页描述提到右边栏卡片（可开关 / 可自定义名称） |
| `README.md` / `README.en.md` | 当前版本 1.1.7；功能段两入口→三入口；设置页四项；使用段与版本历史、开发段、目录树同步 |
| `CHANGELOG.md` | 顶部新增 `## 1.1.7 — 2026-11-12` 段 |
| `docs/RELEASE_NOTES_v1.1.7.md` | 本文件（新建） |

未改动：`lib/index.js`（空宿主半侧）、`cordis.patch.yml`、`icon.svg`、login-persistence 脚本、`scripts/`、`.github/workflows/*`（workflow 本版不动）。

---

## Verification（本版验证）

- `node --check lib/client.js` → 通过；
- `npm test`（`node test/check-client.mjs`）→ 全部通过（`RESULT: PASS`），含：
  - 工厂 id === `package.json` 的 `name`；
  - 元信息常量（版本号等）与 `package.json` 一致；
  - 桌面表层恰好四处槽位注册；Web 表层 inert；
  - **better-sidebar 缺席**：四处表面照常、零卡片注册、零报错；
  - **better-sidebar 在位**：注册 1 张卡片、descriptor 字段正确、title thunk 改名、showCard 开关注销/重注册、effect cleanup 注销；
  - 设置页两对开关与灰色占位提示联动、顶栏标签动态重注入；
  - 原有全部 guest 生命周期（首次访问 / 会话记忆 / SPA / 鉴权 / 根清除 / 卸载释放租约 / 失效回退 / 非法记忆 / DOM 移除后清理 / 崩溃隔离 / 反复开关 / 弹窗白名单 / 顶栏浮层铺满 / 两入口复用分区）；
  - 关于信息 + 检查更新（npm 优先 GitHub 兜底、语义版本、各状态分支）；
- `git diff --check` 无空白错误；
- `npm pack --dry-run` 产物含 `docs/RELEASE_NOTES_v1.1.7.md`。

---

## 升级 / 安装

```powershell
# npm（推荐）
dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat

# GitHub
github:sweet560/dsh-plugin-deepseek-chat

# Gitee 镜像
https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat

# 本地 tgz
dsh plugin --profile desktop add file:"<dsh-plugin-deepseek-chat-1.1.7.tgz 绝对路径>"
```

**环境要求**：DSH `>= 0.2.2-rc.1`、Node `>= 24`（Node 24 Active LTS）、Windows / macOS / Linux 桌面壳。右边栏卡片额外需要 `dsh-better-sidebar >= 0.30.0` 已安装并启用；不装也能用其余功能。

---

## Assets

- `dsh-plugin-deepseek-chat-1.1.7.tgz` —— `npm pack` 产物（`npm pack` 原生名为 `tianyulinfeng1-dsh-plugin-deepseek-chat-1.1.7.tgz`，发布时统一重命名）。

---

## Honest limitation（如实说明）

- **纯插件做不到让 `chat.deepseek.com` 复用 DSH 已登录账号**：DSH 桌面版账号凭据在 Host 进程，网页版登录态在 guest session 的 httpOnly cookie，没有兑换入口；首次仍需在网页里扫码登录一次。v1.1.3 起连「账号状态」展示也一并删除。
- **重启 DSH 后仍需重新登录网页版**（除非按 `docs/login-persistence.md` 打持久分区补丁）；本插件不修改 DSH 安装文件。
- **纯 Web 表层（`dsh web` 在浏览器里打开）inert**：该站点 `frame-ancestors 'none'`，iframe 嵌不了，guest 租约桥也只有桌面壳提供。
- **右边栏卡片是可选软依赖**：未安装 / 未启用 `dsh-better-sidebar` 时卡片不出现，这是预期行为，不是故障。
