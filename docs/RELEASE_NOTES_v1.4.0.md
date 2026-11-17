# v1.4.0 发布说明 — 全自动投递通道

## 一句话
在原有「条件触发式自动闭环」之上，新增一个可开关的「全自动投递通道」：桌面会话（开发 agent）一轮完成 → 自动回传 chat.deepseek.com 并附上输出契约 → 审查 agent（网页）只把要交代的内容放进定界符 → 插件只提炼这一段写回桌面草稿 → 用官方 `conversation.send` 自动提交下一轮，如此往复，直到语义通过或需要你本人接管时暂停弹决策卡。网页全文绝不投递，只传定界区块，省上下文、省 Token。

## 需求来源
- m00002：创建全新的「自动投递通道」，把三者串成全自动链条——DSH 桌面会话＝开发 agent（暂定 hy4-flash，后期或换 deepseek V4）、deepseek 聊天＝思考和审查 agent、用户＝决策者。
- m00077（用户卡片决策）：自动化边界＝混合（默认自动、随时接管）；启动/终止由用户定；网页端输出需要提炼（如只把 `***` 这一段传给桌面会话），不要盲目全文投递；遇到需要重启 DSH 或同内容重复 2 次即暂停弹卡片让用户选下一步；终止条件＝语义通过 + 最大轮数双保险；通道形态＝在现有插件加「全自动模式」。
- m00295：新增触发用户选择卡片的关键词（「请重启宿主验收」「宿主验收」等），命中即必须由用户本人接入。实现为独立可配置的 handoff（用户介入词）类别。

## 为什么不自己造轮子
- 自动提交主路径直接调用 DSH 官方公开 API `conversation.send(text: string): Promise<void>`（内部即 `session.prompt([...], 'queue')`），一行调用、异步可捕获错误、无视草稿锁定、不碰 DOM。取证见 `app.asar` 内 `.d.ts`（@32359122）与官方调用范式（@68344954 / @69768129）。
- `InputActions.submit()` 与 `SessionInputResolver.requestDraftInitialization()` 的签名来自同一份官方 `.d.ts`（@31769000 / @31766000），沿用而非另造。
- 坚持「网页全文绝不投递、只写提炼区块」与「绝不合成键盘/点击为首选」——项目在 v1.3.0 曾因原生 setter 直写 DOM 清残留翻车并回退，本版主路径完全不碰 DOM。

## 实现要点
1. **配置层**：新增 `autoPilotEnabled`（默认关）、`pilotAutoSubmit`（默认开）、`pilotMarkerStart/End`（默认 `<TO_DEV>` / `</TO_DEV>`）、`pilotDoneKeywords`（DONE/完成/通过/APPROVED）、`pilotRestartKeywords`、`pilotHandoffKeywords`（请重启宿主验收/宿主验收/请用户验收/需要你本人/需要人工介入/handoff to user/user verification）、`pilotOutputContract`（输出契约模板，含 `{start}/{end}/{done}` 占位符）。全部纳入 `DEFAULTS`、`readConfig` 校验、`writeConfig` 合并与设置页。
2. **提炼**：`extractPilotPayload(reply, cfg)` 完成词优先于定界符，用 `indexOf` 按字面量截取（定界符可含正则元字符），返回 `{ok,text,state,reason}`，state∈`ok|no-marker|done|empty`；无区块绝不盲投全文。`buildPilotPush(answerText,cfg)` 在正文末尾追加带占位符替换的输出契约。
3. **判定中枢**：`classifyPilotReply(replyState, prevPayload, cfg)` 按优先级 done→restart→handoff→duplicate→error→max-loops→no-marker→continue；重复检测对文本去空白后与上轮比较（同内容出现 2 次即暂停）。
4. **自动提交**：`tryAutoSubmit(rt,text)` 用 `ctx.get("conversation").send()`（回退官方会话定向范式 `sessions.scope(paired).get("conversation")`）；成功回 `idle` 等下一轮 turn/end；无 API 或抛错则降级为 `submit-unavailable` 决策卡（「请按发送」，绝不合成键盘/直写 DOM）。
5. **controller 扩展**：新增运行开关 `autoPilot`、当前决策卡 `pilotDecision`、上轮提炼文本 `lastInjectPayload`，以及 `startPilot/stopPilot/setPilotDecision/notePilotInjected/beginPilotSubmit/notePilotSubmitted/decide`。`decide(action, editedPayload)` 支持 continue / edit / retry / terminate，全程用户掌控。
6. **数据流接线**：推送时若全自动激活则追加输出契约；网页回复完成后若全自动激活则走 `handlePilotReply` 提炼判定中枢（continue 才写草稿并自动提交，done/pause 即弹卡）；半自动带回（v1.2.1）老路径零回归。
7. **UI**：状态栏加「▶ 启动全自动 / ■ 停止全自动」按钮与决策卡（按 kind 显示原因文案，继续/编辑/重试/终止）；设置页新增第五张「全自动投递通道」卡片（总开关、自动提交、定界符、三类关键词、输出契约）。
8. **测试**：离线自检新增 R 段（纯函数/判定优先级/handoff/controller 生命周期/自动提交成功与降级/只写提炼区块/启停），既有关卡「设置页卡片数」从 4 调整为 5；A–Q 全段 `RESULT: PASS`。

