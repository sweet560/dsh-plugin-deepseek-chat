# v1.1.10 发布说明 — 设置页「一键更新」

## 一句话
设置页「检查更新」发现新版本后，结果区（你截图里红框的位置）会跳出「立即更新」按钮；点一下就调用 DSH 桌面版自带的官方插件更新通道，自动把插件替换成新版本，并用中文如实告诉你「更新完成 / 需要重启 / 为什么失败」。

## 需求来源
- m04558：「在设置页面新增一个 更新的功能，最好是跟 检查跟新集成，检查更新后，发现新版本，就在大概红框的位置跳出更新按钮，点击一下就 自动更新插件了」。
- 中文卡片（m04643）：`update_mechanism` = 「真调用官方通道 + 失败如实提示（推荐）」；`release_handling` = 「升到 v1.1.10，先不发布」。

## 为什么不自己造轮子
DSH Host 本来就有 `pluginManager.updateBundle(name, version)`，官方插件管理页就是用它更新组合包的（`dsh-client-ui-plugin-manager/src/client/manager-store.ts:960`）。本插件直接复用，不新增 Host 路由、不加依赖、不改宿主半侧。

## 实现要点
1. **真调用**：点击时通过 `ctx.get("remote")?.pluginManager?.updateBundle(PLUGIN_NAME, latest)` 软读调用。guard 允许 `ctx.get(name)` 软读（`dsh-cordis-client-runner/src/client/guard.ts:220`），返回的 Proxy 里 `.pluginManager` 是非函数命名空间、被原样放行，`updateBundle` 的 `this` 绑定正确。
2. **不写进 inject**：`exports.inject` 仍是 `["slots"]`。若把 `remote` 声明成必需服务，冷启动时 Host 服务晚到会让 runner 把整个插件 fiber park（`runtime.ts:393`），左侧栏 / 顶栏 / 设置页会一起失效。
3. **状态如实**：按 `PluginUpdateResult.result.application` 分：`applied` → 「更新完成」；`restart-required` → 「已安装，请重启 DSH 生效」；`failed` / `cancelled` / `overridden` → 「更新失败：<原因>」。错误可能是 `{code, diagnostic}`（本机 link: 安装被 `updateRefusal` 拒时就没有 `message`），所以原因取 `message ?? diagnostic ?? code`。没有通道时提示「当前环境无法调用插件更新通道」，全程 try/catch 不逃逸。
4. **按钮位置**：只在 `status === "found"` 时出现在 `update-status` 结果区（红框位置），带 `data-dsh-plugin-deepseek-chat: "update-now"`；npm / GitHub 跳转链接在所有终态都保留，作为手动更新兜底。
5. **版本与自检**：升 `1.1.10`；离线自检新增 fake `pluginManager.updateBundle`，覆盖「idle 不出按钮 / found 才出按钮 / 真调用且参数正确 / applied / restart-required / link: 被拒显示 diagnostic / 无通道 / 失败后仍有兜底链接」。

## 必须如实说明的限制
- 本机是 `link:` 本地安装，`updateRefusal`（`dsh-plugin-manager/lib/index.js:1693`：`installed neither from a registry under its own name nor from a Git commit`）会拒绝更新。只有从 npm 正式安装的真实用户能一键成功；本机点「立即更新」会看到「更新失败」加官方原因，这是预期行为，不是 bug。
- 本机 v1.1.9 尚未发布、高于 npm 已发布的 1.1.8，所以改完点「检查更新」仍显示「已是最新版本」，按钮不会出现；要等发布了更高的版本（例如 1.1.10 正式推送到 npm）才看得到。
- `updateBundle` 在有 HMR 时会临时卸载并重装本插件，无 HMR 时返回 `restart-required`；无论哪种，按提示重启 DSH 桌面版最稳妥。

## 升级 / 安装
从 npm 安装：`dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat`。改本地源码后需从托盘彻底退出 DSH 再重启才会加载新 bundle。纯 Web 表层（`dsh web`）没有桌面壳 guest 租约桥，插件不注册属正常。

## 本版文件
`lib/client.js`（文案 / runUpdate / 状态 / 按钮 / 导出）、`test/check-client.mjs`（remote 桩 + 一键更新断言）、`package.json`（版本 + 发布说明入 files）、`README.md` / `README.en.md`、`CHANGELOG.md`、`locale/zh.json` / `locale/en.json`、本文件。

## 自检
`node --check lib/client.js`、`npm test`（`RESULT: PASS`）、`git diff --check` 全部通过；`npm pack --dry-run` 含本发布说明。

## 发布状态
按用户卡片确认「先不发布」：未 commit / 未 push / 未打 tag / 未建 Release，改动只留在本地工作区。