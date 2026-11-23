# v1.4.6 发布说明 — 全自动流程初步真机验证通过 / 决策卡架构重做 / 停机与模式切换完善

> ✅ **全自动流程初步真机验证通过，正在不断完善中。** 三方协作链（网页审查 agent ⇄ 桌面开发 agent ⇄ 你决策）已能经全自动通道无人值守跑通并完成真机验证；功能仍在持续打磨，建议先小范围试用，异常可用状态栏「■ 停止全自动」随时接管。

## 一句话

这是 1.4.5 包上的真机验证修复批（代码内以 `v1.4.6-hotfix-1~9` 标记）：把全自动投递通道从「实验性、会误判熔断、暂停后卡死、决策卡藏在状态条」打磨到「决策卡为 DSH 原生观感浮窗、命中即弹且可续跑、错误词不误判、停止彻底停机、一键切回半自动」。

## 需求来源

当天多轮真机全流程验证（截图 + DSH leveldb `loop-trace` 落盘证据）暴露的问题：

- 审查 agent 回投正文里 `TypeError` 内嵌的 `Error` 被子串匹配当成熔断词 → 链条在轮 2 被误判暂停（hotfix-1）。
- max-loops / error 熔断只写 `state:"paused"` 不设 `pilotDecision` → 状态栏显示「已暂停」却没有任何卡片按钮，用户无法续跑（hotfix-2 起步）。
- 「继续并补推本轮」把回复提交回桌面会话而非推给网页审查 agent → 通道方向写反（hotfix-3）。
- 审查 agent 自定义标记 `[NEED_USER_CONFIRM]` 不在内置介入词表 → 无法触发暂停分支（真机改用原生词「需要人工介入」绕过；此项列为遗留评估）。
- 决策卡先藏在网页状态条、后搬到会话 turn 尾部小卡，观感与可用性都不达标 → 最终改为 `shell.overlay` 原生 Modal 观感浮窗（hotfix-5/6/8）。
- 停止全自动只回退到半自动（偷偷开条件触发），设置页 checkbox 不同步；停机后无直达半自动入口（hotfix-7/9）。

## 实现要点

1. **错误词词边界**（hotfix-1）：`containsErrorKeyword` 对纯字母错误词用词边界正则 `(^|[^a-z])word([^a-z]|$)`（借鉴 `isPureDoneText`），独立词命中、`TypeError` 内嵌不命中；非字母自定义关键词维持 `indexOf`。
2. **暂停态必弹卡**：max-loops / error-keyword 熔断改走 `setPilotDecision({kind,payload,reason})`，状态栏不再出现「已暂停却无卡」的死状态。
3. **resume-push 方向**（hotfix-3）：`decide("resume-push")` 由返回 `submit`（走 `tryAutoSubmit` 落到桌面）改为返回 `push-web` → `pushAnswerToWeb` 推网页审查 agent；全卡型首位都带此入口。
4. **决策卡架构重做**（hotfix-3/5/6/8）：网页状态条 → 桌面会话 `conversation.chat.turnTail` → 原生 `shell.overlay` 浮层；按 DSH 原生 Modal 观感自绘（居中、遮罩变暗、标题栏关闭 ×、分隔内容区、footer 规整按钮），`createPortal(children, document.body)` 绕开 overlay slot 的 containing block 让遮罩铺满全屏。官方禁止第三方 bundle `require('@deepseek-ai/dsh-client-ui-primitives')`，故复制 Markup/CSS/行为（focus + Escape）到本包、类名加 `dscModal*` 前缀、保留 `--dsw-alias-*` token，零新增依赖。
5. **动态问题/选项**（hotfix-8）：问题文本与选项按当轮拦截内容实时生成（超长摘要截断），不写死固定文案。
6. **设置项默认关闭**（hotfix-4）：初始化归零残留 `config.autoPilotEnabled`，消除「设置页勾选但状态条未启动」。
7. **豆包状态齿轮直达设置**（hotfix-4）：`focusDeepSeekChatSection` 导航 label 扩展为含「豆包 聊天 / Doubao Chat / platformDisplayName()」。
8. **停止彻底停机**（hotfix-7）：停止按钮两开关都关，不再偷偷回退半自动；`SettingsView` 订阅 `subscribeConfig` 让 checkbox 随状态条启停同步刷新。
9. **一键切回半自动**（hotfix-9）：停机且已配对时状态条出现「切回半自动」，点击只切开关、复用现有配对不解绑，靠配置订阅自动 off→idle。
10. **零回归**：`classifyPilotReply` 判定优先级、官方 `conversation.send` 提交路径、定界区块提炼逻辑均未改；新增多条 hotfix 回归断言全程 `RESULT: PASS`。

## 遗留评估

- `[NEED_USER_CONFIRM]` 字面不在内置介入词表：真机已改用原生词「需要人工介入」绕过，是否将其补入默认介入词表留待后续决定。

## 版本同步

`package.json`（version 1.4.5→1.4.6 / files 加入本文件）、`lib/client.js`（PLUGIN_VERSION）、`README.md` / `README.en.md`、`CHANGELOG.md`、本文件。

## 自检

`node --check lib/client.js` / `node --check test/check-client.mjs`（SYNTAX OK）；`npm test`（`RESULT: PASS`，含 hotfix-1/5/6/7/8/9 全部回归断言及既有信号词/决策卡/软重试断言）。
