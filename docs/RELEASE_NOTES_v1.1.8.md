# dsh-plugin-deepseek-chat v1.1.8 发布说明

> 修复「右边栏卡片不出现」的加载顺序竞态，并把支持版本更新到 DSH **0.2.2-rc.2**。这是一个 bugfix 版本；按用户确认**先不推送发布**，改动留在本地工作区。

## 需求来源

用户反馈：设置页「显示右边栏卡片」已勾选，但右边栏没有插件卡片，在 `dsh-better-sidebar` 的设置「侧边栏内容」里也找不到 DeepSeek 聊天卡片；同时要求把「支持版本」标注更新到当前 DSH **0.2.2-rc.2**。

## 根因（实锤）

不是 `dsh-better-sidebar` 0.31.1 的接口变更，也不是 `TabDescriptor` 写错——服务名 `betterSidebar`、`registerTab(descriptor)` 契约与 descriptor 字段（`id` / `title` thunk / `order: 60` / `single` / `component`）都未变。

真正原因是**加载顺序竞态**：

- 本插件 v1.1.7 在 `apply()` 开头**一次性** `ctx.get("betterSidebar")`，且不把 `betterSidebar` 写进 `exports.inject`。
- Cordis 的 `notify()` 只唤醒「在 `inject` 里声明了该服务」的 fiber（`if (!(name in fiber.inject)) continue;`）；`ctx.get()` 软读不登记 dependent，服务晚到不会触发任何重试。
- `dsh.client.inject` 只保证 client module **工厂加载顺序**，不保证 `provide()` / `apply()` 顺序。若 better-sidebar 的 `ctx.provide('betterSidebar', service)` 晚于本插件那一行，读到 `undefined` 后就**永不重试**。
- `syncCard()` 在 `betterSidebar` 为 undefined 时静默 return ⇒ **`registerTab` 从未调用** ⇒ `service.getTabs()` 只有内置 6 项 ⇒ 设置页「侧边栏内容」和「+ 添加 Tab 插件」都看不到卡片。桌面日志没有任何报错，印证「不是抛错，是根本没调用」。

## 修复（最稳妥的写法）

保留「软依赖」：better-sidebar 未安装 / 禁用时，左侧栏、顶栏标签、全屏面板、设置页照常工作。

- 把一次性软探测换成「每次 `sync()` 都**重读** `ctx.get("betterSidebar")` + **有上限、可取消的就绪重试**」。
- `CARD_RETRY_DELAY = 500`、`CARD_RETRY_MAX = 40`（最长约 20 秒）：服务缺席时排一个 timer，到点重读；服务一到位立即 `registerTab` 并取消重试。
- 只用**浏览器全局** `setTimeout` / `clearTimeout`：`ctx.setTimeout` 被 guard 的 `TIMER_VERBS` 挡住（要求声明 `'timer'` inject）。
- `ctx.effect` 的 disposer 在 HMR / 插件卸载时 `cancelCardRetry()` 并注销卡片，不留孤儿 timer / TabDescriptor。
- **不**把 `betterSidebar` 写进 `exports.inject`：runner 在「声明了但缺失的服务」时会把整个插件 fiber park（pending），导致其余全部表面失效；本插件刻意保持软依赖。
- `exports.__test__` 暴露 `CARD_RETRY_DELAY` / `CARD_RETRY_MAX` 供自检断言。

## 支持版本

- 当前标注改为 **DSH 0.2.2-rc.2**：中英 README「适配/Targets DSH」、环境要求表、`package.json` 的 `engines.dsh >= 0.2.2-rc.2`、`docs/RELEASE_NOTES_v1.1.7.md` 环境要求。
- **保留 `0.2.2-rc.1`**：崩溃日志原文、旧发布说明、以及「当时在 rc.1 源码中逐项核对」等历史事实，不篡改。

## 逐文件改动

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 头注释 / `PLUGIN_VERSION` 升 1.1.8；新增就绪重试常量与 `getSidebarService` / `cancelCardRetry` / `scheduleCardRetry`；`syncCard()` 改为重读 + 重试；`ctx.effect` 清理增加取消 timer |
| `test/check-client.mjs` | 可控 fake timer；新增「服务晚到也能注册 / 重试有上限 / cleanup 取消 timer」断言；头注释同步 1.1.8 |
| `package.json` | version `1.1.8`、`engines.dsh >= 0.2.2-rc.2`、`files` 加入本发布说明 |
| `README.md` / `README.en.md` | 当前版本 / 支持版本、v1.1.8 本版横幅、版本历史新增 1.1.8 行 |
| `CHANGELOG.md` | 新增 1.1.8 段 |
| `docs/RELEASE_NOTES_v1.1.7.md` | 环境要求的 DSH 版本改为 rc.2 |
| `docs/RELEASE_NOTES_v1.1.8.md` | 本文件（新建） |

`lib/index.js`、`cordis.patch.yml`、`icon.svg`、`scripts/`、`.github/workflows/*` 均未改动。

## Verification

- `node --check lib/client.js` 通过。
- `npm test` → `RESULT: PASS`（含新增竞态断言；自检把 sandbox 的 `setTimeout` 换成可手动推进的 fake timer，避免真实 500ms×40 拖慢或挂住进程）。
- `git diff --check` 通过。

## 升级安装

- npm：`dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat`
- GitHub：`github:sweet560/dsh-plugin-deepseek-chat`
- Gitee：`https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat`
- 本地 tgz：`dsh-plugin-deepseek-chat-1.1.8.tgz`

link: 本地安装需**重启桌面版 App** 才加载新 bundle；纯 Web 表层（`dsh web`）没有桌面 guest 桥，插件 inert 属正常。

## Assets

- `dsh-plugin-deepseek-chat-1.1.8.tgz`（`npm pack` 原生名 `tianyulinfeng1-dsh-plugin-deepseek-chat-1.1.8.tgz`）。

## Honest limitation

- 纯插件无法让 `chat.deepseek.com` 复用 DSH 已登录账号，仍需扫码登录一次；要「重启 DSH 也不重新扫码」需按 [docs/login-persistence.md](docs/login-persistence.md) 给 `app.asar` 打持久分区补丁（DSH 升级会覆盖，需重打）。
- 右边栏卡片是**可选软依赖**：必须安装并启用 `dsh-better-sidebar`（本机为 0.31.1）才会出现；不装也能用其余功能。
- 本版按用户确认**先不推送发布**：不 commit / 不 push / 不 tag / 不建 Release，等用户从托盘彻底退出 DSH 重启、确认「重启后不再要求扫码」后再决定是否一起发布。
