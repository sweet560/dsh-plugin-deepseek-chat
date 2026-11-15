# Changelog

All notable changes to this project are documented here.

## 1.2.2 — 2026-11-15

### 修复实机「内容填入网页输入框后无法自动发送」：把发送触发从 `requestAnimationFrame` 改为同步立即点击 + `setTimeout` 重试

- **症状 / 用户确认**：User said (m01689): 「目前已经能够实现，将内容 传到 网页输入框了，但是没法自动发送出去（需修复）」；User said (m01734): 「经过手动 操作，将网页输入框内容 发送出去后，获得的回复会自己传入到你的输入框内。现在就差 之前说的 传入网页输入框后 自动发送的问题还没修复了」。即：网页→桌面「回传 / 注入」链全通（手动发送后网页回复会自动写入 Harness 草稿），整条闭环只差「填入网页输入框后自动发送」这一环；此前实机 `dsh-plugin-deepseek-chat:loop-trace` 两次 180s `state:timeout` 的根因就是网页从未开始生成 → 停止按钮不出现 → DOM 抓取超时。
- **根因（决定性）**：v1.2.0/1.2.1 的 `BRIDGE_IMPL.fillAndSend` 把「点击发送按钮 / 键盘兜底」整体包在 `window.requestAnimationFrame(doSend)` 里。DeepSeek 面板 / 右边栏卡片是 `<webview>`，当用户切回主会话操作 Harness 时该 guest 被遮挡 / 隐藏，Chromium 对隐藏 renderer 的 rAF 节流为 0 → `doSend` 回调永不执行 → 文本经 native setter 填入成功（所以「传到输入框」看得到），但既没有点击发送按钮、也没有发键盘事件。次要诱因：`DEFAULT_SEND_SELECTORS` 未覆盖真实动态 class 按钮；键盘兜底用 `ctrlKey:true`，而 DeepSeek 默认是「Enter 发送 / Shift+Enter 换行」（[DeepSeek-V3 issue #1110](https://github.com/deepseek-ai/DeepSeek-V3/issues/1110)、[Enter Key Control 扩展](https://chromewebstore.google.com/detail/chatgpt-enter-key-control/nllncjgkdkcabkomghcfgfaplgdnlcjo)）；合成 `KeyboardEvent` 是 untrusted，仅在无按钮可点时兜底。
- **修复（`lib/client.js` 的 `BRIDGE_IMPL` 纯字符串页面桥，全部落在插件边界内）**：
  - **彻底移除 `requestAnimationFrame` 发送触发**。新增 `currentBox / sendMethod / sendAttempts / sendClicks / sent` 5 个模块内状态；`fillAndSend` 现在 `currentBox = box; scheduleSends();` 后即返回 `{ok, phase:"armed", baseline, method, attempts}`。
  - `boxIsEmpty(box)`（contenteditable 取 textContent、否则 value，trim 判空）；`findSendButton()`：先 `sendButton()`（可配置选择器），否则 `document.querySelectorAll("button, [role='button'], [data-testid]")` 通用扫描 aria-label / title / innerText 含 `/发送|送出|Send|Submit/i` 且非 disabled 的元素（覆盖 DeepSeek 动态 class）；`keySend(ctrl)` 派发 `KeyboardEvent('keydown')`；`attemptSend()` 同步立即点击、`sent` 幂等、记 `sendMethod="click"`；`keyFallback()` **普通 Enter 优先**、输入框未清空才补 Ctrl+Enter、记 `sendMethod="enter+ctrlEnter"`。
  - `scheduleSends()`：同步 `attemptSend()` 首试（按钮此刻已 enable 就立即发送）→ 若有 `window.setTimeout` 则按 `delays=[120,320,700,1400,2800]` 逐次重试点按钮（覆盖 React 受控按钮延迟 enable），另 1000ms 键盘兜底；每个回调先判 `boxIsEmpty(currentBox)`——输入框被清空 = 真实已发送信号，直接停手不重复点；`typeof window.setTimeout === "function"` 判空，离线测试桩无定时器时 `if(!sent) keyFallback()` 直接键盘兜底，绝不出现「填了但不发」。
  - `snapshot()` / `status()` 暴露 `sendMethod / sendAttempts / sendClicks / sent`；`reset()` 重置 5 个变量；`fillAndSend` 的 `method` 写进 `pushAnswerToWeb` 的 loop-trace（`lastSendMethod` / `lastSendAttempts`），实机可用 `test/verify-runtime.cjs` G 段客观复核实际采用的发送方式。
- **零回归**：只改页面桥的发送触发，不动三道安全阀、`turn/end` 订阅、`setDraft` 不 submit、半自动带回、DOM 抓取轮询、失败隔离。`BRIDGE_IMPL` 仍为可离线断言的纯字符串常量、返回对象 `__v:3` 自愈机制不变；`makeWebviewBridge` / `buildBridgeConfig` / `ensureBridgeExpression` 契约不变。
- **Verification**：`node --check lib/client.js` / `node test/check-client.mjs` → `RESULT: PASS`；新增 **K 段 8 条决定性断言**（自带 `makeGuest(opts)` 桩，`rafRuns:false` 模拟隐藏 renderer 的 rAF 永不调度）：① rAF 被节流为 0 时仍同步立即点击发送（`sendClicks===1`）；② `fillAndSend` 返回 `method=click` 供 loop-trace 复核；③ 选择器全落空 + 无定时器时键盘兜底先普通 Enter 再 Ctrl+Enter；④ `status()` 暴露 4 字段；⑤ 按钮此刻未 enable 时同步首试不误点；⑥ `window.setTimeout` 重试点中延迟 enable 的按钮；⑦ 源码已不含 `window.requestAnimationFrame` 调用；⑧ H 端到端 11 + I 追踪 7 + J 半自动 14 全绿。
- **Packaging**：版本升 `1.2.2`（`package.json` / `PLUGIN_VERSION` / 头注释 / 自检头注释同步）；C 段文案改为「同步立即点击发送按钮（v1.2.2 不再依赖 requestAnimationFrame，隐藏 webview 也能触发）」；中英 README / CHANGELOG 同步。
- **如实限制**：合成 `KeyboardEvent` 是 untrusted，若站点要求真实用户手势、且发送按钮选择器与通用扫描都落空，自动发送仍可能失败——此时 loop-trace 的 `lastSendMethod` 会给出线索，可在设置页补 `sync-send-selectors`。DOM 抓取（通道 B）与 v1.2.1 半自动带回的 180s 超时问题本次未改：用户 m01734 已确认「手动发送后网页回复会自动传回」，说明通道 B 在实机可用；全自动 DOM 停止按钮检测仍依赖站点 DOM，站点改版可改用半自动带回。按用户确认**先不推送发布**，改动只留本地工作区，未 commit / push / tag / 发布。

## 1.2.1 — 2026-11-15

### 半自动带回：借鉴官方内置实验性插件 `@deepseek-ai/dsh-deepseek-chat-import` 的结构化语义，绕开易超时的网页 DOM 抓取

- **背景/痛点**：v1.2.0 全自动闭环的通道 B 依赖 `[data-message-author-role="assistant"]` + `MutationObserver` 抓 `chat.deepseek.com` 的网页 DOM；实机 `dsh-plugin-deepseek-chat:loop-trace` 客观证据显示真实 `turn/end`(reason=completed) 到达、`send ok` 执行了回传-发送，但网页回复抓取两次都在 180s（`DEFAULT_REPLY_TIMEOUT`）后 `state:timeout`，`lastResponseCompleteAt` / `lastDraftInjectedAt` 始终未记录。DOM 选择器对站点改版极脆弱。
- **借鉴来源（直读 app.asar 取证，不照抄）**：官方昨天更新的内置实验性插件 `@deepseek-ai/dsh-deepseek-chat-import` v0.2.2-rc.3 **不 scraper 网页 DOM**，而是解析 `chat.deepseek.com` 导出的 `export_format_version:3` 结构化 JSON（`src/format.ts` 的 `exportMessage` / `fragmentEnvelope` / `knownFragment` 判别联合，`src/conversation.ts` 的 `selectBranch` / `replySteps`）：按 `current_message_id`（缺失/为 null/指向不存在时回退最大 id）选叶、沿 `parent_id` 回溯到 root、`reverse()` 成链；回答只取 `type==='RESPONSE'` 的 `content`（跳过 `THINK` / `TEMPLATE_RESPONSE` / 工具 / `READ_LINK`），`CONTENT_FILTER` 与非 `FINISHED` 状态不进模型上下文；Host 用 `Session.create` 写成 Harness 会话，且整条路径由用户在 UI 显式上传 ZIP 触发。
- **落点（全部在插件边界内、默认关闭、不消耗额外 API 额度）**：新增 `halfAutoEnabled`（默认 false）半自动子模式——通道 A（turn/end → 回传-发送）仍自动，`pushAnswerToWeb` 的 send `ok` 后**跳过** `startReplyPolling`（不再等 DOM 停止按钮/180s 超时），状态停在 `waiting` 并提示「请粘贴网页回复」；状态条新增带回区（textarea + 按钮），用户把网页回复纯文本或官方导出会话 JSON 粘回来 → `extractExportReply()` 按上述官方契约解析 → `bringBackReply()` 调 `injectDraft(rt, controller.noteReply(text))` 写桌面草稿（**只 `setDraft()`、绝不 `submit()`**）+ 补齐 `lastResponseCompleteAt` / `lastDraftInjectedAt` 追踪 + `acknowledge()` 回 `idle`，下一轮是否开启仍由用户判定。这是「自动只搬运和发送、是否继续跑由用户决定」原则在更稳健载体上的延续，也是 v1.2.0 DOM 通道失败时的替代路径。
- **解析函数**（纯函数、可离线断言、暴露于 `__test__`）：`selectExportBranch(file)`（current_message_id/最大 id 选叶 + parent_id 回溯 + 防环 `guard=byId.size+1`）、`exportReplyText(message)`（只取 RESPONSE fragment 的 content，兼容把正文直接放在 `content` 字符串/block 数组的变体，走既有 `extractContentText`）、`extractExportReply(raw)`（空→`empty`；非 `{`/`[` 开头或 JSON.parse 失败→纯文本原样带回；对象取 `messages` / 数组末项 / `conversations` 末项作会话文件；倒序找 FINISHED 的 ASSISTANT 回答；否则 `no-finished-reply`）。设置页第 4 卡加 `sync-half-auto` 开关；状态条 `waiting` 用专属文案；`syncBringBack*` 4 个主题令牌样式 + 中英 COPY 各 8 个 key。
- **零回归**：`halfAutoEnabled` 默认 false，v1.2.0 全自动 DOM 路径与三道安全阀（总开关+maxAutoLoops、错误关键词熔断、同轮去重）完全不变；半自动仅改变通道 B 的载体，通道 A、`injectDraft` 绝不 submit、`acknowledge` 暂停语义、闭环追踪、失败隔离均沿用既有实现，未重复造轮子。
- **Verification**：`node --check lib/client.js` / `test/check-client.mjs` 通过；`npm test` → `RESULT: PASS`（新增 J 段 14 条断言：默认关闭零回归、纯文本/空输入、官方导出 JSON 按 current_message_id 分支取 RESPONSE、非 FINISHED / CONTENT_FILTER 跳过、current_message_id 缺失回退最大 id、真实运行单例下半自动跳过 DOM 轮询停在 waiting、带回只 setDraft 不 submit、追踪四阶段时间戳齐全、acknowledge 回 idle）；`git diff --check` 通过；`npm pack --dry-run` 文件清单不变。
- **Packaging**：版本升 `1.2.1`（`package.json` / `PLUGIN_VERSION` / 头注释 / 自检头注释同步）；中英 README / CHANGELOG 同步；`exports.__test__` 暴露 `selectExportBranch` / `exportReplyText` / `extractExportReply` / `bringBackReply`。
- **如实限制**：半自动需要用户**手动把网页回复粘回状态条**（或粘贴官方导出的会话 JSON），不是全自动抓取；它把「等待网页 DOM」换成「用户一次显式粘贴 + 结构化解析」，代价是多一步人工、收益是绕开 DOM 改版与 180s 超时。官方插件的 ZIP 导入 / Host `Session.create` / `TypertRemoteService` 能力本插件不复用（不需要把会话写进工作区，只需把回复写进当前草稿）。按用户确认**先不推送发布**，改动只留本地工作区。

## 1.2.0 — 2026-11-15

### 条件触发式自动闭环：桌面执行完成 → 自动回传网页并发送 → 等网页回复完成 → 抓取注入桌面草稿 → 等用户判定下一轮

- **需求**：在插件内部完成闭环改造、不依赖外部自动化工具、不消耗额外 API 额度（复用已登录的 `chat.deepseek.com`）。核心是把「手动点击才搬运」升级为「桌面端执行完成 → 自动回传网页并发送 → 自动等待网页回复完成 → 自动抓取并注入桌面端 → 等你判定是否开启下一轮」的条件触发式自动循环。「自动」只发生在**搬运和发送**环节，「是否继续跑」的决定权始终在用户手里。三道安全阀：① 总开关 + 最大轮数；② 错误关键词熔断；③ 同一轮次去重。选择器抽成可配置数组在设置页暴露。
- **事实核查推翻了原方案的两个前提**（直读 `F:\DeepSeek Harness\resources\app.asar` 取证）：① 本插件 `lib/client.js` 是纯浏览面板，没有任何「带走/喂回去」搬运逻辑，是**从零加功能**而非升级；② 本机 DSH 构建**没有** `dsh-client-ui-webchat` / `dsh-hooks-bus` 包，也没有 `ctx.hooksBus.on('TurnEnd')` 事件——真实事件是 `'turn/end'`（SessionEventMap，`dsh-agent-loop/src/agent.ts:428` `this.session.append('turn/end', {turn, reason})`），`TurnEndReason` 是**判别联合对象**（`{kind:'completed'|'error'|'aborted'|'blocked'|'max-tokens'}`），不是字符串。照抄伪代码会跑不起来。
- **preload / `ipcRenderer.sendToHost` 通道在本机被主进程封死**：`lib/main.js:18153-18178` 的 `will-attach-webview` 先 `for (const key of Object.keys(preferences)) if (key !== "disablePopups") Reflect.deleteProperty(preferences, key);`，再强制 `Object.assign(preferences, {nodeIntegration:false, contextIsolation:true, sandbox:true, webviewTag:false, ...})`。插件在 `<webview>` 上设的自定义 `preload` / `nodeintegration` 会被全部清除；`sandbox:true` 下也没有 `ipcRenderer.sendToHost`。全 asar 里 `executeJavaScript` 只出现在 DevTools AI 助手代码，与 webview 无关。
- **替代方案（全部落在插件边界内、不改 DSH 本体）**：
  - **双向通道**用 Electron `<webview>` 元素**内建**的 `executeJavaScript(code): Promise<any>`（在 guest 主世界执行、可访问 DOM、返回最后表达式值）。`BRIDGE_IMPL` 是纯字符串常量（无模板插值，便于嵌进表达式并离线断言）：`fillAndSend(text)` 用 `Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(box, value)` + `dispatchEvent(new Event('input', {bubbles:true}))` 触发 React 受控更新（否则发送按钮仍 disabled），`requestAnimationFrame` 里先 `sendButton().click()`、失败回退 Ctrl+Enter `KeyboardEvent`；`armResponseWatcher` 只在主动发送后武装 `MutationObserver`（observe `document.body` `{childList:true,subtree:true,attributes:true,attributeFilter:['class','disabled']}`），停止按钮「有→无」判定生成完成，从 `[data-message-author-role="assistant"]` 等可配置选择器抓最后一条 assistant 文本；`poll()` 带 `replyTimeout=180000` 超时 + 文本长度连续两次不变兜底判完成，且要求 `txt !== baseline`（发送前的基线）才算 done。`ensureBridgeExpression()` 按 `__v!==3` 自愈重装（guest 导航后 `window.__dshDeepSeekBridge` 会丢）。插件侧用**浏览器全局 `setTimeout` 递归**轮询 `poll()`（不用 `setInterval`：vm 测试桩没有，且 guard 的 `ctx.setTimeout` 需声明 `'timer'` inject）。
  - **轮次结束 / 回答读取**走官方 `sessions` 服务：`ctx.get("sessions")`（**软读**，`guard.ts:220` 允许；不写进 `exports.inject`、不直接 `ctx.sessions`，否则晚到服务会 park 整个 fiber）→ `sessions.binding(sessionId).eventSource.subscribe(...)` → 只处理 `change.kind === 'append'` 窗口（官方范例 `dsh-client-ui-chat/src/client/apply.ts:108-117`），遍历找 `event.type === 'turn/end'` 且 `event.data.reason.kind === 'completed'/'max-tokens'`，用 `collectAnswerText(snapshot, turn)` 从该轮 `assistant/message` 的 `message.content` 文本块取回答（兼容 `block.type` 与 `block.kind` 两种字段名，见 `system-prompt.ts:64` / `turn-assistant.ts:9`）。
  - **「注入但不执行」**走官方 `InputActions.setDraft(text)`（`dsh-client-ui-conversation/src/client/contract/input.ts:281`，`setDraft` 写草稿、`submit()` 才发送）。通过注册一个隐藏的 `conversation.composer.dock` 槽组件（`slot-catalog.ts:960-990` standardProps 含 `inputActions` / `sessionId`）拿到该面；**绝不调用 `submit()`**，网页回复只写进桌面草稿，是否点「继续/运行」由用户决定。
  - **三道安全阀**在 `createSyncController.handleTurnEnd()` 里顺序判定：① `autoSyncEnabled`（默认 **false**）关闭直接 skip、`loopCount >= normalizeMaxLoops(maxAutoLoops)`（默认 3、clamp[1,20]）→ `paused(max-loops)`；`paused` / `busy(pushing|waiting)` 状态跳过；② `containsErrorKeyword(answerText, errorKeywords)`（默认 `Error/Traceback/Failed/panic/FATAL`）→ `paused(error-keyword)`，不自动回传；③ `Map<sessionId, Set<sid:turn>>` 同轮去重，重复 TurnEnd 直接 skip。非 `completed/max-tokens` 轮次、空文本也跳过。默认关闭时状态条隐藏、dock 不注册，闭环完全不启动。
- **设置页第 4 张卡片**：总开关 `sync-enable`（默认关）、`sync-max-loops`（数字 1–20）、`sync-error-keywords`（逗号/换行分隔）、4 组可配置选择器 `sync-stop-selectors` / `sync-send-selectors` / `sync-textarea-selectors` / `sync-assistant-selectors`（每行一个，避免硬编码 DeepSeek 动态类名如 `._480132b`）；`COPY` 中英各补 28 条文案。配置经 `readConfig`/`writeConfig` 逐字段类型校验 + 数组克隆（防引用污染），复用 `localStorage` 的 `dsh-plugin-deepseek-chat:config`。面板顶部 `SyncStatusBar` 显示状态（off/idle/pushing/waiting/injected/paused/error/timeout）、`loopCount/max`、熔断后「重置」与「复制回复」手动兜底按钮。
- **失败隔离**（沿用既有铁律）：所有 guest 调用 `typeof element.executeJavaScript === 'function'` 保护 + 全 try-catch；dock 订阅用 `ctx.get("sessions")` 软读，失败优雅降级为面板状态条提示 + 手动复制；`syncRuntime` 是模块级单例，`ChatPanel` 创建 webview 时挂 `bridge`、cleanup 用 `ownsBridge` 判断只清自己挂的那个（防切换面板时旧 cleanup 误清新桥）；所有 disposer / 事件监听 / timer 由 `ctx.effect` 持有。任何一步拿不到就降级，绝不抛错崩 `root` slot。
- **可选闭环追踪 + 「触发+观测」实机验证（v1.2.0 增补，默认关闭时零写入）**：为把「插件确实执行了回传」从推测变成证据，新增 `LOOP_TRACE_KEY = "dsh-plugin-deepseek-chat:loop-trace"`——`writeLoopTrace()` 把各阶段时间戳写进 `window.localStorage`（Chromium 落盘到主窗口 `<UserData>/Local Storage/leveldb`，与 `dsh-plugin-deepseek-chat:config` 同源），`createSyncController` 经可选 `onTrace(snapshot, reason)` 钩子（`ensureSyncRuntime` 传 `traceControllerState`）在状态迁移时联动写入；`onSessionEvents` / `pushAnswerToWeb` / `startReplyPolling` / `injectDraft` 分别埋 `lastTurnEndAt` / `lastSendResult` / `lastResponseCompleteAt` / `lastDraftInjectedAt` 及 `events` 阶段流水（封顶 `LOOP_TRACE_EVENT_CAP = 40` 条、`paused/error/timeout` 写 `lastAbortReason`）。首行 `if (!getConfig().autoSyncEnabled) return;` 保证**默认关闭不写**，整体 try-catch 不让观测拖垮闭环。脚本侧：共享只读读取器 `test/lib/read-leveldb.cjs`（复刻 latin1/utf16le 双编码 + 花括号配平截 JSON），`test/verify-loop-runtime.cjs` 是零依赖「触发+观测」脚本，`test/verify-runtime.cjs` 增 G 段读四阶段时间戳做客观复核。**如实改道**：本机 `dshx` / `dsh-exec` 不存在（`where` / `npm view` / 安装目录全扫无命中）、`dsh-ops` 无触发 turn 子命令，故脚本「触发」为可选、缺失时诚实降级不伪装；renderer `contextIsolation:true, sandbox:true` 无 Node fs、写不了 `~/.dsh/.../loop-trace.json`，真实载体是 `window.localStorage`；真实事件是 `'turn/end'`（reason 判别联合对象）、无 `dsh-hooks-bus` 包；并修掉原脚本两处会崩的 bug（前置 `spawn --status` 异步 error 未 await、主 spawn 无 `'error'` handler）。脚本能证实「真实 TurnEnd 触发 + 回传/发送/抓取/注入动作序列」；**最后一厘米**（草稿是否出现在 `<webview>` 网页输入框、有没有被自动执行）仍需肉眼确认，脚本无法访问 guest DOM。
- **Verification**：`node --check lib/client.js` / `lib/index.js` 通过；`npm test` → `RESULT: PASS`（离线 vm 内新增约 40 条断言：默认关闭 + `DEFAULTS` 12 字段 + `normalizeMaxLoops` clamp + 选择器归一化 + readConfig/writeConfig 新字段；`extractContentText` 兼容两种文本块 + `eventAnswerText` + `containsErrorKeyword` + `collectAnswerText` 按 turn；`BRIDGE_IMPL` 经 `new Function` 编译 + 三个表达式语法合法 + **模拟 DOM 真跑** `fillAndSend`（断言原生 setter 写入 / input / change / 发送按钮点击）与「停止按钮 有→无」抓到 `phase==='done'` 的网页回复；状态机三道安全阀 disabled / turn-not-completed / error-keyword / max-loops / busy / duplicate 全覆盖 + notePushed/noteReply→injected；`injectDraft` 只 `setDraft` 不 `submit`；`onSessionEvents` 从 append 窗口解析 reason+本轮文本、replace 不误触发；状态条默认 null、设置页 7 个 `sync-*` 控件、总开关 change 写配置）；`git diff --check` 通过；`npm pack --dry-run` 文件清单不变。
- **Packaging**：版本升 `1.2.0`（`package.json` / `PLUGIN_VERSION` 同步，`test/check-client.mjs:439` 断言两者相等）；中英 README / CHANGELOG 同步；`exports.__test__` 暴露 33 个新符号供离线自测。
- **如实限制**：① 依赖 `chat.deepseek.com` 当前 DOM，站点改版后可在设置页改选择器；`executeJavaScript` 在 guest 主世界运行，若站点 CSP 或 DSH 未来收紧 `webview` 权限，页面桥可能失效——此时状态条降级为手动复制，不自动执行下一轮。② 依赖官方 `sessions.binding().eventSource` 与 `conversation.composer.dock` 的 `inputActions`（均为当前 DSH 0.2.2-rc.3 实测存在的契约），若上游改名，`syncAutoLoop` 会因拿不到 binding 而保持关闭、不会崩面板。③ 本机是 `link:` 本地安装、「检查更新/一键更新」行为不变（v1.1.10 已知限制）。④ 按用户确认**先不推送发布**：不 commit / 不 push / 不 tag / 不建 Release，改动只留本地工作区。

## 1.1.10 — 2026-11-13

### 设置页「一键更新」：与检查更新集成、真调 Host 官方通道、失败如实提示

- **需求（m04558 / 卡片 m04643）**：设置页「检查更新」发现新版本后，在红框位置跳出「立即更新」按钮，点击一下就自动更新插件；用户选择「真调用官方通道 + 失败如实提示」与「升到 1.1.10，先不发布」。
- **现成通道（不重复造轮子）**：复用 DSH Host 的 `pluginManager.updateBundle(name, version)`（`@deepseek-ai/dsh-plugin-manager/lib/index.js:2557`），客户端动态插件在**点击时**用 `ctx.get("remote")?.pluginManager?.updateBundle(PLUGIN_NAME, latest)` 软读调用。guard 允许 `ctx.get(name)` 软读（`dsh-cordis-client-runner/src/client/guard.ts:220`），返回 `guardedService` Proxy；`.pluginManager` 是非函数命名空间被 `denyContext` 原样放行，`updateBundle` 的 `this` 仍绑定该命名空间。**不把 `remote` 写进 `exports.inject`**（仍 `["slots"]`）——冷启动时若声明的 Host 服务晚到，runner 会把整个插件 fiber park（`runtime.ts:393`），其余三个入口全失效。
- **状态映射**：`runUpdate(ctx, version, onChange)` 全程 try/catch、状态经 `setUpdateState` + `onChange` 发布。按 `PluginUpdateResult.result.application` 分：`applied` → 「更新完成」；`restart-required` → 「已安装，请重启 DSH 生效」（无 HMR 时 `src/index.ts:1381` 返回此态）；`failed` / `cancelled` / `overridden` → 「更新失败：<原因>」。错误对象可能是 `{code, diagnostic}` 而非 `Error`（`refusedBefore` 的 link: 拒绝路径就没有 `message`），所以原因取 `error.message ?? error.diagnostic ?? error.code`。无 `updateBundle` 时提示「当前环境无法调用插件更新通道」。
- **UI**：`COPY` 新增中英 7 条文案；`updateState` 扩出 `updating / updated / restart-required / update-failed`；`updateStatusLine()` 增加相应分支；「立即更新」按钮**只在 `status === "found"`** 出现在 `update-status` 结果区（截图红框位置），带 `data-dsh-plugin-deepseek-chat: "update-now"`、复用 `styles.updateButton`；`showLinks` 扩到所有终态，npm / GitHub 跳转链接始终保留作手动兜底；`makeSettingsView(ctx)` 传入 ctx 供按钮软读。
- **如实限制**：本机是 `link:` 本地安装，`updateRefusal`（`lib/index.js:1693` `installed neither from a registry under its own name nor from a Git commit`）必拒绝更新；只有从 npm 正式安装的真实用户能一键成功。本机 v1.1.9（未发布）高于 npm 已发布 1.1.8，改完点「检查更新」仍是「已是最新版本」、按钮不出现，须等发布更高版本才可见。
- **Verification**：`node --check lib/client.js` 通过；`npm test` → `RESULT: PASS`（测试桩 `makeCtx` 新增 `remote` 软读分支 + 可配置 fake `pluginManager.updateBundle`；新增「idle 不出按钮 / found 才出按钮 / 点击真调且参数=包名+9.9.9 / applied / restart-required / link: 被拒如实显示 diagnostic / 无通道 / 失败后仍保留 2 个兜底链接」断言）；`git diff --check` 通过。
- **Packaging**：版本升 `1.1.10`，新增中文 `docs/RELEASE_NOTES_v1.1.10.md` 并加入 `package.json` 的 `files`；中英 README / CHANGELOG / locale 描述同步。
- **发布**：按用户确认**先不推送发布**——不 commit / 不 push / 不 tag / 不建 Release，改动只留本地工作区。

## 1.1.9 — 2026-11-13

### 修复「重启后需手动开关一次才出右边栏卡片」+ 右边栏卡片双路径（better-sidebar 正常运行 / DSH 原生直注）

- **根因（实锤）**：v1.1.8 用「500ms × 40 ≈ 20 秒」的**有限**就绪重试窗口等待 `ctx.get("betterSidebar")`。better-sidebar 0.31.1 声明 `inject = ['slots','sessions','locale','modules','connection','remote','remote.session']`，冷启动要等这些 Host 传输服务就绪、其 fiber 才 active，位于 `apply()` 内的 `ctx.provide('betterSidebar', service)`（`src/client/index.tsx:175`）才发生。若窗口在服务就绪前耗尽，卡片永远注册不上；手动关/开设置开关会触发 `sync()` 重读、此时服务早已就绪，于是「救回来」——这正是每次重启都要手动开关一次的原因。桌面日志无任何 v1.1.8 报错，印证「不是抛错，是重试窗口耗尽后不再尝试」。「已安装」≠「正常运行」，本次修复正是以「服务是否可用」为准（用户 m04379 / m04395 的证据要求）。
- **修复（就绪机制根治）**：去掉 `CARD_RETRY_MAX` 硬上限，改为三层触发、任一层到位即注册：① `ctx.on('internal/service', ..., { global: true })` 监听 Cordis 的服务就绪事件（provider fiber 变 active 时 `notify` 会补发 `internal/service`），收到 `betterSidebar` / `sidebarRightTabs` 立即 `syncCard()`；② 无界但可取消的 500ms 浏览器全局 timer 兜底（不能用 `ctx.setTimeout`，guard 的 `TIMER_VERBS` 要求声明 `'timer'`；也不能用 `ctx.inject`，动态插件的 guarded ctx 无该动词）；③ 每次 `sync()` 重读服务。所有 disposer / 事件监听 / timer 由 `ctx.effect` 返回的闭包统一清理，HMR / 卸载无残留。仍**不**把 `betterSidebar` 写进 `exports.inject`（runner 在服务缺失时会把整个插件 fiber park，导致其余表面全失效）。
- **检测与双路径（按用户 m04201 / m04379）**：不区分「装了但启动晚」与「根本没装」，纯以 `ctx.get("betterSidebar")` 是否返回带 `registerTab` 的可用服务（即「正常运行」）为唯一判据：可用 → better-sidebar `registerTab(cardDescriptor())`；不可用 → DSH 自带原生右侧栏 `ctx.get("sidebarRightTabs").register(nativeCardDefinition())` + `ctx.slots.inject('sidebar.right.pane.tab', ...)` 正文槽（`key = CARD_ID`；title 槽省略，chip 文字由 `definition.title(address)` 提供）。两路径互斥（`activeCardPath` 记录当前路径、相同则跳过以免重建 webview）；晚到的 betterSidebar 服务经 `internal/service` 事件把原生卡片注销并切换到 better-sidebar 卡片。原生服务由 shipped 包 `@deepseek-ai/dsh-client-ui-sidebar-right` 在 `apply()` 顶层提供，无启动竞态。
- **保留**：`config.showCard` 开关、卡片名称与 `title` thunk、Web 表层 inert 守卫、四处槽位注册（main / sidebar.panellist / settings.section / conversation.view）、关于本插件与检查更新、会话记忆与崩溃隔离。
- **Verification**：`node --check lib/client.js` 通过；`npm test` → `RESULT: PASS`（测试桩用可控 fake timer + `internal/service` 事件模拟，新增「两服务全缺席零卡片 / better 正常运行只走 registerTab 且原生直注跳过 / 原生直注 type+body 槽与 nativeCardDefinition 契约 / 服务晚到事件切换路径 / 无界 timer 推进 50 轮仍可注册 / cleanup 注销卡片、移除监听、取消 timer」等断言）；`git diff --check` 通过。
- **Packaging**：版本升 `1.1.9`，新增中文 `docs/RELEASE_NOTES_v1.1.9.md` 并加入 `package.json` 的 `files`。
- **发布**：按用户确认**先不推送发布**：不 commit / 不 push / 不 tag / 不建 Release，等用户从托盘彻底退出 DSH 重启、确认「不用手动开关也能出卡片」后再决定是否发布。

## 1.1.8 — 2026-11-12

### 修复右边栏卡片不出现的加载顺序竞态 + 支持版本更新到 DSH 0.2.2-rc.2

- **根因（实锤）**：v1.1.7 在 `apply()` 开头一次性 `ctx.get("betterSidebar")`，且不把 `betterSidebar` 写进 `exports.inject`。Cordis 的 `notify()` 只唤醒「在 `inject` 里声明了该服务」的 fiber（`if (!(name in fiber.inject)) continue;`），`ctx.get()` 软读不登记 dependent。`dsh.client.inject` 只保证工厂加载顺序、不保证 `provide()`/`apply()` 顺序；因此若 better-sidebar 的 `ctx.provide('betterSidebar', service)` 稍晚执行，本插件读到 `undefined` 后**永不重试**，`syncCard()` 静默 return，`registerTab` 从未被调用 → `getTabs()` 只有内置 6 项 → 设置页「侧边栏内容」与「+ 添加 Tab 插件」都看不到卡片。桌面日志无任何报错，印证「不是抛错，是根本没调用」。不是 0.31.1 接口变更、也不是 descriptor 写错。
- **修复**：保留软依赖（better-sidebar 缺失时其余功能照常），把一次性软探测换成「每次 `sync()` 都重读 `ctx.get('betterSidebar')` + 有上限、可取消的就绪重试」。`CARD_RETRY_DELAY = 500`、`CARD_RETRY_MAX = 40`（最长约 20 秒），只用**浏览器全局** `setTimeout`/`clearTimeout`（`ctx.setTimeout` 被 guard 的 `'timer'` inject 门禁挡住）；服务一到位立即 `registerTab`，`ctx.effect` 的 disposer 在 HMR / 卸载时 `cancelCardRetry()` + 注销卡片。不把 `betterSidebar` 写进 `exports.inject`（那会让 runner 在服务缺失时把整个插件 park，左侧栏 / 主面板 / 设置页全失效）。
- **支持版本**：中英 README「适配 DSH」/环境要求表、`package.json` 的 `engines.dsh`、`docs/RELEASE_NOTES_v1.1.7.md` 环境要求改为 `0.2.2-rc.2`；崩溃日志原文、旧发布说明与「当时核对的版本」等历史事实保留 `0.2.2-rc.1`，不篡改。
- **Verification**：`node --check lib/client.js` 通过；`npm test` → `RESULT: PASS`（新增「服务晚到也能注册」「就绪重试有上限」「ctx.effect cleanup 取消 pending timer」等断言，自检用可控 fake timer 驱动重试、不让真实 500ms×40 拖慢进程）；`git diff --check` 通过。
- **Packaging**：版本升 `1.1.8`，新增中文 `docs/RELEASE_NOTES_v1.1.8.md` 并加入 `package.json` 的 `files`。
- **CI 加固（1.1.8 发布后，未升版本）**：`push main` 与 `push tag` 仍各触发一次 publish，按仓库串行已生效；实测 npm 注册表传播延迟超过「发布前 6×5s + E409 后 10×3s」轮询窗口，后跑的运行 E409 兜底因 `npm view` 仍读不到而误报红叉（1.1.8 本身已由先跑运行成功发布、属良性竞态）。改为**E409 一律视为成功**：E409 是「版本已发布」的确定性信号，`npm view` 只做一次 best-effort 观测写进日志、不再作为成功前提；发布前轮询守卫保留用于正常情况下干净跳过。不重建 tag / Release / tarball、不发新版本。

## 1.1.7 — 2026-11-12

### 新增右边栏卡片（dsh-better-sidebar）与设置页开关/命名

- **最简便配置：软依赖、零新增依赖**。不改 `package.json` 的
  `dsh.client.inject`（那是 client module 图加载顺序，不是服务声明）、
  不改 `exports.inject`（仍 `["slots"]`）、不 value-import 任何外部包。
  运行时用宿主 guard 允许的 `ctx.get("betterSidebar")` 软探测：
  装了 dsh-better-sidebar 就注册，没装则静默跳过，左侧栏 / 顶栏 / 设置页照常。
- **`registerTab` 一张右边栏卡片**：`CardView` 直接复用 `ChatPanelShell`
  （内嵌 chat.deepseek.com webview、走同一 guest 租约与固定持久分区），
  `id = "@tianyulinfeng1/dsh-plugin-deepseek-chat:card"`（包前缀避免冲突，
  `order: 60`、`single: true`、`dedupeKey` 返回同一 id），`icon` 复用 `ChatGlyph`。
  `title: () => cardLabel()` 用 thunk——dsh-better-sidebar 每次渲染都重新求值，
  改名即时生效、无需重新注册。
- **开关与生命周期**：`showCard` 关 → dispose 旧 `registerTab`；开 → 重新注册；
  disposer 由 `ctx.effect` 持有，插件卸载（HMR / 禁用）时注销，
  不留孤儿 TabDescriptor、下次激活不会抛 `already registered`。
- **设置页新增两项**（与顶栏标签栏的开关/名称彼此独立）：
  「显示右边栏卡片」复选框、「右边栏卡片名称」输入框（默认「DeepSeek 聊天」，
  灰色占位提示、留空恢复默认）。`DEFAULTS` / `readConfig` / `writeConfig` 由
  两项扩为四项（`showTab` / `tabLabel` / `showCard` / `cardLabel`），
  归一化抽成 `normalizeLabel(value, fallback)`。
- **Verification**：`node --check lib/client.js` 通过；`npm test` 全部通过
  （新增 better-sidebar 软探测缺席/在位、descriptor 字段、title thunk 改名、
  开关注销/重注册、effect cleanup 等断言；元信息版本号随 `package.json`
  同步到 `1.1.7`）。
- **Packaging**：版本 `1.1.7`；新增中文 `docs/RELEASE_NOTES_v1.1.7.md`
  并加入 `package.json` 的 `files` 列表。

### CI 与文档（v1.1.7）

- **设置页美化（v1.1.7）**：按「顶部标签栏 / 右边栏卡片 / 关于与检查更新」
  三个逻辑分组各包一张卡片，卡片用 `--dsw-alias-border-l3` 细边框、
  `--dsw-radius-sm` 圆角与 `--dsw-alias-bg-layer-1` 浅底；输入框、按钮、
  状态行改用 `--dsw-alias-bg-base` / `--dsw-alias-bg-layer-2` 拉开层次。
  全部沿用 DSH 主题别名令牌，明暗主题自动适配，不写死任何颜色。
- **设置页对齐微调（v1.1.7）**：卡片上留白增大让「关于本插件」标题不再紧贴边框；
  基础信息 5 行改用严格两栏网格（标签列固定 88px、值列自适应、baseline 首行对齐、
  每行等距 5px），标签不换行——多行「功能简介」不再把整列挤得参差不齐。
- **README 插图**：在面板截图下方新增已登录的网页聊天界面截图
  `docs/screenshot-chat.png`（图1），并加入 `package.json` 的 `files`。
- **CI 全面升到 Node 24（Active LTS）**：`.github/workflows/test.yml`
  矩阵改为 `[24]`、`publish.yml` 的 `node-version` 改为 `24`；
  `checkout` / `setup-node` 由 `@v4` 升到 `@v7`（v7 的 Action 自身运行时为
  `node24`，消除 GitHub「Node.js 20 已弃用、被强制在 Node.js 24 运行」的警告）。
  `engines.node` 改为 `>=24`，
  README 中英、CHANGELOG、各版本发布说明里的旧 Node 版本字样统一为 24。
- **删除 setup-node 的无效输入**：`publish.yml` 去掉 `registry-url`
  （OIDC 模式不需要，且会写出无效的 `always-auth` 与
  `NODE_AUTH_TOKEN: XXXXX` 占位符并触发 `npm warn Unknown user config "always-auth"`）。
  npm 默认 registry 仍是 npmjs.org，OIDC 走 `id-token: write` 不受影响。
- **消除良性 E409 并发抢注**：`publish.yml` 的 `concurrency.group` 由
  `npm-publish-${{ github.ref }}`（按 ref 分组）改为
  `npm-publish-${{ github.repository }}`（按仓库串行）。同一 commit 被
  `push main` 与 `push tag` 触发两次时，两个运行排队；先跑的发布成功后，
  后跑的 `npm view` 会看到已发布而跳过，避免两个 `npm publish` 并发抢注
  不可变版本导致 `409 Conflict`（先跑者已发成功、非鉴权失败）。
- **E409 幂等守卫加固（v1.1.7 发布后实测）**：按仓库串行实测生效
  （两个 publish 运行排队、时间不重叠），但 npm 注册表有传播延迟——排在
  后面的运行守卫单次 `npm view` 仍读到「未发布」，于是重复 publish 撞上良性
  `E409`、CI 误报一个红叉（1.1.7 本身已由先跑的运行发布成功）。加固两点：
  守卫改为 6 次轮询（间隔 5 秒）覆盖传播窗口；`npm publish` 步骤用
  `PIPESTATUS` 捕获真实退出码，并对 `E409` / `409 Conflict` /
  `previously staged version` 兜底，二次确认版本已可见后判成功，其他真实
  失败（鉴权、网络）仍照常报错。此为发布后的 workflow 修正，不升版本、
  不重建 tag/Release/npm tarball。

## 1.1.6 — 2026-11-11

### OIDC 可信发布（Trusted Publishing）链路测试

- **`.github/workflows/publish.yml` 改为 OIDC 模式**：新增
  `permissions.id-token: write`（OIDC 必需）、`node-version: 24`（Node 24 Active LTS）、
  `npm install -g npm@latest`（npm CLI ≥ 11.5.1）、
  `npm publish --provenance --access public`；删除 `NODE_AUTH_TOKEN` 环境变量、
  `environment: npm-更新` 声明与 `NPM_TOKEN` 校验步骤；保留
  `registry-url: https://registry.npmjs.org`、`runs-on: ubuntu-latest`、
  `repository.url` 与 GitHub 仓库精确匹配。
- **Environment 留空**：GitHub 仓库未创建任何 Environment（`environments` 接口
  `total_count: 0`），与 npm 端 Trusted Publisher 的 Environment name 可选留空
  一致，因此 workflow 不声明 `environment:`。
- **纯发布链路测试**：功能与 1.1.5 完全相同，仅把版本号升到 `1.1.6` 并推送
  GitHub `main`（不打 tag，避免重复触发 CI），用一次真实的 Actions 运行验证
  npm 端 Trusted Publisher 是否已正确配置并允许 `npm publish`。
- **Verification**：`node --check lib/client.js` 通过；`npm test` 全部通过
  （元信息版本一致性等断言随 `package.json` 同步到 `1.1.6`）。

## 1.1.5 — 2026-11-11

### 设置页新增「关于本插件」与「检查更新」

- **基础信息区块**：设置页展示插件版本号（`1.1.5`）、作者（`sweet560`）、
  功能简介、开源许可证（`MIT`），以及两个 `https` 外链（npm 插件页面 /
  GitHub 仓库，`target="_blank"` 由桌面壳用系统浏览器打开）。这些值以
  模块级常量保存（client bundle 不能 import package.json），并由离线自检
  逐字段断言与 `package.json` 一致——沿用 factory id === 包名的回归思路。
- **「检查更新」按钮**：点击后从公开 JSON 接口读取最新发布版本号，
  **npm 优先、GitHub 兜底**：
  - npm：`https://registry.npmjs.org/-/package/@tianyulinfeng1%2fdsh-plugin-deepseek-chat/dist-tags`（取 `latest`）；
  - GitHub：`https://raw.githubusercontent.com/sweet560/dsh-plugin-deepseek-chat/main/package.json`（取 `version`，避开 `api.github.com` 的限流）。
  两处都带宽松 CORS、主窗口未设置 `connect-src` CSP 限制，因此直接用
  renderer 的 `fetch()` 即可，**不新增 Host 同源回环路由**、`lib/index.js`
  空宿主半侧保持不变。每个请求带 8 秒 `AbortController` 超时。
- **版本比较用数字逐段比较**（`compareVersion()`），不用字符串相等：
  本地未发版的 `1.1.5` 会领先已发布的 `latest`（实测 `1.1.2`），此时显示
  「已是最新版本」而非误报有更新；仅当远端版本更高才显示「发现新版本」。
- **文字状态 + 跳转链接**：状态行显示「点击按钮… / 正在检查更新… /
  已是最新版本 / 发现新版本 x.y.z / 检查更新失败：原因」，并在检查结束后
  附带 npm / GitHub 跳转链接。检查中按钮禁用且忽略重复点击；网络不可用、
  两个来源都失败、没有可用 fetch 时都给出失败兜底，异常不外泄。
- **Verification**：`node --check lib/client.js` 通过；`npm test` 全部通过
  （新增基础信息常量一致性、语义版本比较、载荷解析、npm/GitHub 兜底、
  检查更新各状态分支、设置页渲染与点击联动等断言）；`git diff --check` 通过。
- **Packaging**：`package.json` / `lib/client.js` / `README.md` /
  `README.en.md` / `locale/*.json` / `CHANGELOG.md` 同步升到 `1.1.5`。

## 1.1.4 — 2026-11-11

### 新增设置页 + 顶栏标签页可配置 + 网页铺满会话区

- **新增设置页**：通过官方 `settings.section` 槽注册「DeepSeek 聊天」设置页
  （`id: deepseek-chat-settings`、`order: 48`），沿用 `dsh-wechat-reminder` 等
  插件相同的 localStorage 配置范式。设置项：
  - **显示顶部标签栏**（`showTab`，默认 `true`）：关闭后移除
    `conversation.view` 注册，只保留左侧栏图标 + 全屏主面板入口；
  - **顶部标签栏名称**（`tabLabel`，默认 `DeepSeek 聊天`）：可自定义，
    留空自动回退默认，最长 40 字符。名称输入框默认为**空白**，仅以灰色
    占位提示显示默认名；点击输入框即可直接输入新名字，无需先删默认文字
    （组件内 `draft` state：默认名不写入 `value`，纯空白输入立即清空
    draft 以恢复灰提示）。
- **配置持久化**：`window.localStorage` 独立键
  `dsh-plugin-deepseek-chat:config`（与会话记忆 `…:last-url` 分离）；
  `readConfig()` 按类型校验字段，损坏的 JSON / 错误类型一律回退默认；
  `writeConfig()` 合并 patch 后通知订阅者；`subscribeConfig()` 返回的
  disposer 在 `ctx.effect` 清理时调用。
- **标签行即时刷新**：`conversation.view` 的标签行只在槽注册表增删 /
  locale 变化时重算（`dsh-client-ui-conversation` 的 `viewTabs()` +
  `slots.subscribe("conversation.view", refreshViews)`），label thunk 本身
  不订阅配置。因此 `syncView()` 在开关或名称变化时先 dispose 旧的注册、
  再重新 `ctx.slots.inject("conversation.view", …)`，让顶栏立刻显示新名字
  或隐藏标签。`main` / `sidebar.panellist` / `settings.section` 三处注册
  保持静态、各自独立 try/catch。
- **图3 修复：网页铺满会话区、盖住输入框**：选中「网页聊天」标签时，
  DSH 自身的对话消息与底部 composer 输入框（`.an3WzG_composerSeat`，
  `z-index: 9`）仍露在网页下方。原因是 `viewArea`（含本插件 webview）与
  `composerSeat` 是 `scrollBody` 内上下并列的兄弟，且 active 阶段
  `viewArea` 为 `flex: 1 0 auto; min-height: auto`，`height: 100%` 没有
  确定父高而塌陷。顶栏入口现在用独立的 `ViewTabShell` 包装：不透明的
  绝对定位浮层（`position: absolute; inset: 0; z-index: 50;
  overflow: hidden`），以 `position: relative` 的 `.an3WzG_body` 为
  containing block 覆盖整个会话 body，盖住 composer；wrapper 有确定高度，
  内部 `styles.root` 的 `height: 100%` 得以解析，网页聊天铺满。
  header（含标签行）在 root 内是 body 之上的兄弟，不被浮层覆盖，用户仍可
  点「对话」切回；左侧栏 / 全屏主面板入口仍用普通 `ChatPanelShell`。
- **图2 红框：按用户确认「先不处理」**——「DSH认证失败修复」是
  chat.deepseek.com 网页内部自带的会话标题胶囊，插件不注入 CSS/JS 去改
  第三方网页，本次不做改动。
- 工厂 id 仍为 `@tianyulinfeng1/dsh-plugin-deepseek-chat`（与
  `package.json` 的 `name` 一致，v1.1.2 的 web boot 崩溃防护不复发）；
  `inject` 仍为 `["slots"]`。

### Verification

- `node --check lib/client.js` 通过。
- 离线自检 `node test/check-client.mjs` 全部通过（`RESULT: PASS`）：
  四处槽位注册、设置默认值 / 类型校验 / 持久化 / 订阅通知、开关与自定义
  标签名触发 `conversation.view` dispose+reinject、顶栏浮层
  （`inset: 0` / `z-index: 50` / 不透明背景）、工厂 id 与包名一致、
  Web 表层 inert、两入口共用固定分区、纯网页聊天无账号条、URL 白名单、
  会话记忆、租约释放、弹窗白名单、崩溃隔离、反复开关、切走标签页释放租约。

### Packaging

- 版本 `1.1.4`，npm 包名保持 `@tianyulinfeng1/dsh-plugin-deepseek-chat` 不变；
  GitHub / Gitee 安装路由不变。

## 1.1.3 — 2026-11-11

### 移除账号状态显示 + 新增会话顶栏标签页

- **移除账号状态显示**：彻底删除面板顶部的账号状态条、DSH 账号探测
  （`ctx.remote.account`）、5 秒轮询、账号同步 store 与相关文案 / 样式 /
  状态订阅。面板现在是「纯网页聊天」，挂载即申请租约、立即启动，不再等待
  任何异步账号流程。`exports.__test__` 中账号相关 API 全部移除。
- **新增会话顶栏标签页**：通过官方 `conversation.view` 槽注册一个
  「网页聊天」标签（`id: deepseek-chat-view`、`order: 100`、
  `label: () => COPY.tab`），出现在「对话 / 轨迹 / 上下文 / 压缩 / 编队 / 统计」
  这一行。它与左侧栏入口、全屏主面板**共用同一个 ChatPanelShell 组件**和
  同一个固定分区 `panel:deepseek-chat`，因此登录态与会话记忆在两个入口间通用。
- **保留左侧栏入口**：用户确认「两入口并存」——左侧栏图标 + 全屏主面板照旧，
  顶栏另加标签页。
- **注册健壮性**：原来 main 与 sidebar.panellist 两处 `ctx.slots.inject` 被
  同一个 try/catch 包住，任一失败会连带另一个也不注册；现在三处注册
  （main / sidebar.panellist / conversation.view）改为各自独立 try/catch。
- 工厂 id 仍为 `@tianyulinfeng1/dsh-plugin-deepseek-chat`（与 `package.json`
  的 `name` 一致，v1.1.2 的 web boot 崩溃防护不复发）；`inject` 仍为
  `["slots"]`。

### Verification

- `node --check lib/client.js` 通过。
- 离线自检 `node test/check-client.mjs` 全部通过（`RESULT: PASS`）：三处槽位
  注册、工厂 id 与包名一致、Web 表层 inert、两入口共用组件与分区、纯网页聊天
  无账号条、URL 白名单、会话记忆、租约释放、弹窗白名单、崩溃隔离、反复开关、
  顶栏标签页切走释放租约。

### Packaging

- 版本 `1.1.3`，npm 包名保持 `@tianyulinfeng1/dsh-plugin-deepseek-chat` 不变；
  GitHub / Gitee 安装路由不变。

## 1.1.2 — 2026-11-09

### ⚠️ 重点修复：web boot 崩溃（duplicate factory registration）

这是 **v1.1.1 的打包回归**：升级到 v1.1.1 后，DSH 桌面版页面在启动阶段
直接失败、整个界面打不开。用户提供的崩溃日志文件为
`C:\Users\Administrator\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-2026-11-09T08-27-01-314Z-web-boot.log`。

日志环境（原文）：`time: 2026-11-09T08:27:01.314Z`、`source: web-boot`、
`app: @deepseek-ai/dsh-desktop 0.2.2-rc.1`、`win32 x64`、
`electron 44.7.0`、`node 24.21.0`、`locale zh-CN`。

日志中的原始报错文本（原文）：

> `Error: web boot: 1 entry did not activate`
>
> `@tianyulinfeng1/dsh-plugin-deepseek-chat: import failed (see console for the import error)`

渲染进程（renderer）控制台的原始报错（原文）：

> `client-modules: duplicate factory registration for "dsh-plugin-deepseek-chat" (bundle executed twice without invalidate?)`

根因链（逐条）：

1. v1.1.1 把 npm 包名从无 scope 的 `dsh-plugin-deepseek-chat` 改成了带
   scope 的 `@tianyulinfeng1/dsh-plugin-deepseek-chat`（`package.json` 的 `name`）。
2. 但 `lib/client.js` 里 `window.__ModuleLoader__.load({ id: ... })` 注册的
   工厂 id 仍是旧的短名 `dsh-plugin-deepseek-chat`，**工厂 id 与包名不一致**。
3. DSH 的 `dsh-client-modules` Host 半侧用 `package.json` 的 `name`（带 scope
   的完整包名）作为 client 图的行 id。
4. `arrive()` 执行完 bundle 脚本后会检查 `factories.has(<行 id>)`；因为工厂
   实际只注册在短名下，对 `@tianyulinfeng1/dsh-plugin-deepseek-chat` 的检查
   结果为 `false`，Host 便判定该包「没有注册」。
5. Host 因此把**同一个 bundle 脚本再执行一次**。
6. 第二次注册时短名 id `dsh-plugin-deepseek-chat` 已存在，于是抛出
   `duplicate factory registration ... (bundle executed twice without invalidate?)`。
7. 该包被记为 `import failed`，web boot 统计到「1 个 entry 未激活」，抛出
   `Error: web boot: 1 entry did not activate`，**整个页面启动失败**。
8. 日志里 `dshmarket` 反复 install/remove 只是历史操作记录，**不是**本次崩溃
   的原因。

**修改了哪里、为什么能解决**：只改 `lib/client.js` 中
`window.__ModuleLoader__.load({ id: ... })` 的工厂 `id`，把它从短名
`dsh-plugin-deepseek-chat` 改为与 `package.json` 的 `name` 完全一致的
`@tianyulinfeng1/dsh-plugin-deepseek-chat`。对齐之后，`arrive()` 的
`factories.has(<行 id>)` 在 bundle 执行完即为 `true`，Host 认为该包已正常
注册，不会再重复执行同一脚本，也就不会出现二次注册和
`duplicate factory registration`；entry 正常激活，web boot 完成。

**回归防护**：`test/check-client.mjs` 新增断言——「工厂 id 必须等于
`package.json` 的 `name`」。今后再改包名而忘了同步工厂 id，离线自检会立刻
失败，不会把同样的回归带进发布包。

### Verification

- 离线自检 35 项全部通过（`RESULT: PASS`），其中包含新增的「工厂 id 必须
  等于 `package.json` 的 `name`」回归断言。
- 扫描当前 DSH profile 全部 **30 个 web client bundle** 的 id / 包名一致性，
  **0 处不匹配**。
- 完整发布说明见 `docs/RELEASE_NOTES_v1.1.2.md`。

### Packaging

- 版本 `1.1.2`，npm 包名保持 `@tianyulinfeng1/dsh-plugin-deepseek-chat` 不变；
  GitHub / Gitee 安装路由不变。
- 发布产物：`dsh-plugin-deepseek-chat-1.1.2.tgz`（`npm pack` 对 scoped 包的
  原生输出名为 `tianyulinfeng1-dsh-plugin-deepseek-chat-1.1.2.tgz`）。
- 本次只修 client bundle 的工厂 id，其余功能（固定 guest 分区、账号状态仅
  展示、崩溃隔离等）与 v1.1.1 相同。

## 1.1.1 — 2026-11-09

### Fixed

- **Switching panels/sessions no longer asks for a fresh QR scan.** v1.1.0 keyed the
  desktop guest partition to the asynchronous DSH account probe. DSH's
  `getState()` can transiently fail during a reconnect, so the partition changed
  and handed the panel a brand-new cookie jar. The guest workspace is now the
  constant `panel:deepseek-chat` and the conversation key is the constant
  `dsh-plugin-deepseek-chat:last-url`.
- The DSH account status strip is now **display only**: it never feeds the lease
  identity, an epoch, or the guest lifecycle. A transient `unknown` is ignored;
  only a confirmed `signed-out` updates the strip.
- The guest starts on mount immediately instead of waiting for the async account
  Remote, so a failed/late probe never blocks chat.

### Documentation

- Documented, with source evidence, why a pure plugin **cannot** make
  `chat.deepseek.com` reuse the already-signed-in DSH account: the two use
  different credentials (Platform `x-dsh-auth-token` vs the site's own Token),
  the renderer bridge exposes no token/cookie API, and the archive has no SSO or
  cookie-injection entry point.
- Reworked `docs/login-persistence.md` around the upstream
  `docs/patch-dsh-persistent-partition.cjs`: DSH `0.2.1-rc.3+` (including
  `0.2.2-rc.1`) ships per-file SHA256 **ASAR integrity**, so the patch must
  recompute and sync `lib/main.js`'s hash. A byte-only replacement would crash
  DSH on restart with "ASAR Integrity Violation".
- Added `scripts/patch-dsh-persistent-partition.cjs` (upstream script: equal-length
  replacement, integrity re-sync, full-archive verification, `--dry-run`,
  idempotency, automatic backup). The earlier byte-only `.mjs` script is
  deprecated and now fails loudly.

### Verification

- Offline self-check: 35 cases, all passing (fixed partition, no rebuild on
  account-state churn, partition reuse across panel switches, envelope parsing,
  crash containment, popup allowlist).
- `app.asar` patch verified independently: 20519 files, 0 integrity failures;
  `lib/main.js` header hash matches the actual SHA256 of the patched bytes.

### Packaging

- Published to npm as **`@tianyulinfeng1/dsh-plugin-deepseek-chat`** (the
  registry name this project owns). `package.json` and `cordis.patch.yml` now
  carry that scoped package name so an npm-installed copy mounts under the same
  `deepseek-chat` bundle id; the GitHub install routes (`github:sweet560/...`)
  are unchanged.

## 1.1.0 — 2026-11-09

- Added support for DSH `0.2.2-rc.1` (`engines.dsh >=0.2.2-rc.1`).
- Added a DSH account status strip via the official `ctx.remote.account` Remote
  (correct generated `{ ok, value }` envelope parsing).
- Tightened conversation and popup URL validation; removed the dead guest element
  before showing Retry.
- **Note:** keyed the guest partition to account state, which broke login
  persistence. Fixed in 1.1.1.

## 1.0.0

First local release: sidebar entry, full-width embedded chat, last-conversation
memory, and crash containment.
