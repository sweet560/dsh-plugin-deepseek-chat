# v1.4.5 发布说明 — 修复全自动死循环 / 适配 DSH 0.2.2-rc.5

## 一句话
全自动通道收到「`DONE` + `<TO_DEV>任务已完成</TO_DEV>`」这类**区块内只是完成语义**的回复时，现在判 `done` 正常终止，不再把「任务已完成」当新任务回投——死循环、重复回复、180s 超时一并解决。

## 需求来源
真机核验（当天全流程截图 + DSH leveldb `loop-trace` 落盘证据）：v1.4.4 及之前，网页审查 agent 用输出契约里的格式把「任务已完成」也写进 `<TO_DEV>` 区块，`extractPilotPayload` 的「定界区块优先」策略把这段当成新任务继续回投，导致 DONE→回投→再 DONE 反复，连续两次相同回复未被拦住，最终吃满 `DEFAULT_REPLY_TIMEOUT`（180s）超时，只能人工点「停止全自动」收场。

## 实现要点
1. **纯完成语义识别**：新增内部函数 `isPureDoneText(text, doneWords)`——英文完成词用词边界、中文完成词要求独占一行或短声明结尾，与无区块时的严格匹配规则一致。
2. **区块内终止判定**：`extractPilotPayload` 提炼出非空定界区块后，先过一遍 `isPureDoneText`；若区块整体只是完成语义，返回 `{ok:false, state:"done", reason:"done-word-in-block"}` → `classifyPilotReply` 走 `{action:"done"}` 正常终止链条，不再回投。
3. **真实任务不受影响**：区块内是实际开发任务（即使带「已完成审查，请修第5行」这类含「已…」字样）仍判 `continue` 正常回投；区块外散落的完成词依旧被忽略（维持 v1.4.2 行为）。
4. **统一逻辑**：无区块时的完成词判断也改用 `isPureDoneText`，消除两处重复实现，规则不再漂移。
5. **零回归**：`classifyPilotReply` 判定优先级、controller 生命周期、官方 `conversation.send` 提交路径、双模式互斥联动均未改。

## 适配版本
实机核对宿主 `@deepseek-ai/dsh-desktop` 与内置 `@deepseek-ai/dsh-desktop-runtime` 均为 `0.2.2-rc.5`，故把「当前声明」从 `0.2.2-rc.3` 更新到 `0.2.2-rc.5`：`package.json` 的 `engines.dsh`、`README.md` / `README.en.md` 当前版本行与环境要求表。历史记录中的 rc.3 按约定保留不动。

## 版本同步
`package.json`（version 1.4.4→1.4.5 / files 加入本文件 / engines.dsh）、`lib/client.js`（PLUGIN_VERSION）、`README.md` / `README.en.md`、`CHANGELOG.md`、`docs/全自动流程使用介绍.md`、本文件。

## 自检
`node --check lib/client.js`（SYNTAX OK）；`node test/check-client.mjs`（`RESULT: PASS`，新增 2 条 v1.4.5 回归断言：区块内纯完成语义判 done、区块内真实任务仍判 continue）。
