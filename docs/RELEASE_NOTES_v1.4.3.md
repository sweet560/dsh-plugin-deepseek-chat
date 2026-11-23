# v1.4.3 发布说明 — 状态条固定显示

## 一句话
聊天面板的状态条改为**固定显示**：进入面板即常驻，不再依赖「条件触发式自动闭环同步」开关才出现。

## 需求来源
m00745：把状态条显示方式改为固定显示，而不是打开条件触发才显示（附状态条与开关截图）。

## 实现要点
1. **显示门槛**：`SyncStatusBar` 去掉 `!getConfig().autoSyncEnabled` 判断，仅在没有桌面运行时（`!rt`，例如纯 Web 表层）才不渲染。
2. **按钮可用**：状态条「▶启动全自动」在总开关关闭时可直接点击——用户主动点击即 `writeConfig({autoSyncEnabled:true})` 再 `startAutoPilot`。默认 `autoSyncEnabled` 仍为 false，「绝不自动启动」安全阀不变。
3. **测试适配**：原「默认隐藏」断言改为固定显示（齿轮按钮存在性）；纯网页聊天断言改为语义校验「有且仅有一个 webview」，兼容全屏面板 / 顶栏标签页两种包装层。
4. **零回归**：`syncAutoLoop`（dock 注册）与 `startAutoPilot` 安全阀本身未改，`chat.deepseek.com` 主路径保持原样。

## 限制
- 状态条依赖桌面运行时 `syncRuntime`；纯 Web 表层无运行时时不渲染（此时状态条无意义）。
- client bundle 进程启动时缓存；本地安装需从托盘彻底退出 DSH 再重启才加载新 bundle。

## 版本同步
`package.json`（version / description / files 加入本文件）、`lib/client.js`（PLUGIN_VERSION + 双语 infoSummary）、`README.md` / `README.en.md`、`CHANGELOG.md`、`locale/zh.json` / `locale/en.json`、本文件。

## 自检
`node --check lib/client.js`（SYNTAX OK）；`node test/check-client.mjs`（`RESULT: PASS`）。
