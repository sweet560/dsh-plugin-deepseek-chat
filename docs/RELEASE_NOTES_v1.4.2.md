# v1.4.2 发布说明 — DeepSeek / 豆包 平台一键适配

## 一句话
设置页的「聊天网页 URL」输入框改为 **DeepSeek / 豆包 两个切换按钮**：选 DeepSeek 用原配置，选豆包自动套用整套豆包专用适配器（URL + DOM 选择器），自动闭环 / 全自动通道继续可用。

## 需求来源
m00480：切到豆包后自动适配过去，把输入框变成两个按钮/选择项，选 DeepSeek 用原适配、选豆包切到专用适配。起因（m00463）：切豆包后自动闭环与全自动通道会因 DOM 选择器不匹配而失效。

## 实现要点
1. **平台预设**：新增 `PLATFORM_PRESETS`，`deepseek` / `doubao` 两套，每套 6 项——网页 URL + 停止/发送/输入框/助手回复/用户消息 五组选择器。DeepSeek 用原 `DEFAULT_*`，豆包用 `DOUBAO_*`（取自现成轮子：greasyfork「AI 对话助手」v2.3、under-the-ocean/doubao-api）。
2. **切换逻辑**：`applyPlatformPreset(name)` 一次 `writeConfig` 整包写入 URL + 选择器；`currentPlatform()` 从 `chatUrl` 主机推导当前平台（单一数据源，无冗余字段）。
3. **设置页**：第一张卡片内两个按钮（`data-dsh-plugin-deepseek-chat="platform-deepseek"` / `platform-doubao"`），选中高亮；卡片总数仍为 5，中英文案齐全。
4. **自动贯通**：切平台改 URL → `subscribeConfig` 触发 webview 重载 → `buildBridgeConfig()` 每次读实时 `getConfig()`，桥用新选择器重装。故导航 + 自动闭环 / 全自动通道自动跟随，**不改桥、不改导航**。
5. **零回归**：`parseChatUrl`/`parsePopupUrl`/导航逻辑均未动，`chat.deepseek.com` 主路径保持原样。测试新增预设完整性/整包切换/持久化/恢复默认/未知名返回 false + 双按钮存在性。

## 限制
- 豆包选择器来自公开轮子与通用占位，未做真机验证；若豆包改版导致选择器失效，可在设置页各组选择器里手工微调。
- client bundle 进程启动时缓存；本地安装需从托盘彻底退出 DSH 再重启才加载新 bundle。

## 版本同步
`package.json`（version / description / files 加入本文件）、`lib/client.js`（PLUGIN_VERSION + 双语 infoSummary + COPY）、`README.md` / `README.en.md`、`CHANGELOG.md`、`locale/zh.json` / `locale/en.json`、本文件。

## 自检
`node --check lib/client.js`（SYNTAX OK）；`node test/check-client.mjs`（`RESULT: PASS`）。
