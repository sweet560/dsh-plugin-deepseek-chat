# v1.4.4 发布说明 — 条件触发 / 全自动 双模式互斥联动

## 一句话
状态条上的「绑定当前会话」与「启动全自动」现在是两种互斥模式：点绑定回到条件触发，点全自动关掉条件触发并切到全自动通道。

## 需求来源
m00984：绑定当前会话即默认开启条件触发；点「启动全自动」则关闭条件触发、切换到全自动。

## 实现要点
1. **引擎总闸解耦**：新增 `isEngineActive(cfg)` = `autoSyncEnabled || autoPilotEnabled`（任一开即工作）。切全自动关掉条件触发后，dock 注册、会话订阅、turn/end 驱动、trace 不再瘫痪。
2. **替换单点判断**：`writeLoopTrace` / `refresh` / `handleTurnEnd` / `reset` / `syncAutoLoop` / `startAutoPilot` 六处 `autoSyncEnabled` 判断统一改走 `isEngineActive`。
3. **按钮联动**：
   - 绑定当前会话 → `writeConfig({autoSyncEnabled:true, autoPilotEnabled:false})`，若全自动在跑先停下；
   - 启动全自动 → `writeConfig({autoSyncEnabled:false, autoPilotEnabled:true})`；
   - 停止全自动 → `writeConfig({autoPilotEnabled:false, autoSyncEnabled:true})` 退回条件触发闭环。
4. **安全阀不变**：两个开关默认仍为 false，所有切换由用户主动点击触发，绝不自动启动。
5. **零回归**：`parseChatUrl` / 导航 / 平台预设 / 桥接逻辑未改，DeepSeek 主路径保持原样。

## 限制
- 全自动通道仍未真机跑通完整链条（沿用 v1.4.0 标注），异常随时可用状态条「停止全自动」接管。
- 本地 link: 安装需从托盘彻底退出 DSH 再重启才加载新 bundle。

## 版本同步
`package.json`（version / description / files 加入本文件）、`lib/client.js`（PLUGIN_VERSION + 双语 infoSummary）、`README.md` / `README.en.md`、`CHANGELOG.md`、`locale/zh.json` / `locale/en.json`、本文件。

## 自检
`node --check lib/client.js`（SYNTAX OK）；`node test/check-client.mjs`（`RESULT: PASS`，含 6 条 v1.4.4 双模式断言）。