## 必须如实说明的限制
> ⚠️ **真机实验状态：v1.4.0 的「全自动投递通道」尚未经过真机实验。** 该功能仅通过离线自检（`node test/check-client.mjs`，`RESULT: PASS`），尚未在真实 DSH 桌面环境中跑通完整链条（桌面 turn/end → 回传网页 → 提炼定界区块 → 官方 `conversation.send` 自动提交下一轮 → 决策卡）。请在真机上先小范围试用并观察 loop-trace；遇到异常可用状态栏「■ 停止全自动」随时接管。原有的「条件触发式自动闭环」（v1.2.x）与半自动带回（v1.2.1）已经过实机验证，本版未改动其主路径。
- client bundle 在进程启动时缓存，改完需从托盘**彻底退出 DSH 再重启**才会加载 v1.4.0 的新模式；单纯的页面刷新不够。
- 自动提交依赖官方 `conversation.send`。当运行环境拿不到该 API（旧版本 DSH / 受限会话）时，全自动仍可把提炼区块写进草稿，但会弹「请按发送」卡请你手动提交——这是设计内的诚实降级，不是故障。
- 网页端是否按要求输出定界区块取决于审查 agent 是否遵守输出契约；没按格式输出（no-marker）会暂停弹卡，不会盲目把全文丢给桌面。
- 本机若为 `link:` 本地安装，设置页「一键更新」会被官方 `updateRefusal` 拒绝，属预期行为；正式 npm 安装用户不受影响。

## 升级 / 安装
从 npm 安装：`dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat`。改本地源码后需从托盘彻底退出 DSH 再重启才会加载新 bundle。纯 Web 表层（`dsh web`）没有桌面壳 guest 租约桥，插件不注册属正常。

## 本版文件
`lib/client.js`（常量 / 配置 / 纯函数 / controller / 数据流 / UI / 导出）、`test/check-client.mjs`（R 段 + 卡片数断言）、`package.json`（版本 + 描述 + 发布说明入 files）、`README.md` / `README.en.md`、`CHANGELOG.md`、`locale/zh.json` / `locale/en.json`、本文件。

## 自检
`node --check lib/client.js`、`node test/check-client.mjs`（`RESULT: PASS`）、`git diff --check` 全部通过。

## 发布状态
已发布 v1.4.0（含「全自动投递通道尚未经过真机实验」标注）。注意：**全自动投递通道为实验性功能，仅通过离线自检，尚未真机验证**，请小范围试用并观察 loop-trace。
