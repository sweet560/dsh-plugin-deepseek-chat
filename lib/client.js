/**
 * Browser half of dsh-plugin-deepseek-chat (v1.4.0).
 *
 * Four contributions, all showing chat.deepseek.com in an Electron <webview>:
 *   - the global left-sidebar panel (a `sidebar.panellist` icon row + the root
 *     `main` keyed slot), the same mechanism Plugins / Scheduled tasks use;
 *   - a conversation top-bar tab registered in the `conversation.view` list
 *     slot, so the web chat is reachable from the 对话 / 轨迹 / 上下文 … tab row
 *     without leaving the current Session (this one can be switched off);
 *   - a right-sidebar card: through dsh-better-sidebar's `betterSidebar`
 *     service when it is running, otherwise through DSH's own native
 *     right-sidebar registry (see "Right-sidebar card" below);
 *   - a Settings page (`settings.section`) with four preferences: whether the
 *     top-bar tab is shown and its display name, and whether the right-sidebar
 *     card is shown and its display name (both default "DeepSeek 聊天").
 *
 * Filling the conversation area
 * -----------------------------
 * The conversation renderer places each view in `viewArea`, a sibling of the
 * sticky `composerSeat`. In the `active` phase `viewArea` becomes
 * `flex:1 0 auto`, so `height:100%` on the panel has no definite parent height
 * and the Session's own messages/composer stay visible underneath. The tab is
 * therefore wrapped in an absolutely positioned overlay: its containing block
 * is the conversation body (`position:relative`), `inset:0` covers exactly
 * that body, an opaque background plus a z-index above the composer's 9 hide
 * the Session UI below, and the header with the tab row sits above the body so
 * switching back to 对话 remains possible.
 *
 * The site sends `content-security-policy: frame-ancestors 'none'`, so an
 * iframe cannot carry it; the desktop shell exposes
 * `globalThis.dshDesktop.browser`, the same guest lease bridge the built-in
 * sidebar browser uses: acquire a lease → create a webview named by the lease
 * with its approved partition → load the URL.
 *
 * Stable login session
 * --------------------
 * The desktop shell caches ONE process-lifetime session per `workspace` string
 * passed to acquire(), and release() destroys only the guest, never the
 * partition's cookies. So the workspace MUST be an absolute constant:
 * `panel:deepseek-chat`. Changing it hands the panel a fresh cookie jar and
 * forces another QR scan.
 *
 * Settings persistence (v1.1.4)
 * -----------------------------
 * Settings live in window.localStorage under CONFIG_KEY, separate from the
 * last-URL memory. The Settings page writes through writeConfig(), which
 * notifies module-level subscribers. apply() uses that notification to dispose
 * and re-inject the `conversation.view` entry: the tab row only recomputes its
 * labels when the slot registry changes, so a label thunk alone cannot reflect
 * a renamed tab. Re-registering also drives the showTab on/off switch.
 *
 * Right-sidebar card (v1.1.7; dual path as of v1.1.9)
 * ----------------------------------------------------
 * dsh-better-sidebar exposes a client-only `betterSidebar` service and renders
 * every registerTab() descriptor as a DSH native right-sidebar tab. DSH itself
 * also ships a native right-sidebar (the `sidebarRightTabs` registry provided
 * by @deepseek-ai/dsh-client-ui-sidebar-right) that needs no third-party plugin.
 *
 * v1.1.9 chooses the path by what is ACTUALLY RUNNING, not by a package list:
 *   - betterSidebar service up -> registerTab(cardDescriptor()) (the card also
 *     appears in better-sidebar's "侧边卡片" settings list);
 *   - otherwise -> DSH native: sidebarRightTabs.register(nativeCardDefinition())
 *     plus a `sidebar.right.pane.tab` body slot (key = CARD_ID). The chip text
 *     falls back to definition.title(); the guide entry is the + menu box.
 * Only ONE path is active at any time (activeCardPath), so late-arriving
 * better-sidebar swaps the native card for its own without duplicates.
 *
 * Why the v1.1.8 fix was not enough: its 500ms x 40 (about 20s) retry window
 * could EXPIRE during a slow cold start, so the card only appeared after the
 * user manually toggled the setting. v1.1.9 removes the hard cap and adds a
 * Cordis service-ready listener:
 *   - ctx.on('internal/service', ..., {global:true}) fires when betterSidebar
 *     or sidebarRightTabs is provided (and when a provider fiber becomes active
 *     and re-notifies), so a slow start can never miss the window;
 *   - an unbounded, cancellable 500ms browser-global timer is the fallback;
 *   - every sync() re-probes both services.
 * ctx.setTimeout / ctx.inject are unavailable to a dynamic plugin (guard gates
 * timers behind a declared 'timer' inject, and `inject` is not a CTX_VERB), so
 * only browser-global setTimeout is used. All disposers, the event subscription
 * and the timer are owned by ctx.effect, so unloading leaves nothing behind.
 *
 * About & update check (v1.1.5)
 * ----------------------------
 * The Settings page also shows the plugin's metadata (version, author, license,
 * a short description and links to npm/GitHub) and a "检查更新" button. The
 * latest published version is read directly from the two public JSON endpoints
 * (npm registry first, GitHub raw package.json as a fallback) using the
 * renderer's fetch — the main window sets no connect-src CSP restriction and
 * both hosts answer with permissive CORS. No Host-side route is added, so the
 * empty host half stays untouched. compareVersion() does a numeric semver
 * comparison rather than string equality, because a local unreleased build
 * (e.g. 1.1.7) can already be ahead of the published "latest" (1.1.2).
 *
 * One-click update (v1.1.10)
 * --------------------------
 * When the check reports `found`, the Settings page shows an "立即更新"
 * button beside the status line. It calls the official DSH Host channel
 * `ctx.get("remote").pluginManager.updateBundle(PLUGIN_NAME, latest)` — a
 * guard-allowed soft read, so `remote` is NOT added to exports.inject (a
 * cold-start-late declaration would park the whole plugin fiber). The
 * ChangeResult.application is mapped to an honest Chinese status (applied ->
 * done, restart-required -> restart hint, failed/... -> the diagnostic). A
 * link: install is refused by updateRefusal, so the button reports the
 * failure as-is and keeps the npm / GitHub jump links as a manual fallback.
 *
 * Full auto-pilot channel (v1.4.0)
 * --------------------------------
 * On top of the conditional auto-loop, an opt-in "full auto-pilot" chains the
 * three roles into one unattended loop: the DSH desktop session is the dev
 * agent, chat.deepseek.com is the reviewer, and the user decides when to start
 * / stop and takes over on a decision card. Each desktop turn/end is pushed to
 * the web chat with an output contract asking the reviewer to wrap ONLY the
 * hand-off text in delimiters ({start}...{end}) and end with a done word. The
 * web reply is parsed by extractPilotPayload() — the full page text is NEVER
 * delivered, only the delimited block. classifyPilotReply() decides continue
 * vs. pause by priority: done -> restart keyword -> handoff keyword (asks for
 * the user in person, e.g. host acceptance) -> duplicate (same text twice) ->
 * error keyword -> max loops -> no-marker. On "continue" the delimited block
 * is written into the desktop draft and submitted via the official
 * conversation.send(text) API (no DOM writes, no synthetic keys — avoiding the
 * v1.3.0 residual-text regression); if that API is unavailable the loop pauses
 * on a "please press send" decision card instead. Every pause renders a
 * decision card with continue / edit / retry / terminate actions the user owns.
 *
 * No account awareness (v1.1.3)
 * -----------------------------
 * Earlier versions probed the DSH account and rendered a status strip. That
 * strip and the whole account sync store (polling / probes / listeners) are
 * removed; the chat uses its own site-owned login, and no DSH account state is
 * read, displayed, or fed into the guest lifecycle.
 *
 * Failure containment is still the hard rule of this file. DSH treats any
 * uncaught error thrown by a plugin as a crash of its slot entry, and a crash
 * inside the `root` slot unmounts the entire application UI. Electron throws
 * from webview methods such as `getURL()` / `loadURL()` as soon as the element
 * leaves the document, and React runs effect cleanups after the DOM removal —
 * so every guest call is attached-checked and wrapped, every event handler
 * catches, a React error boundary keeps a render failure inside this panel, and
 * a failure removes the dead guest before showing the in-panel Retry card.
 */
window.__ModuleLoader__.load({
	// MUST equal package.json "name" (the scoped npm name). The Host keys every
	// client graph row by the package name and, after executing a bundle script,
	// checks `factories.has(<row id>)`. A mismatched id makes arrive() think the
	// bundle registered nothing, re-execute the same script, and throw
	// "duplicate factory registration ... (bundle executed twice without
	// invalidate?)" during web boot. See docs/RELEASE_NOTES_v1.1.1.md.
	id: "@tianyulinfeng1/dsh-plugin-deepseek-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const PANEL_ID = "deepseek-chat";
		/** Cell key of the conversation top-bar tab (conversation.view list). */
		const VIEW_ID = "deepseek-chat-view";
		/** Position after the shipped views (chat 0, trajectory 10, stats …). */
		const VIEW_ORDER = 100;
		/** Cell key / position of the Settings page (settings.section list). */
		const SETTINGS_ID = "deepseek-chat-settings";
		const SETTINGS_ORDER = 48;
		/** Native right-sidebar tab id (package-prefixed to avoid built-in clashes). */
		const CARD_ID = "@tianyulinfeng1/dsh-plugin-deepseek-chat:card";
		/** Position after better-sidebar's built-in tabs (editor 10 … sidechat 35). */
		const CARD_ORDER = 60;
		/** Cadence (ms) of the unbounded service-readiness fallback probe. */
		const CARD_RETRY_DELAY = 500;
		const CHAT_URL = "https://chat.deepseek.com/";

		/**
		 * Plugin metadata shown in Settings. Kept as plain constants (the client
		 * bundle cannot import package.json) and asserted against package.json by
		 * the offline self-test — the same pattern the factory id uses.
		 */
		const PLUGIN_NAME = "@tianyulinfeng1/dsh-plugin-deepseek-chat";
		const PLUGIN_VERSION = "1.4.0";
		const PLUGIN_AUTHOR = "sweet560";
		const PLUGIN_LICENSE = "MIT";
		const NPM_PAGE_URL = "https://www.npmjs.com/package/@tianyulinfeng1/dsh-plugin-deepseek-chat";
		const GITHUB_PAGE_URL = "https://github.com/sweet560/dsh-plugin-deepseek-chat";
		/** Public JSON endpoints used by "检查更新" (npm first, GitHub fallback). */
		const NPM_VERSION_URL = "https://registry.npmjs.org/-/package/@tianyulinfeng1%2fdsh-plugin-deepseek-chat/dist-tags";
		const GITHUB_VERSION_URL = "https://raw.githubusercontent.com/sweet560/dsh-plugin-deepseek-chat/main/package.json";
		/**
		 * Constant storage identities for the guest partition and the
		 * last-conversation memory. The main process keeps one partition per
		 * `workspace` string for the process lifetime; these MUST NOT change,
		 * or a fresh cookie jar would force a fresh QR scan.
		 */
		const PARTITION_BASE = "panel:deepseek-chat";
		const STORAGE_BASE = "dsh-plugin-deepseek-chat:last-url";
		/** Paths that are not a conversation: a brand-new chat, or an auth page. */
		const NON_CONVERSATION_PATHS = new Set(["/", "/sign_in", "/login", "/signup", "/auth"]);

		// ── 自动闭环同步（v1.2.0）默认关闭 ───────────────────────────────────────
		/** Name of the in-page bridge object injected into the chat webview. */
		const BRIDGE_KEY = "__dshDeepSeekBridge";
		const DEFAULT_MAX_LOOPS = 3;
		const DEFAULT_POLL_INTERVAL = 1000;
		// v1.2.3: 发送后延迟确认的等待时间。必须大于 BRIDGE_IMPL.scheduleSends 的
		// 最晚重试（2800ms）与键盘兜底（1000ms），确保所有发送尝试结束后再判定，避免假阴性。
		const SEND_CONFIRM_DELAY = 3500;
		const DEFAULT_REPLY_TIMEOUT = 180000;
		const DEFAULT_ERROR_KEYWORDS = ["Error", "Traceback", "Failed", "panic", "FATAL"];

		// ── 全自动投递通道（v1.4.0）——默认关闭 / 保守值 ─────────────────────────
		/** 网页审查意见中「投递给开发 agent」区块的定界符；用 indexOf 截取，避免正则元字符问题。 */
		const DEFAULT_PILOT_MARKER_START = "<TO_DEV>";
		const DEFAULT_PILOT_MARKER_END = "</TO_DEV>";
		/** 完成词：命中即视为语义通过、正常终止链条（不再回填草稿、不提交）。 */
		const DEFAULT_PILOT_DONE_KEYWORDS = ["DONE", "完成", "通过", "APPROVED"];
		/** 重启词：命中即暂停并弹决策卡（需用户重启 DSH 后手动继续）。 */
		const DEFAULT_PILOT_RESTART_KEYWORDS = ["重启 DSH", "重启桌面", "restart DSH", "restart harness"];
		/** 用户介入词：命中即暂停并弹决策卡，必须由用户本人接入处理（如宿主验收）。 */
		const DEFAULT_PILOT_HANDOFF_KEYWORDS = ["请重启宿主验收", "宿主验收", "请用户验收", "需要你本人", "需要人工介入", "handoff to user", "user verification"];
		/**
		 * 输出契约模板：全自动推送时追加到网页审查消息末尾，要求审查 agent 按定界符输出。
		 * {start}/{end}/{done} 由 buildPilotPush 用字符串替换填入（避免正则元字符）。
		 */
		const DEFAULT_PILOT_OUTPUT_CONTRACT =
			"请审查上面的内容，并把需要交给开发 agent 执行或修改的部分严格遵守下面的输出格式：" +
			"只把你要求开发 agent 处理的内容放进 {start} 与 {end} 之间——{end} 之外的内容一律不会传给开发 agent。" +
			"若任务已全部完成、无需开发 agent 继续，请在回复中明确写出完成词：{done}。";
		const DEFAULT_STOP_SELECTORS = ["[data-testid=\"stop-button\"]", ".stop-generate", "button[aria-label*=\"停止\"]", "button[aria-label*=\"Stop\"]"];
		const DEFAULT_SEND_SELECTORS = ["button[type=\"submit\"]", "[data-testid=\"send-button\"]", "button[aria-label*=\"发送\"]", "button[aria-label*=\"Send\"]"];
		const DEFAULT_TEXTAREA_SELECTORS = ["textarea", "[contenteditable=\"true\"]", "div[role=\"textbox\"]"];
		const DEFAULT_ASSISTANT_SELECTORS = ["[data-message-author-role=\"assistant\"]", ".ds-markdown", ".markdown", "[class*=\"markdown\"]"];
		// v1.2.3: 发送确认——用用户消息节点计数判定「发送是否已提交」。
		const DEFAULT_USER_MESSAGE_SELECTORS = ["[data-message-author-role=\"user\"]"];

		const english = typeof navigator !== "undefined" && /^en\b/i.test(navigator.language ?? "");
		/** Optional on-disk loop trace: written to the main window's localStorage,
		 *  which Chromium persists into `Local Storage/leveldb`. Read back by
		 *  test/verify-loop-runtime.cjs / test/verify-runtime.cjs as objective evidence. */
		const LOOP_TRACE_KEY = "dsh-plugin-deepseek-chat:loop-trace";
		const LOOP_TRACE_EVENT_CAP = 40;

		const COPY = english ? {
			label: "DeepSeek Chat",
			loading: "Loading DeepSeek Chat…",
			unsupported: "The embedded chat needs the desktop app.",
			failed: "The chat page could not be opened",
			crashed: "The embedded chat stopped responding",
			timeout: "The embedded chat did not start",
			retry: "Retry",
			settingsNav: "DeepSeek Chat",
			settingsTitle: "DeepSeek Chat settings",
			settingsEnableTab: "Show the conversation top-bar tab",
			settingsEnableHint: "Add a web-chat entry to the 对话 / 轨迹 / 上下文 … tab row. Turn this off to keep only the left-sidebar panel.",
			settingsTabLabel: "Top-bar tab name",
			settingsTabLabelHint: "Default: DeepSeek 聊天. Leave the box empty to restore the default.",
			settingsPlaceholder: "DeepSeek 聊天",
			settingsEnableCard: "Show the right-sidebar card",
			settingsEnableCardHint: "Register a right-sidebar card via better-sidebar when the service is actually running, or inject directly into DSH native right sidebar otherwise; turning it off removes the card.",
			settingsCardLabel: "Right-sidebar card name",
			settingsCardLabelHint: "Default: DeepSeek 聊天. Leave the box empty to restore the default. Independent of the top-bar tab name.",
			aboutTitle: "About this plugin",
			infoVersion: "Version",
			infoAuthor: "Author",
			infoLicense: "License",
			infoDescription: "Description",
			infoSummary: "Embeds chat.deepseek.com and two-way bridges desktop conversations with the web chat: three chat entries, an optional auto-loop (web reply → desktop draft only), and a v1.4.0 full auto-pilot channel that extracts a delimited review block, auto-submits the next turn via official conversation.send and pauses on a decision card you control.",
			infoLinks: "Links",
			linkNpm: "npm package page",
			linkGithub: "GitHub repository",
			updateTitle: "Check for updates",
			checkUpdate: "Check for updates",
			updateIdle: "Click the button to read the latest published version from npm or GitHub.",
			updateChecking: "Checking for updates…",
			updateUpToDate: "You're up to date",
			updateFound: "New version available",
			updateFailed: "Update check failed",
			updateNoFetch: "This environment cannot reach the network (fetch is unavailable).",
			updateSource: "Source",
			updateLatest: "Latest",
			updateCurrent: "Current",
			updateNow: "Update now",
			updateUpdating: "Updating…",
			updateDone: "Update complete",
			updateRestart: "Installed — please restart DSH to apply",
			updateInstallFailed: "Update failed",
			updateNoChannel: "Plugin update channel is unavailable in this environment",
			updateFallback: "You can also update manually via the npm / GitHub links below.",
			syncTitle: "Conditional auto-sync loop (desktop ↔ web chat)",
			syncEnable: "Enable conditional auto-sync",
			syncEnableHint: "Off by default. When on, a completed desktop turn is filled and sent into the web chat automatically; when the web reply finishes, its text is written into the desktop draft — it NEVER starts the next turn for you. You always decide whether to continue.",
			syncMaxLoops: "Max automatic rounds",
			syncMaxLoopsHint: "1–20, default 3. Auto-sync pauses once this many rounds have been pushed to the web chat.",
			syncErrorKeywords: "Error keywords (comma separated)",
			syncErrorKeywordsHint: "If the last answer contains any of these, auto-sync pauses instead of pushing. Default: Error, Traceback, Failed, panic, FATAL.",
			syncStopSelectors: "Stop-button selectors (one per line)",
			syncStopSelectorsHint: "DeepSeek class names change often; these selectors are configurable. The watcher treats the stop button disappearing as reply-complete.",
			syncSendSelectors: "Send-button selectors (one per line)",
			syncTextareaSelectors: "Input-box selectors (one per line)",
			syncAssistantSelectors: "Assistant-message selectors (one per line)",
			syncReset: "Restore defaults",
			syncStatus: "Loop state",
			syncStateOff: "Off",
			syncStateIdle: "Armed — waiting for a completed desktop turn",
			syncStatePushing: "Sending the answer into the web chat…",
			syncStateWaiting: "Web chat is generating — waiting for the reply…",
			syncStateInjected: "Reply written to the draft — click Run / Continue yourself",
			syncStatePaused: "Paused (round limit reached or error guard tripped)",
			syncStateError: "Stopped on error",
			syncStateTimeout: "Timed out waiting for the web reply",
			syncStateDone: "Round complete",
			syncRound: "Round",
			syncCopyReply: "Copy last reply",
			syncCopied: "Copied",
			syncManualFallback: "Could not reach the desktop draft; copy the reply below manually.",
			syncSafetyNote: "Safety: master switch, max rounds, error-keyword guard and per-turn dedup all apply. Automatic steps only move and send text — they never start a run.",
			syncHalfAutoEnable: "Half-automatic bring-back (you paste the web reply)",
			syncHalfAutoHint: "Instead of scraping the web page DOM (which can time out after a DeepSeek redesign), YOU paste the reply text or the official chat export JSON into the status bar. The plugin parses it with the official structured-export semantics, writes it into the desktop draft, and never starts the next run.",
			syncStateHalfAutoWaiting: "Sent — paste the web reply below, then bring it back",
			syncBringBackPlaceholder: "Paste the web reply text, or a deepseek_data-*.zip chat_sessions/{id}.json …",
			syncBringBack: "Bring back → write to draft",
			syncBringBackEmpty: "Nothing to bring back — paste the reply first.",
			syncBringBackFailed: "Could not parse a finished reply from that JSON (status not FINISHED, or no RESPONSE fragment).",
			syncBringBackOk: "Reply written to the draft — click Run / Continue yourself.",
			syncUserSelectors: "User-message selectors (one per line, for send confirmation)",
			syncRetrySend: "Retry send",
			syncUnconfirmed: "Send unconfirmed — the message did not appear in the web chat. Retry, or send manually.",
			syncPairedTo: "Bound to session",
			syncSwitchPaused: "Loop still running in the bound session — reply goes to its draft; switch back to view",
			syncRebind: "Rebind",
			syncBind: "Bind this session",
			syncBindTitle: "Lock the current session as the automation target without running a turn first",
			syncSettings: "Open DeepSeek Chat settings",
			// ── 全自动投递通道（v1.4.0）──
			pilotEnable: "Auto-pilot channel (default off) — you start/stop it",
			pilotEnableHint: "Once started, each finished desktop turn is sent to the web chat; only the reviewer's {start}…{end} block is extracted and written back, then auto-submitted to drive the next turn — until the done word, a pause condition, or the round cap. You stay the decision-maker: start/stop is yours, and a decision card pops up on pause. Web output must be distilled — the full reply is never dumped into the desktop to avoid context blowup and wasted tokens.",
			pilotAutoSubmit: "Auto-submit each written-back review",
			pilotAutoSubmitHint: "On: use the official API to submit the distilled reply right away. Off: leave a draft for you to run. If auto-submit is unavailable, a 'please send' card appears instead.",
			pilotMarkers: "Delivery block delimiters (start / end)",
			pilotDoneKeywords: "Done words (one per line) — semantic completion, ends the chain",
			pilotRestartKeywords: "Restart words (one per line) — pause with a decision card",
			pilotHandoffKeywords: "Handoff-to-user words (one per line) — pause, you must take over (e.g. host acceptance)",
			pilotContract: "Output contract appended to each web push (advanced)",
			pilotStart: "▶ Start auto-pilot",
			pilotStop: "■ Stop auto-pilot",
			pilotRunning: "Auto-pilot round",
			pilotPaused: "Paused — choose next step",
			pilotDone: "Done word reached — chain ended",
			pilotReasonDone: "Reviewer signals the task is complete (done word).",
			pilotReasonRestart: "Reviewer asks to restart DSH — restart it, then continue from the card.",
			pilotReasonHandoff: "Reviewer asks for your personal attention (e.g. host acceptance) — you must take over here.",
			pilotReasonDuplicate: "Same reply repeated twice — likely stuck; choose a next step.",
			pilotReasonError: "Error keyword in the reply — choose a next step.",
			pilotReasonMaxLoops: "Round cap reached — choose a next step.",
			pilotReasonNoMarker: "Reviewer did not use the {start}…{end} block — nothing safe to deliver; choose a next step.",
			pilotReasonSubmitUnavailable: "Auto-submit API unavailable — draft is written; please send it yourself.",
			pilotContinue: "Continue (next round)",
			pilotEdit: "Edit the distilled reply",
			pilotRetry: "Retry this round",
			pilotTerminate: "Stop the chain",
			pilotEditPlaceholder: "Edit the reply that will be written to the desktop draft",
			pilotApplyEdit: "Write edited reply to draft",
			pilotDecisionHint: "Decision needed — the chain is paused. Pick one action.",
			pilotSafetyNote: "Auto-pilot inherits all existing safety valves (master switch, per-turn dedup, error keywords, round cap). The reviewer's full text is never delivered — only the delimited block. Start/stop and every pause decision stay with you."
		} : {
			label: "DeepSeek 聊天",
			loading: "正在加载 DeepSeek 聊天…",
			unsupported: "内嵌聊天窗口需要桌面版 App。",
			failed: "聊天页面打开失败",
			crashed: "内嵌聊天进程已退出",
			timeout: "内嵌聊天页面没有启动",
			retry: "重试",
			settingsNav: "DeepSeek 聊天",
			settingsTitle: "DeepSeek 聊天设置",
			settingsEnableTab: "显示顶部标签栏",
			settingsEnableHint: "在会话顶栏「对话 / 轨迹 / 上下文 …」标签行加入网页聊天入口；关闭后只保留左侧栏面板。",
			settingsTabLabel: "顶部标签栏名称",
			settingsTabLabelHint: "默认：DeepSeek 聊天；留空即恢复默认。",
			settingsPlaceholder: "DeepSeek 聊天",
			settingsEnableCard: "显示右边栏卡片",
			settingsEnableCardHint: "better-sidebar 服务正常运行时经它注册右边栏卡片，没正常运行（含未安装 / 启动晚）时直注 DSH 自带原生右侧栏；关闭后移除该卡片。",
			settingsCardLabel: "右边栏卡片名称",
			settingsCardLabelHint: "默认：DeepSeek 聊天；留空即恢复默认。与顶部标签栏名称相互独立。",
			aboutTitle: "关于本插件",
			infoVersion: "插件版本号",
			infoAuthor: "作者",
			infoLicense: "开源许可证",
			infoDescription: "功能简介",
			infoSummary: "把 chat.deepseek.com 嵌入 DSH 并双向桥接桌面会话与网页聊天：三个聊天入口、可选的自动闭环（网页回复只写桌面草稿）、以及 v1.4.0 全自动投递通道——只提炼网页定界区块、经官方 conversation.send 自动提交下一轮，命中完成/重启/验收/重复/错误/最大轮数即暂停弹决策卡由你掌控。",
			infoLinks: "相关链接",
			linkNpm: "npm 插件页面",
			linkGithub: "GitHub 仓库",
			updateTitle: "检查更新",
			checkUpdate: "检查更新",
			updateIdle: "点击按钮，从 npm 或 GitHub 获取最新发布版本号。",
			updateChecking: "正在检查更新…",
			updateUpToDate: "已是最新版本",
			updateFound: "发现新版本",
			updateFailed: "检查更新失败",
			updateNoFetch: "当前环境无法联网（没有可用的 fetch）。",
			updateSource: "来源",
			updateLatest: "最新版本",
			updateCurrent: "当前版本",
			updateNow: "立即更新",
			updateUpdating: "正在更新…",
			updateDone: "更新完成",
			updateRestart: "已安装，请重启 DSH 生效",
			updateInstallFailed: "更新失败",
			updateNoChannel: "当前环境无法调用插件更新通道",
			updateFallback: "也可通过下方 npm / GitHub 链接手动更新。",
			syncTitle: "条件触发式自动闭环同步（桌面端 ↔ 网页聊天）",
			syncEnable: "开启条件触发式自动同步",
			syncEnableHint: "默认关闭。开启后：桌面端一轮执行完成 → 自动把回答填入网页聊天并发送；网页回复完成 → 自动抓取并写入桌面端草稿，但【绝不替你触发下一轮执行】。是否继续，始终由你决定。",
			syncMaxLoops: "最大自动轮数",
			syncMaxLoopsHint: "范围 1–20，默认 3。推送到网页达到该轮数后自动同步暂停。",
			syncErrorKeywords: "错误关键词（英文逗号分隔）",
			syncErrorKeywordsHint: "若本轮回答命中任一关键词，则暂停自动同步、不推送。默认：Error, Traceback, Failed, panic, FATAL。",
			syncStopSelectors: "「停止生成」按钮选择器（每行一个）",
			syncStopSelectorsHint: "DeepSeek 类名经常变动，故选择器可配置。watcher 以「停止按钮消失」判定回复完成。",
			syncSendSelectors: "「发送」按钮选择器（每行一个）",
			syncTextareaSelectors: "输入框选择器（每行一个）",
			syncAssistantSelectors: "助手消息选择器（每行一个）",
			syncReset: "恢复默认",
			syncStatus: "闭环状态",
			syncStateOff: "已关闭",
			syncStateIdle: "已就绪 — 等待桌面端一轮完成",
			syncStatePushing: "正在把回答填入网页并发送…",
			syncStateWaiting: "网页正在生成 — 等待回复完成…",
			syncStateInjected: "回复已写入草稿 — 请自行点击运行 / 继续",
			syncStatePaused: "已暂停（达到轮数上限或触发错误熔断）",
			syncStateError: "出错已停止",
			syncStateTimeout: "等待网页回复超时",
			syncStateDone: "本轮完成",
			syncRound: "轮次",
			syncCopyReply: "复制最近回复",
			syncCopied: "已复制",
			syncManualFallback: "无法写入桌面端草稿，请手动复制下方回复。",
			syncSafetyNote: "安全阀：总开关、最大轮数、错误关键词熔断、同轮去重全部生效。自动步骤只搬运与发送文本，绝不启动运行。",
			syncHalfAutoEnable: "半自动带回（由你粘贴网页回复）",
			syncHalfAutoHint: "不再抓网页 DOM（DeepSeek 改版时易 180s 超时）：由你把网页回复文本或官方导出的会话 JSON 粘进状态条，插件按官方「结构化导入」语义解析后写入桌面端草稿，绝不替你启动下一轮。",
			syncStateHalfAutoWaiting: "已发送 — 请在下方粘贴网页回复，再点带回",
			syncBringBackPlaceholder: "粘贴网页回复文本，或 deepseek_data-*.zip 里 chat_sessions/{id}.json 的内容…",
			syncBringBack: "带回 → 写入草稿",
			syncBringBackEmpty: "没有可带回的内容，请先粘贴回复。",
			syncBringBackFailed: "未从该 JSON 解析出已完成的回复（状态非 FINISHED，或缺少 RESPONSE 片段）。",
			syncBringBackOk: "回复已写入草稿 — 请自行点击运行 / 继续。",
			syncUserSelectors: "用户消息选择器（每行一个，用于发送确认）",
			syncRetrySend: "再试一次",
			syncUnconfirmed: "发送未确认 — 消息没有出现在网页聊天中。可点「再试一次」，或手动发送。",
			syncPairedTo: "已绑定到会话",
			syncSwitchPaused: "闭环仍在配对会话运行 — 回复已注入该会话草稿；切回查看",
			syncRebind: "换绑",
			syncBind: "绑定当前会话",
			syncBindTitle: "无需先跑一轮，直接把当前会话锁定为自动闭环的目标",
			syncSettings: "打开 DeepSeek 聊天设置",
			// ── 全自动投递通道（v1.4.0）──
			pilotEnable: "全自动投递通道（默认关闭）——由你启动/终止",
			pilotEnableHint: "启动后，桌面每完成一轮就回传网页；只提炼审查 agent 的 {start}…{end} 区块写回桌面草稿，并自动提交驱动下一轮——直到命中完成词、暂停条件或最大轮数。你始终是决策者：启停由你定，暂停时弹决策卡。网页输出必须提炼——绝不把全文盲目丢给桌面会话，避免上下文爆炸与浪费 Token。",
			pilotAutoSubmit: "自动提交每轮写回的审查意见",
			pilotAutoSubmitHint: "开启：用官方 API 立即提交提炼后的意见。关闭：只留草稿由你手动运行。若自动提交能力不可用，会弹出「请按发送」卡代替。",
			pilotMarkers: "投递区块定界符（起始 / 结束）",
			pilotDoneKeywords: "完成词（每行一个）——表示语义通过、终止链条",
			pilotRestartKeywords: "重启词（每行一个）——命中即暂停并弹决策卡",
			pilotHandoffKeywords: "用户介入词（每行一个）——命中即暂停，必须由你本人接管（如宿主验收）",
			pilotContract: "每次推送网页时追加的输出契约（高级）",
			pilotStart: "▶ 启动全自动",
			pilotStop: "■ 停止全自动",
			pilotRunning: "全自动第",
			pilotPaused: "已暂停——请选择下一步",
			pilotDone: "已命中完成词——链条结束",
			pilotReasonDone: "审查 agent 表示任务已完成（完成词）。",
			pilotReasonRestart: "审查 agent 要求重启 DSH——请重启后从决策卡继续。",
			pilotReasonHandoff: "审查 agent 要求你本人介入（如宿主验收）——必须由你接管处理。",
			pilotReasonDuplicate: "相同回复连续重复 2 次——可能卡住，请选择下一步。",
			pilotReasonError: "回复含错误关键词——请选择下一步。",
			pilotReasonMaxLoops: "已到最大轮数——请选择下一步。",
			pilotReasonNoMarker: "审查 agent 未使用 {start}…{end} 区块——没有可安全投递的内容，请选择下一步。",
			pilotReasonSubmitUnavailable: "自动提交 API 不可用——草稿已写好，请手动发送。",
			pilotContinue: "继续（下一轮）",
			pilotEdit: "编辑提炼后的意见",
			pilotRetry: "重试本轮",
			pilotTerminate: "终止链条",
			pilotEditPlaceholder: "编辑将写入桌面草稿的回复",
			pilotApplyEdit: "将编辑后的回复写入草稿",
			pilotDecisionHint: "需要你决策——链条已暂停，请选择一个操作。",
			pilotSafetyNote: "全自动继承现有全部安全阀（总开关、同轮去重、错误关键词、最大轮数）。网页全文绝不投递——只传定界区块。启停与每次暂停决策都由你掌控。"
		};

		/** localStorage key for the four user preferences (separate from last-url memory). */
		const CONFIG_KEY = "dsh-plugin-deepseek-chat:config";
		const DEFAULT_TAB_LABEL = "DeepSeek 聊天";
		const DEFAULT_CARD_LABEL = "DeepSeek 聊天";
		const DEFAULTS = {
			showTab: true,
			tabLabel: DEFAULT_TAB_LABEL,
			showCard: true,
			cardLabel: DEFAULT_CARD_LABEL,
			// ── 条件触发式自动闭环（v1.2.0）——默认全部关闭 / 保守值 ──
			autoSyncEnabled: false,
			maxAutoLoops: DEFAULT_MAX_LOOPS,
			errorKeywords: [...DEFAULT_ERROR_KEYWORDS],
			stopButtonSelectors: [...DEFAULT_STOP_SELECTORS],
			sendButtonSelectors: [...DEFAULT_SEND_SELECTORS],
			textareaSelectors: [...DEFAULT_TEXTAREA_SELECTORS],
			assistantSelectors: [...DEFAULT_ASSISTANT_SELECTORS],
			userMessageSelectors: [...DEFAULT_USER_MESSAGE_SELECTORS],   // v1.2.3 发送确认
			// ── 半自动带回（v1.2.1，借鉴官方会话导入插件）——默认关闭 ──
			// 网页 DOM 抓取失败时的稳健替代：用户显式粘贴回复/导出 JSON → 结构化解析 → 写草稿，绝不 submit。
			halfAutoEnabled: false,
			// ── 全自动投递通道（v1.4.0）——默认关闭 / 保守值 ──
			// 桌面 turn/end → 回传网页+发送 → 网页审查意见按定界符提炼 → 回填草稿 → 自动提交下一轮。
			// 直到语义通过（完成词）或命中暂停/终止条件（重启词/重复2次/错误词/最大轮数）弹决策卡。
			autoPilotEnabled: false,
			pilotAutoSubmit: true,
			pilotMarkerStart: DEFAULT_PILOT_MARKER_START,
			pilotMarkerEnd: DEFAULT_PILOT_MARKER_END,
			pilotDoneKeywords: [...DEFAULT_PILOT_DONE_KEYWORDS],
			pilotRestartKeywords: [...DEFAULT_PILOT_RESTART_KEYWORDS],
			pilotHandoffKeywords: [...DEFAULT_PILOT_HANDOFF_KEYWORDS],
			pilotOutputContract: DEFAULT_PILOT_OUTPUT_CONTRACT
		};
		const configListeners = new Set();
		let config = readConfig();

		/** Clamp an integer into [1, 20]; fall back to DEFAULT_MAX_LOOPS. */
		function normalizeMaxLoops(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_LOOPS;
			return Math.max(1, Math.min(20, Math.round(value)));
		}

		/** Normalize a list of non-empty strings; fall back to the default list when empty/invalid. */
		function normalizeStringArray(value, fallback) {
			if (!Array.isArray(value)) return [...fallback];
			const cleaned = value
				.filter((item) => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => item.length > 0)
				.slice(0, 40);
			return cleaned.length > 0 ? cleaned : [...fallback];
		}

		/** CSS selector lists share the same normalization (keep each selector bounded). */
		function normalizeSelectors(value, fallback) {
			return normalizeStringArray(value, fallback).map((item) => item.slice(0, 200));
		}

		/** Read preferences, validating each field's type against DEFAULTS. */
		function readConfig() {
			const result = {
				...DEFAULTS,
				errorKeywords: [...DEFAULTS.errorKeywords],
				stopButtonSelectors: [...DEFAULTS.stopButtonSelectors],
				sendButtonSelectors: [...DEFAULTS.sendButtonSelectors],
				textareaSelectors: [...DEFAULTS.textareaSelectors],
				assistantSelectors: [...DEFAULTS.assistantSelectors],
				userMessageSelectors: [...DEFAULTS.userMessageSelectors],
				pilotDoneKeywords: [...DEFAULTS.pilotDoneKeywords],
				pilotRestartKeywords: [...DEFAULTS.pilotRestartKeywords],
				pilotHandoffKeywords: [...DEFAULTS.pilotHandoffKeywords]
			};
			try {
				const raw = window.localStorage.getItem(CONFIG_KEY);
				if (typeof raw !== "string" || raw.length === 0) return result;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return result;
				if (typeof parsed.showTab === "boolean") result.showTab = parsed.showTab;
				if (typeof parsed.tabLabel === "string") result.tabLabel = normalizeLabel(parsed.tabLabel, DEFAULT_TAB_LABEL);
				if (typeof parsed.showCard === "boolean") result.showCard = parsed.showCard;
				if (typeof parsed.cardLabel === "string") result.cardLabel = normalizeLabel(parsed.cardLabel, DEFAULT_CARD_LABEL);
				if (typeof parsed.autoSyncEnabled === "boolean") result.autoSyncEnabled = parsed.autoSyncEnabled;
				if (typeof parsed.maxAutoLoops === "number") result.maxAutoLoops = normalizeMaxLoops(parsed.maxAutoLoops);
				if (Array.isArray(parsed.errorKeywords)) result.errorKeywords = normalizeStringArray(parsed.errorKeywords, DEFAULT_ERROR_KEYWORDS);
				if (Array.isArray(parsed.stopButtonSelectors)) result.stopButtonSelectors = normalizeSelectors(parsed.stopButtonSelectors, DEFAULT_STOP_SELECTORS);
				if (Array.isArray(parsed.sendButtonSelectors)) result.sendButtonSelectors = normalizeSelectors(parsed.sendButtonSelectors, DEFAULT_SEND_SELECTORS);
				if (Array.isArray(parsed.textareaSelectors)) result.textareaSelectors = normalizeSelectors(parsed.textareaSelectors, DEFAULT_TEXTAREA_SELECTORS);
				if (Array.isArray(parsed.assistantSelectors)) result.assistantSelectors = normalizeSelectors(parsed.assistantSelectors, DEFAULT_ASSISTANT_SELECTORS);
				if (Array.isArray(parsed.userMessageSelectors)) result.userMessageSelectors = normalizeSelectors(parsed.userMessageSelectors, DEFAULT_USER_MESSAGE_SELECTORS);
				if (typeof parsed.halfAutoEnabled === "boolean") result.halfAutoEnabled = parsed.halfAutoEnabled;
				if (typeof parsed.autoPilotEnabled === "boolean") result.autoPilotEnabled = parsed.autoPilotEnabled;
				if (typeof parsed.pilotAutoSubmit === "boolean") result.pilotAutoSubmit = parsed.pilotAutoSubmit;
				if (typeof parsed.pilotMarkerStart === "string" && parsed.pilotMarkerStart.trim()) result.pilotMarkerStart = parsed.pilotMarkerStart.slice(0, 120);
				if (typeof parsed.pilotMarkerEnd === "string" && parsed.pilotMarkerEnd.trim()) result.pilotMarkerEnd = parsed.pilotMarkerEnd.slice(0, 120);
				if (Array.isArray(parsed.pilotDoneKeywords)) result.pilotDoneKeywords = normalizeStringArray(parsed.pilotDoneKeywords, DEFAULT_PILOT_DONE_KEYWORDS);
				if (Array.isArray(parsed.pilotRestartKeywords)) result.pilotRestartKeywords = normalizeStringArray(parsed.pilotRestartKeywords, DEFAULT_PILOT_RESTART_KEYWORDS);
				if (Array.isArray(parsed.pilotHandoffKeywords)) result.pilotHandoffKeywords = normalizeStringArray(parsed.pilotHandoffKeywords, DEFAULT_PILOT_HANDOFF_KEYWORDS);
				if (typeof parsed.pilotOutputContract === "string" && parsed.pilotOutputContract.trim()) result.pilotOutputContract = parsed.pilotOutputContract.slice(0, 2000);
			} catch {
				/* storage unavailable or corrupt: keep defaults */
			}
			return result;
		}

		/** Trim, bound length, and fall back to the given default when empty. */
		function normalizeLabel(value, fallback) {
			const trimmed = value.trim();
			if (trimmed.length === 0) return fallback;
			return trimmed.slice(0, 40);
		}

		/** Backwards-compatible alias for the top-bar tab name. */
		function normalizeTabLabel(value) {
			return normalizeLabel(value, DEFAULT_TAB_LABEL);
		}

		/** Snapshot of the in-memory preferences (authoritative after load). */
		function getConfig() {
			return { ...config };
		}

		/** Current top-bar tab label (never empty). */
		function tabLabel() {
			return config.tabLabel.length > 0 ? config.tabLabel : DEFAULT_TAB_LABEL;
		}

		/** Current right-sidebar card name (never empty). */
		function cardLabel() {
			return config.cardLabel.length > 0 ? config.cardLabel : DEFAULT_CARD_LABEL;
		}

		/** Merge a patch, persist it, and notify subscribers (Settings → tab re-injection). */
		function writeConfig(patch) {
			const next = { ...config };
			if (typeof patch.showTab === "boolean") next.showTab = patch.showTab;
			if (typeof patch.tabLabel === "string") next.tabLabel = normalizeLabel(patch.tabLabel, DEFAULT_TAB_LABEL);
			if (typeof patch.showCard === "boolean") next.showCard = patch.showCard;
			if (typeof patch.cardLabel === "string") next.cardLabel = normalizeLabel(patch.cardLabel, DEFAULT_CARD_LABEL);
			if (typeof patch.autoSyncEnabled === "boolean") next.autoSyncEnabled = patch.autoSyncEnabled;
			if (typeof patch.maxAutoLoops === "number") next.maxAutoLoops = normalizeMaxLoops(patch.maxAutoLoops);
			if (Array.isArray(patch.errorKeywords)) next.errorKeywords = normalizeStringArray(patch.errorKeywords, DEFAULT_ERROR_KEYWORDS);
			if (Array.isArray(patch.stopButtonSelectors)) next.stopButtonSelectors = normalizeSelectors(patch.stopButtonSelectors, DEFAULT_STOP_SELECTORS);
			if (Array.isArray(patch.sendButtonSelectors)) next.sendButtonSelectors = normalizeSelectors(patch.sendButtonSelectors, DEFAULT_SEND_SELECTORS);
			if (Array.isArray(patch.textareaSelectors)) next.textareaSelectors = normalizeSelectors(patch.textareaSelectors, DEFAULT_TEXTAREA_SELECTORS);
			if (Array.isArray(patch.assistantSelectors)) next.assistantSelectors = normalizeSelectors(patch.assistantSelectors, DEFAULT_ASSISTANT_SELECTORS);
			if (Array.isArray(patch.userMessageSelectors)) next.userMessageSelectors = normalizeSelectors(patch.userMessageSelectors, DEFAULT_USER_MESSAGE_SELECTORS);
			if (typeof patch.halfAutoEnabled === "boolean") next.halfAutoEnabled = patch.halfAutoEnabled;
			if (typeof patch.autoPilotEnabled === "boolean") next.autoPilotEnabled = patch.autoPilotEnabled;
			if (typeof patch.pilotAutoSubmit === "boolean") next.pilotAutoSubmit = patch.pilotAutoSubmit;
			if (typeof patch.pilotMarkerStart === "string" && patch.pilotMarkerStart.trim()) next.pilotMarkerStart = patch.pilotMarkerStart.slice(0, 120);
			if (typeof patch.pilotMarkerEnd === "string" && patch.pilotMarkerEnd.trim()) next.pilotMarkerEnd = patch.pilotMarkerEnd.slice(0, 120);
			if (Array.isArray(patch.pilotDoneKeywords)) next.pilotDoneKeywords = normalizeStringArray(patch.pilotDoneKeywords, DEFAULT_PILOT_DONE_KEYWORDS);
			if (Array.isArray(patch.pilotRestartKeywords)) next.pilotRestartKeywords = normalizeStringArray(patch.pilotRestartKeywords, DEFAULT_PILOT_RESTART_KEYWORDS);
			if (Array.isArray(patch.pilotHandoffKeywords)) next.pilotHandoffKeywords = normalizeStringArray(patch.pilotHandoffKeywords, DEFAULT_PILOT_HANDOFF_KEYWORDS);
			if (typeof patch.pilotOutputContract === "string" && patch.pilotOutputContract.trim()) next.pilotOutputContract = patch.pilotOutputContract.slice(0, 2000);
			config = next;
			try {
				window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
			} catch {
				/* storage unavailable: the in-memory value still applies this session */
			}
			for (const listener of [...configListeners]) {
				try {
					listener(config);
				} catch {
					/* one bad subscriber must not stop the others */
				}
			}
		}

		/** Subscribe to preference changes; returns a disposer. */
		function subscribeConfig(listener) {
			configListeners.add(listener);
			return () => {
				configListeners.delete(listener);
			};
		}

		// ── 条件触发式自动闭环（v1.2.0）核心 ─────────────────────────────────────
		// 设计：所有「搬运 / 发送」自动化都在插件进程内闭环；注入桌面端只写草稿
		// （InputActions.setDraft），绝不调用 submit()，是否继续运行由用户决定。
		// 双向通道用 Electron <webview> 内建 executeJavaScript（主进程会清除自定义
		// preload / nodeIntegration，ipcRenderer.sendToHost 在本机 DSH 不可行）。
		// 轮次检测用 ctx.get("sessions").binding(id).eventSource.subscribe() 读
		// turn/end + assistant/message，而非不存在的 hooksBus/TurnEnd。

		/** Extract plain text from an assistant message content block array. */
		function extractContentText(content) {
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			let out = "";
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const isText = block.type === "text" || block.kind === "text";
				if (isText && typeof block.text === "string") out += block.text;
			}
			return out;
		}

		/** Answer text of one assistant/message session event. */
		function eventAnswerText(event) {
			const data = event && event.data;
			const message = data && data.message;
			return extractContentText(message && message.content);
		}

		/** Safety valve #2: case-sensitive keyword guard over the last answer. */
		function containsErrorKeyword(text, keywords) {
			const value = String(text == null ? "" : text);
			if (!value) return false;
			const list = Array.isArray(keywords) ? keywords : DEFAULT_ERROR_KEYWORDS;
			for (const raw of list) {
				const kw = String(raw == null ? "" : raw).trim();
				if (kw && value.indexOf(kw) !== -1) return true;
			}
			return false;
		}

		/** Last assistant/message text in the window (prefer one matching this turn). */
		function collectAnswerText(snapshot, turn) {
			const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
			let fallback = "";
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const entry = entries[i];
				const event = entry && (entry.event || entry);
				if (!event || event.type !== "assistant/message") continue;
				const text = eventAnswerText(event);
				if (!text) continue;
				const data = event.data || {};
				const matches = typeof turn !== "number" || typeof data.turn !== "number" || data.turn === turn;
				if (matches) return text;
				if (!fallback) fallback = text;
			}
			return fallback;
		}

		/**
		 * 半自动带回（v1.2.1）：借鉴官方 @deepseek-ai/dsh-deepseek-chat-import 的结构化路径。
		 * 官方不 scraper 网页 DOM，而是解析 chat.deepseek.com 导出的 export_format_version:3
		 * 会话文件（src/conversation.ts 的 selectBranch + replySteps）。这里复用同样的语义：
		 *   selectExportBranch 按 current_message_id / 最大 id 选叶、沿 parent_id 回溯到 root；
		 *   exportReplyText 只取 type==='RESPONSE' 的 content（跳过 THINK / 工具 / READ_LINK）；
		 *   非 FINISHED / CONTENT_FILTER 的回答不进入草稿。
		 * 输入也兼容「用户直接粘贴网页回复纯文本」——非 JSON 形态一律原样返回。
		 */
		function selectExportBranch(file) {
			const messages = file && Array.isArray(file.messages) ? file.messages : [];
			const byId = new Map();
			let newest = null;
			for (const message of messages) {
				if (!message || typeof message !== "object" || typeof message.id !== "number") continue;
				if (byId.has(message.id)) continue;
				byId.set(message.id, message);
				if (newest === null || message.id > newest.id) newest = message;
			}
			if (newest === null) return [];
			const current = file.current_message_id;
			const selected = current === null || current === undefined ? null : (byId.get(current) || null);
			const chain = [];
			let message = selected || newest;
			const guard = byId.size + 1;
			while (message && chain.length < guard) {
				chain.push(message);
				if (message.parent_id === null || message.parent_id === undefined) break;
				const parent = byId.get(message.parent_id);
				if (!parent) break;
				message = parent;
			}
			return chain.reverse();
		}

		/** Reply text of one export ASSISTANT message (official RESPONSE-fragment semantics). */
		function exportReplyText(message) {
			if (!message || typeof message !== "object") return "";
			if (Array.isArray(message.fragments)) {
				let out = "";
				for (const fragment of message.fragments) {
					if (!fragment || typeof fragment !== "object") continue;
					if (fragment.type === "RESPONSE" && typeof fragment.content === "string" && fragment.content.length > 0) {
						out += fragment.content;
					}
				}
				if (out) return out;
			}
			// 兼容把正文直接放在 content（字符串 / block 数组）的导出变体。
			if (typeof message.content === "string") return message.content;
			if (Array.isArray(message.content)) return extractContentText(message.content);
			return "";
		}

		/**
		 * Parse a half-automatic "bring back" payload.
		 * @returns {{ ok: boolean, text: string, source: "text"|"export"|"none", reason?: string }}
		 */
		function extractExportReply(raw) {
			const value = typeof raw === "string" ? raw.trim() : "";
			if (!value) return { ok: false, text: "", source: "none", reason: "empty" };
			if (value[0] !== "{" && value[0] !== "[") return { ok: true, text: value, source: "text" };
			let parsed;
			try {
				parsed = JSON.parse(value);
			} catch {
				return { ok: true, text: value, source: "text" };
			}
			if (!parsed || typeof parsed !== "object") return { ok: true, text: value, source: "text" };
			let file = Array.isArray(parsed.messages) ? parsed : null;
			if (!file && Array.isArray(parsed)) {
				for (let i = parsed.length - 1; i >= 0; i -= 1) {
					if (parsed[i] && Array.isArray(parsed[i].messages)) { file = parsed[i]; break; }
				}
			}
			if (!file && Array.isArray(parsed.conversations)) {
				const candidate = parsed.conversations[parsed.conversations.length - 1];
				if (candidate && Array.isArray(candidate.messages)) file = candidate;
			}
			if (!file) return { ok: false, text: "", source: "export", reason: "no-session-messages" };
			const chain = selectExportBranch(file);
			if (chain.length === 0) return { ok: false, text: "", source: "export", reason: "empty-conversation" };
			for (let i = chain.length - 1; i >= 0; i -= 1) {
				const message = chain[i];
				if (!message || (message.role !== "ASSISTANT" && message.role !== "assistant")) continue;
				if (message.status === "CONTENT_FILTER") continue;
				if (typeof message.status === "string" && message.status !== "FINISHED" && message.status !== "finished") continue;
				const text = exportReplyText(message);
				if (text) return { ok: true, text, source: "export" };
			}
			return { ok: false, text: "", source: "export", reason: "no-finished-reply" };
		}

		// ── 全自动投递通道：提炼与判定纯函数（v1.4.0）────────────────────────
		/**
		 * 从网页审查回复里提炼要投递给开发 agent 的区块。
		 * 只取 markerStart…markerEnd 之间的内容，用 indexOf 截取（定界符可含正则元字符）。
		 * 顺序：完成词优先于定界符（即使没写区块，只要写完词就视为完成）。
		 * 返回 {ok,text,state,reason}；state: 'ok'|'no-marker'|'done'|'empty'。
		 */
		function extractPilotPayload(reply, cfg) {
			const text = typeof reply === "string" ? reply : "";
			const start = cfg && typeof cfg.pilotMarkerStart === "string" ? cfg.pilotMarkerStart : DEFAULT_PILOT_MARKER_START;
			const end = cfg && typeof cfg.pilotMarkerEnd === "string" ? cfg.pilotMarkerEnd : DEFAULT_PILOT_MARKER_END;
			const doneWords = cfg && Array.isArray(cfg.pilotDoneKeywords) ? cfg.pilotDoneKeywords : DEFAULT_PILOT_DONE_KEYWORDS;
			const lower = text.toLowerCase();
			// 完成词优先：审查 agent 判断任务已完成。
			for (const word of doneWords) {
				if (typeof word === "string" && word.length > 0 && lower.includes(word.toLowerCase())) {
					return { ok: false, text: "", state: "done", reason: "done-word" };
				}
			}
			if (!start || !end) return { ok: false, text: "", state: "no-marker", reason: "no-marker-config" };
			const s = text.indexOf(start);
			if (s < 0) return { ok: false, text: "", state: "no-marker", reason: "no-start-marker" };
			const bodyStart = s + start.length;
			const e = text.indexOf(end, bodyStart);
			if (e < 0) return { ok: false, text: "", state: "no-marker", reason: "no-end-marker" };
			const payload = text.slice(bodyStart, e).trim();
			if (!payload) return { ok: false, text: "", state: "empty", reason: "empty-block" };
			return { ok: true, text: payload, state: "ok", reason: "" };
		}

		/**
		 * 构造推送给网页审查 agent 的文本：桌面 turn 的正文 + 输出契约。
		 * 契约中的 {start}/{end}/{done} 用字符串替换填入（避免正则元字符）。
		 */
		function buildPilotPush(answerText, cfg) {
			const body = typeof answerText === "string" ? answerText : String(answerText == null ? "" : answerText);
			const start = cfg && typeof cfg.pilotMarkerStart === "string" ? cfg.pilotMarkerStart : DEFAULT_PILOT_MARKER_START;
			const end = cfg && typeof cfg.pilotMarkerEnd === "string" ? cfg.pilotMarkerEnd : DEFAULT_PILOT_MARKER_END;
			const doneWords = cfg && Array.isArray(cfg.pilotDoneKeywords) ? cfg.pilotDoneKeywords : DEFAULT_PILOT_DONE_KEYWORDS;
			const done = doneWords[0] || "DONE";
			const template = cfg && typeof cfg.pilotOutputContract === "string" && cfg.pilotOutputContract.trim()
				? cfg.pilotOutputContract : DEFAULT_PILOT_OUTPUT_CONTRACT;
			const contract = template
				.split("{start}").join(start)
				.split("{end}").join(end)
				.split("{done}").join(done);
			return body + "\n\n" + contract;
		}

		/**
		 * 纯函数：根据提炼结果、上一轮 payload、配置，判定本轮的下一步动作。
		 * 判定顺序（优先级从高到低）：
		 *   done（完成词）→ restart（重启词）→ handoff（用户介入词）→ duplicate（与上轮相同）
		 *   → error（错误词）→ max-loops（轮数上限）→ no-marker（未提炼到区块）→ continue（继续）。
		 * 输入 action: 'done'|'pause'|'continue'；kind 为具体原因。
		 */
		function classifyPilotReply(replyState, prevPayload, cfg) {
			const loopCount = cfg && typeof cfg.loopCount === "number" ? cfg.loopCount : 0;
			const maxAutoLoops = cfg && typeof cfg.maxAutoLoops === "number" ? cfg.maxAutoLoops : DEFAULT_MAX_LOOPS;
			const doneWords = cfg && Array.isArray(cfg.pilotDoneKeywords) ? cfg.pilotDoneKeywords : DEFAULT_PILOT_DONE_KEYWORDS;
			const restartWords = cfg && Array.isArray(cfg.pilotRestartKeywords) ? cfg.pilotRestartKeywords : DEFAULT_PILOT_RESTART_KEYWORDS;
			const handoffWords = cfg && Array.isArray(cfg.pilotHandoffKeywords) ? cfg.pilotHandoffKeywords : DEFAULT_PILOT_HANDOFF_KEYWORDS;
			const errorWords = cfg && Array.isArray(cfg.errorKeywords) ? cfg.errorKeywords : DEFAULT_ERROR_KEYWORDS;
			const state = replyState || {};
			// 完成词已在 extractPilotPayload 里识别为 state='done'。
			if (state.state === "done") return { action: "done", kind: "done", reason: "done-word" };
			const payload = typeof state.text === "string" ? state.text : "";
			const lower = payload.toLowerCase();
			for (const word of restartWords) {
				if (typeof word === "string" && word.length > 0 && lower.includes(word.toLowerCase())) {
					return { action: "pause", kind: "restart", reason: "restart-word" };
				}
			}
			// 用户介入词：命中即暂停，必须由用户本人接入处理（如宿主验收）。
			for (const word of handoffWords) {
				if (typeof word === "string" && word.length > 0 && lower.includes(word.toLowerCase())) {
					return { action: "pause", kind: "handoff", reason: "handoff-word" };
				}
			}
			// 重复检测：忽略空白差异，与上轮完全相同即视为卡住。
			const norm = (s) => String(s || "").replace(/\s+/g, "");
			if (payload && prevPayload && norm(payload) === norm(prevPayload)) {
				return { action: "pause", kind: "duplicate", reason: "duplicate-reply" };
			}
			if (containsErrorKeyword(payload, errorWords)) {
				return { action: "pause", kind: "error", reason: "error-keyword" };
			}
			if (loopCount >= maxAutoLoops) {
				return { action: "pause", kind: "max-loops", reason: "max-loops" };
			}
			if (!state.ok) {
				return { action: "pause", kind: state.reason || "no-marker", reason: state.reason || "no-marker" };
			}
			return { action: "continue", kind: "continue", reason: "" };
		}

		/**
		 * In-page bridge factory, evaluated inside the chat webview's main world.
		 * Kept as a plain string (no template interpolation inside) so it can be
		 * embedded in executeJavaScript expressions and asserted offline.
		 */
		const BRIDGE_IMPL = `(function (cfg) {
  "use strict";
  var phase = "idle";
  var baseline = "";
  var resultText = "";
  var resultReason = "";
  var startTime = 0;
  var wasGenerating = false;
  var stableCount = 0;
  var lastLen = -1;
  var observer = null;
  var replyTimeout = (cfg && cfg.replyTimeout) || 180000;
  var currentBox = null;
  var sendMethod = "";
  var sendAttempts = 0;
  var sendClicks = 0;
  var sent = false;
  // v1.2.3: 发送确认——发送前记录用户消息节点数，延迟比对是否出现新用户消息。
  var userMsgBaseline = 0;
  var confirmed = false;
  // v1.3.0 诊断（纯观测，绝不干预发送）：环形日志 + 第几轮发送计数。
  var diag = [];
  var sendGen = 0;

  function pick(selectors) {
    if (!selectors) return null;
    for (var i = 0; i < selectors.length; i++) {
      try { var el = document.querySelector(selectors[i]); if (el) return el; } catch (e) {}
    }
    return null;
  }
  function pickAll(selectors) {
    var out = [];
    if (!selectors) return out;
    for (var i = 0; i < selectors.length; i++) {
      try { var nodes = document.querySelectorAll(selectors[i]); if (nodes && nodes.length) out.push(nodes); } catch (e) {}
    }
    return out;
  }
  function lastAssistantText() {
    var best = "";
    var groups = pickAll(cfg.assistantSelectors);
    for (var g = 0; g < groups.length; g++) {
      var nodes = groups[g];
      var node = nodes[nodes.length - 1];
      var t = node ? (node.innerText || node.textContent || "") : "";
      if (t && t.trim().length > best.length) best = t.trim();
    }
    return best;
  }
  function userMessageCount() {
    // 统计当前用户消息节点数。多个选择器可能匹配同一节点，但这里只用「前后差值」，
    // 只要选择器集合固定，差值就能可靠反映是否有新用户消息追加。
    var total = 0;
    var groups = pickAll(cfg.userMessageSelectors);
    for (var g = 0; g < groups.length; g++) total += groups[g].length;
    return total;
  }
  function diagLog(at, extra) {
    try {
      var v = currentBox ? (currentBox.isContentEditable === true ? (currentBox.textContent || "") : (currentBox.value || "")) : null;
      diag.push(Object.assign({ at: at, gen: sendGen, sent: sent,
        boxEmpty: v == null ? null : String(v).trim().length === 0,
        boxLen: v == null ? null : String(v).length,
        boxHead: v == null ? null : String(v).slice(0, 24),
        method: sendMethod, clicks: sendClicks, attempts: sendAttempts }, extra || {}));
      if (diag.length > 40) diag.shift();
    } catch (e) {}
  }
  function confirm() {
    // v1.2.3 并行确认：发送后由宿主延迟调用。DOM 出现新用户消息是最强信号；
    // 若站点 DOM 选择器未命中，则降级用「输入框已被清空」作为已提交信号，避免误报失败。
    var nowCount = userMessageCount();
    var delta = nowCount - userMsgBaseline;
    var cleared = currentBox ? boxIsEmpty(currentBox) : false;
    // 清理前的原始状态，专供 confirmed/via 判断——绝不能用「自己的清理结果」当已提交信号（循环论证）。
    var clearedOriginal = cleared;
    diagLog("confirm-before-clean", { delta: delta, cleared: cleared, confirmed: confirmed });
    // v1.3.0 首轮残留修复：只在该轮确实发送过（sent=true）、且输入框仍有残留时清理。
    // 用真实浏览器编辑命令（非原生 setter），让网页受控 state 同步清空，避免重渲染写回。
    // 清理在 confirm 时序（3.5s 后）执行，此时发送早已完成，不与提交过程竞态。
    var residualCleaned = false;
    if (sent && !cleared && currentBox) {
      residualCleaned = clearResidualByUserIntent(currentBox);
      cleared = boxIsEmpty(currentBox);
      diagLog("confirm-after-clean", { delta: delta, cleared: cleared, confirmed: confirmed, residualCleaned: residualCleaned });
    }
    diagLog("confirm", { delta: delta, cleared: cleared, clearedOriginal: clearedOriginal, confirmed: confirmed, residualCleaned: residualCleaned });
    if (delta >= 1) confirmed = true;
    else if (clearedOriginal) confirmed = true;
    return {
      confirmed: confirmed,
      userMsgCount: nowCount,
      userMsgBaseline: userMsgBaseline,
      delta: delta,
      via: delta >= 1 ? "node" : (clearedOriginal ? "cleared" : "none"),
      sent: sent,
      sendMethod: sendMethod,
      sendAttempts: sendAttempts,
      sendClicks: sendClicks,
      residualCleaned: residualCleaned,
      diag: diag.slice()
    };
  }
  function stopButton() {
    var el = pick(cfg.stopButtonSelectors);
    if (el && !el.disabled) return el;
    try {
      var all = document.querySelectorAll("button");
      for (var j = 0; j < all.length; j++) {
        var label = (all[j].getAttribute("aria-label") || "") + " " + (all[j].innerText || "");
        if (/停止|Stop/i.test(label)) return all[j];
      }
    } catch (e) {}
    return null;
  }
  function sendButton() { return pick(cfg.sendButtonSelectors); }
  function textarea() { return pick(cfg.textareaSelectors); }
  function boxIsEmpty(box) {
    try {
      var v = box.isContentEditable === true ? (box.textContent || "") : (box.value || "");
      return String(v).trim().length === 0;
    } catch (e) { return false; }
  }
  // v1.3.0 首轮残留修复：用「真实浏览器编辑命令」清空已发送后残留在输入框里的文本。
  // 与失败的 clearResidualDraft（原生 setter 直写 DOM、绕过 React state 导致每轮残留）本质不同：
  // execCommand('delete') 走浏览器原生编辑路径，会派发 input 事件，让网页受控组件的 state
  // 真正同步为空，下次重渲染不会再把旧文本写回 DOM。仅在 sent=true 且检测到残留时调用。
  function clearResidualByUserIntent(box) {
    try {
      var doc = box.ownerDocument || document;
      if (typeof box.focus === "function") { try { box.focus(); } catch (e) {} }
      // textarea/input：原生 select() 全选；contenteditable：用 Range 选中节点内容。
      var selected = false;
      try {
        if (typeof box.select === "function") { box.select(); selected = true; }
      } catch (e) {}
      if (!selected && doc && doc.getSelection && doc.createRange) {
        try {
          var sel = doc.getSelection();
          var range = doc.createRange();
          range.selectNodeContents(box);
          if (sel && typeof sel.removeAllRanges === "function") {
            sel.removeAllRanges(); sel.addRange(range); selected = true;
          }
        } catch (e) {}
      }
      // execCommand('delete') 删除选中内容并派发 input（真实编辑命令，同步组件 state）。
      if (doc && typeof doc.execCommand === "function" && doc.execCommand("delete", false, null)) {
        return boxIsEmpty(box);
      }
    } catch (e) {}
    return false;
  }
  function findSendButton() {
    var btn = sendButton();
    if (btn && !btn.disabled) return btn;
    // DeepSeek 的发送键常是动态 class 的 div/button，没有稳定的 type/aria-label：
    // 扫描可点击元素，用语义文案兜底，避免选择器全部落空。
    try {
      var list = document.querySelectorAll("button, [role='button'], [data-testid]");
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var label = ((el.getAttribute && el.getAttribute("aria-label")) || "") + " " +
          ((el.getAttribute && el.getAttribute("title")) || "") + " " +
          (el.innerText || el.textContent || "");
        if (/发送|送出|Send|Submit/i.test(label) && !el.disabled) return el;
      }
    } catch (e) {}
    return null;
  }
  function keySend(ctrl) {
    if (!currentBox) return false;
    try {
      currentBox.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        ctrlKey: !!ctrl, bubbles: true, cancelable: true
      }));
      return true;
    } catch (e) { return false; }
  }
  function attemptSend() {
    if (sent) return true;
    sendAttempts += 1;
    var btn = findSendButton();
    if (btn) {
      diagLog("before-click", {});
      try { btn.click(); } catch (e) { return false; }
      sendClicks += 1; sendMethod = "click"; sent = true;
      diagLog("after-click", {});
      return true;
    }
    return false;
  }
  function keyFallback() {
    if (!currentBox) return;
    // DeepSeek 默认「Enter 发送 / Shift+Enter 换行」，先发普通 Enter；
    // 仅当输入框仍未被清空（说明 Enter 没生效）时才补 Ctrl+Enter。
    diagLog("before-keyFallback", {});
    keySend(false);
    if (!boxIsEmpty(currentBox)) keySend(true);
    sendMethod = "enter+ctrlEnter"; sent = true;
    diagLog("after-keyFallback", {});
  }
  function scheduleSends() {
    // 同步首试：requestAnimationFrame 在隐藏/被遮挡的 <webview> renderer 中永不被调度，
    // 这正是「内容填入成功却没有自动发送」的根因。绝不能再依赖 rAF。
    attemptSend();
    var timer = (typeof window.setTimeout === "function") ? window.setTimeout : null;
    if (!timer) { if (!sent) keyFallback(); return; }  // 无定时器环境（离线测试桩）：没点过就直接键盘兜底，绝不不发送
    // 输入框被清空 = 真实已发送（React 受控清空）；否则按钮可能此刻才 enable，继续重试。
    var delays = [120, 320, 700, 1400, 2800];
    for (var i = 0; i < delays.length; i++) {
      (function (d) {
        try { window.setTimeout(function () {
          if (currentBox && boxIsEmpty(currentBox)) { sent = true; return; }
          if (!sent) attemptSend();
        }, d); } catch (e) {}
      })(delays[i]);
    }
    // 1s 后输入框仍未清空 = 点击/重试都没真正发出 → 键盘兜底（普通 Enter 优先）。
    try { window.setTimeout(function () {
      diagLog("at-1s", {});
      if (currentBox && boxIsEmpty(currentBox)) { sent = true; return; }
      keyFallback();
    }, 1000); } catch (e) {}
  }
  function disconnect() {
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
  }
  function connect() {
    if (observer) return;
    try {
      observer = new MutationObserver(function () { evaluate(); });
      observer.observe(document.body || document.documentElement,
        { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled"] });
    } catch (e) {}
  }
  function finish(reason) {
    var txt = lastAssistantText();
    if (!txt || (baseline && txt === baseline)) return false;
    phase = "done";
    resultText = txt;
    resultReason = reason;
    disconnect();
    return true;
  }
  function evaluate() {
    if (phase === "done" || phase === "timeout" || phase === "idle") return;
    if (stopButton()) {
      wasGenerating = true;
      if (phase === "armed") phase = "generating";
      return;
    }
    if (wasGenerating) finish("stop");
  }
  function snapshot() {
    return { phase: phase, text: resultText, reason: resultReason,
      elapsed: Date.now() - startTime, wasGenerating: wasGenerating,
      sendMethod: sendMethod, sendAttempts: sendAttempts, sendClicks: sendClicks, sent: sent,
      confirmed: confirmed, userMsgCount: userMsgBaseline, diag: diag.slice() };
  }
  function reset() {
    disconnect();
    phase = "idle"; baseline = ""; resultText = ""; resultReason = "";
    wasGenerating = false; stableCount = 0; lastLen = -1; startTime = Date.now();
    currentBox = null; sendMethod = ""; sendAttempts = 0; sendClicks = 0; sent = false;
    userMsgBaseline = 0; confirmed = false;
  }
  function fillAndSend(text) {
    reset();
    sendGen += 1;
    var box = textarea();
    if (!box) return { ok: false, reason: "no-textarea" };
    var value = String(text == null ? "" : text);
    try {
      var editable = box.isContentEditable === true || (box.getAttribute && box.getAttribute("contenteditable") === "true");
      var proto = editable ? window.HTMLElement.prototype : window.HTMLTextAreaElement.prototype;
      var prop = editable ? "innerHTML" : "value";
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.set) desc.set.call(box, value);
      else if (editable) box.textContent = value;
      else box.value = value;
    } catch (e) { try { box.value = value; } catch (e2) {} }
    try { box.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
    try { box.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
    baseline = lastAssistantText();
    startTime = Date.now();
    phase = "armed";
    connect();
    currentBox = box;
    userMsgBaseline = userMessageCount();   // v1.2.3: 发送前的用户消息节点数，供延迟确认比对
    diagLog("after-fill", { inputLen: String(value).length });
    scheduleSends();
    return { ok: true, phase: "armed", baseline: baseline, method: sendMethod, attempts: sendAttempts };
  }
  function poll() {
    if (phase === "done" || phase === "timeout" || phase === "idle") return snapshot();
    if (Date.now() - startTime > replyTimeout) { phase = "timeout"; disconnect(); return snapshot(); }
    evaluate();
    if (phase !== "done") {
      var txt = lastAssistantText();
      if (txt && (!baseline || txt !== baseline)) {
        if (txt.length === lastLen) stableCount += 1; else stableCount = 0;
        lastLen = txt.length;
        if (stableCount >= 2) finish("stable");
      } else { stableCount = 0; }
    }
    return snapshot();
  }
  return {
    __v: 3,
    fillAndSend: fillAndSend,
    poll: poll,
    status: snapshot,
    confirm: confirm,
    reset: reset,
    arm: function () { reset(); phase = "armed"; baseline = lastAssistantText(); startTime = Date.now(); connect(); return true; }
  };
})`;

		/** Runtime config forwarded into the in-page bridge. */
		function buildBridgeConfig() {
			const c = getConfig();
			return {
				stopButtonSelectors: c.stopButtonSelectors,
				sendButtonSelectors: c.sendButtonSelectors,
				textareaSelectors: c.textareaSelectors,
				assistantSelectors: c.assistantSelectors,
				userMessageSelectors: c.userMessageSelectors,
				replyTimeout: DEFAULT_REPLY_TIMEOUT
			};
		}

		/** Self-healing bridge accessor: re-installs itself after guest navigations. */
		function ensureBridgeExpression(cfg) {
			return "(function(){var k=" + JSON.stringify(BRIDGE_KEY) + ";if(!window[k]||window[k].__v!==3){window[k]=(" + BRIDGE_IMPL + ")(" + JSON.stringify(cfg) + ");}return window[k];})()";
		}
		function bridgeSendExpression(cfg, text) {
			return ensureBridgeExpression(cfg) + ".fillAndSend(" + JSON.stringify(String(text == null ? "" : text)) + ")";
		}
		function bridgePollExpression(cfg) {
			return ensureBridgeExpression(cfg) + ".poll()";
		}
		/** v1.2.3: read back the post-send confirmation snapshot from the guest. */
		function bridgeConfirmExpression(cfg) {
			return ensureBridgeExpression(cfg) + ".confirm()";
		}

		/**
		 * Optional, best-effort loop trace. The renderer is sandboxed (no Node fs),
		 * but window.localStorage is persisted by Chromium into `Local Storage/leveldb`
		 * and is already how the plugin stores its config. It is written ONLY while
		 * autoSyncEnabled is true (default off ⇒ no writes), and never throws.
		 * test/verify-loop-runtime.cjs and test/verify-runtime.cjs read it back as
		 * objective evidence that the loop actually ran in the real app.
		 */
		function writeLoopTrace(patch, event) {
			try {
				if (!getConfig().autoSyncEnabled) return;
				let trace = {};
				try {
					const raw = window.localStorage.getItem(LOOP_TRACE_KEY);
					if (raw) { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") trace = parsed; }
				} catch { trace = {}; }
				const now = new Date().toISOString();
				const next = { ...trace, ...(patch || {}) };
				next.updatedAt = now;
				const events = Array.isArray(trace.events) ? trace.events.slice() : [];
				if (event) events.push({ at: now, stage: String(event.stage || ""), detail: String(event.detail == null ? "" : event.detail) });
				while (events.length > LOOP_TRACE_EVENT_CAP) events.shift();
				next.events = events;
				window.localStorage.setItem(LOOP_TRACE_KEY, JSON.stringify(next));
			} catch { /* observability must never break the loop */ }
		}

		/** Bridge the pure state machine's transitions into the persisted trace. */
		function traceControllerState(snap, reason) {
			const patch = {
				state: snap.state,
				loopCount: snap.loopCount,
				lastReplyPreview: String(snap.lastReply || "").slice(0, 80)
			};
			if (snap.state === "paused" || snap.state === "error" || snap.state === "timeout") {
				patch.lastAbortReason = String(reason || snap.pausedReason || snap.state);
			}
			writeLoopTrace(patch, { stage: "state:" + snap.state, detail: reason == null ? "" : reason });
		}

		/**
		 * Pure state machine for the auto-sync loop. No DOM / React / Cordis here,
		 * so the three safety valves and transitions are fully unit-testable.
		 * An optional onTrace(snapshot, reason) hook records every transition.
		 */
		function createSyncController(options) {
			const opts = options || {};
			const getConfig = opts.getConfig || (() => DEFAULTS);
			const onTrace = typeof opts.onTrace === "function" ? opts.onTrace : function () {};
			let state = "off";
			let loopCount = 0;
			let lastReply = "";
			let pausedReason = "";
			let lastSessionId = "";
			let draftInjected = true;
			// v1.2.3: 记住上次推送文本与确认状态，供「再试一次」与显式失败上报使用。
			let lastPushText = "";
			let sendConfirmed = false;
			// v1.2.5 跨会话串台修复：闭环只服务首次 turn/end 锁定的配对会话。
			// pairedSessionId="" 表示尚未绑定；currentSessionId 是当前 composer 会话；
			// switchPaused 表示因切走配对会话而暂停（切回自动恢复）。
			let pairedSessionId = "";
			let currentSessionId = "";
			let switchPaused = false;
			let pauseFromState = "";
			// v1.4.0 全自动投递通道：运行开关、当前决策卡、上轮写回的提炼文本（供重复检测）。
			let autoPilot = false;
			let pilotDecision = null; // {kind, payload, at} | null
			let lastInjectPayload = "";
			const dedup = new Map();
			const listeners = new Set();
			function snapshot() {
				return { state, loopCount, lastReply, pausedReason, lastSessionId, draftInjected, lastPushText, sendConfirmed, pairedSessionId, currentSessionId, switchPaused, autoPilot, pilotDecision, lastInjectPayload };
			}
			function emit(reason) {
				for (const listener of [...listeners]) {
					try { listener(snapshot()); } catch { /* one bad subscriber must not stop others */ }
				}
				try { onTrace(snapshot(), reason); } catch { /* observability must never break the loop */ }
			}
			function set(next, reason) {
				state = next;
				if (reason !== undefined) pausedReason = String(reason || "");
				emit(reason);
			}
			function refresh() {
				const c = getConfig();
				if (!c.autoSyncEnabled) { if (state !== "off") set("off", ""); return; }
				if (state === "off" || state === "error" || state === "paused" || state === "timeout") set("idle", "");
			}
			/** Decide what to do when a desktop turn ends. */
			function handleTurnEnd(evt) {
				const e = evt || {};
				const c = getConfig();
				if (!c.autoSyncEnabled) return { action: "skip", reason: "disabled" };
				const sid = String(e.sessionId == null ? "" : e.sessionId);
				// v1.2.5 跨会话串台修复：首次 turn/end 锁定配对会话，之后只接受该会话。
				// 会话过滤放在所有状态检查之前——非配对会话一律以明确原因挡掉，
				// 不被误判为 busy/max-loops，既不搬运也便于 trace 判读。
				if (!pairedSessionId) pairedSessionId = sid;
				else if (sid !== pairedSessionId) return { action: "skip", reason: "unpaired-session" };
				if (state === "paused") return { action: "skip", reason: "paused" };
				if (state === "waiting" || state === "pushing") return { action: "skip", reason: "busy" };
				if (loopCount >= normalizeMaxLoops(c.maxAutoLoops)) { set("paused", "max-loops"); return { action: "pause", reason: "max-loops" }; }
				if (e.reasonKind !== "completed" && e.reasonKind !== "max-tokens") return { action: "skip", reason: "turn-not-completed" };
				const key = sid + ":" + String(e.turn == null ? "" : e.turn);
				let seen = dedup.get(sid);
				if (seen && seen.has(key)) return { action: "skip", reason: "duplicate" };
				const text = String(e.answerText == null ? "" : e.answerText);
				if (containsErrorKeyword(text, c.errorKeywords)) { set("paused", "error-keyword"); return { action: "pause", reason: "error-keyword" }; }
				if (!text.trim()) return { action: "skip", reason: "empty-answer" };
				if (!seen) { seen = new Set(); dedup.set(sid, seen); }
				seen.add(key);
				loopCount += 1;
				lastSessionId = sid;
				lastPushText = text;              // v1.2.3: 记住本次推送文本，供「再试一次」使用
				sendConfirmed = false;
				draftInjected = true;
				set("pushing", "");
				return { action: "push", text, sessionId: sid, turn: e.turn };
			}
			function notePushed() { if (state === "pushing") set("waiting", ""); }
			/** v1.2.3: 发送确认结果（用户消息节点出现 / 输入框已清空）。 */
			function noteSendConfirmed(ok) { sendConfirmed = !!ok; emit(); }
			/** v1.2.3: 重发上一条推送——不增加轮次、不重复计入去重。 */
			function retryPush() {
				if (!lastPushText) return { action: "skip", reason: "no-last-push" };
				sendConfirmed = false;
				set("pushing", "");
				return { action: "push", text: lastPushText, sessionId: lastSessionId };
			}
			function noteReply(text) {
				lastReply = String(text == null ? "" : text);
				if (state === "waiting" || state === "pushing") set("injected", "");
				return lastReply;
			}
			function noteDraftInjected(ok) { draftInjected = !!ok; emit(); }
			function noteTimeout() { if (state === "waiting" || state === "pushing") set("timeout", "timeout"); }
			function noteSendFailed(reason) { if (state === "pushing") set("error", reason || "send-failed"); }
			function noteError(reason) { set("error", reason || "error"); }
			/** v1.2.6 B 方案：当前 composer 会话变化——仅记录，不再暂停；闭环跟随配对会话继续运行。 */
			function noteCurrentSession(sid) {
				const nextSid = String(sid == null ? "" : sid);
				if (nextSid === currentSessionId) return;
				currentSessionId = nextSid;
				// v1.2.6：切走配对会话不再暂停——订阅已上移到 runtime 且按配对会话定向，
				// 网页回传/草稿注入都不依赖当前 composer，闭环可以照常走完。
				switchPaused = false;
			}
			/** v1.2.5: injectDraft 前校验——dock 会话必须与配对会话一致，否则拒绝（防反向串台）。 */
			function isSessionOk(sid) {
				if (!pairedSessionId) return true;
				return String(sid == null ? "" : sid) === pairedSessionId;
			}
			/** v1.2.5: 关掉重开换绑——清空配对会话与切走暂停状态。 */
			function unpair() {
				pairedSessionId = "";
				currentSessionId = "";
				switchPaused = false;
				pauseFromState = "";
			}
			/** 手动绑定：把指定会话锁定为配对会话（无需先跑一轮 turn/end）。 */
			function bindSession(sid) {
				const nextSid = String(sid == null ? "" : sid);
				if (!nextSid) return false;
				pairedSessionId = nextSid;
				// 手动绑定时同步当前会话，确保 injectDraft 的 dock 会话校验一致，
				// 且订阅重定向（pairListener）能从 snapshot 变化中重定向到该会话。
				currentSessionId = nextSid;
				switchPaused = false;
				emit("manual-bind");
				return true;
			}
			function acknowledge() {
				if (state === "injected" || state === "done" || state === "timeout" || state === "error") {
					if (loopCount >= normalizeMaxLoops(getConfig().maxAutoLoops)) set("paused", "max-loops");
					else set("idle", "");
				}
			}
			function reset() {
				loopCount = 0;
				dedup.clear();
				lastReply = "";
				pausedReason = "";
				lastSessionId = "";
				lastPushText = "";
				sendConfirmed = false;
				draftInjected = true;
				pairedSessionId = "";
				currentSessionId = "";
				switchPaused = false;
				pauseFromState = "";
				autoPilot = false;
				pilotDecision = null;
				lastInjectPayload = "";
				set(getConfig().autoSyncEnabled ? "idle" : "off", "");
			}
			// ── v1.4.0 全自动投递通道：启停 / 决策卡 / 写回记录 ──────────────
			/** 启动全自动：清零轮次与去重，进入 idle；是否真正开跑由下一次 turn/end 驱动。 */
			function startPilot() {
				autoPilot = true;
				pilotDecision = null;
				lastInjectPayload = "";
				loopCount = 0;
				dedup.clear();
				set("idle", "");
				emit("pilot-start");
				return true;
			}
			/** 停止全自动：清除决策卡，回到 off。 */
			function stopPilot() {
				autoPilot = false;
				pilotDecision = null;
				set("off", "");
				emit("pilot-stop");
				return true;
			}
			/** 收到需要用户接管的判定：记下决策卡并进入 paused。 */
			function setPilotDecision(decision) {
				const d = decision || {};
				pilotDecision = {
					kind: String(d.kind || "decision"),
					payload: String(d.payload || ""),
					reason: String(d.reason || ""),
					at: new Date().toISOString()
				};
				set("paused", d.kind || "decision");
				emit("pilot-decision");
				return pilotDecision;
			}
			/** 记下本次投递给桌面的提炼文本（供下一轮重复检测）。 */
			function notePilotInjected(payload) {
				lastInjectPayload = String(payload == null ? "" : payload);
				emit();
			}
			/** 全自动判定为 continue 后进入提交态，等待 tryAutoSubmit 推进。 */
			function beginPilotSubmit() { set("pushing", ""); }
			/** 全自动提交成功：回到 idle，等待桌面下一轮 turn/end 驱动下一次推送。 */
			function notePilotSubmitted() { set("idle", ""); emit("pilot-submitted"); }
			/**
			 * 用户在决策卡上选择动作。只更新状态并返回意图，具体写草稿/提交由数据流层执行。
			 * action: 'continue'（清卡等下一轮）| 'edit'（改文本后提交）| 'retry'（重试本轮提交）| 'terminate'（停止）。
			 */
			function decide(action, editedPayload) {
				if (!pilotDecision) return { action: "skip", reason: "no-decision" };
				const a = String(action || "continue");
				if (a === "terminate") {
					autoPilot = false;
					pilotDecision = null;
					set("off", "");
					return { action: "terminated" };
				}
				if (a === "retry") {
					pilotDecision = null;
					set("pushing", "");
					return { action: "submit", text: lastInjectPayload, sessionId: lastSessionId };
				}
				if (a === "edit") {
					const text = String(editedPayload == null ? "" : editedPayload);
					if (!text.trim()) return { action: "skip", reason: "empty-edit" };
					pilotDecision = null;
					lastInjectPayload = text;
					set("pushing", "");
					return { action: "submit", text, sessionId: lastSessionId };
				}
				// continue：清卡、回到 idle，等下一次桌面 turn/end 自然驱动下一轮。
				pilotDecision = null;
				set("idle", "");
				return { action: "continue" };
			}
			function subscribe(listener) {
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			}
			return { getState: snapshot, refresh, handleTurnEnd, notePushed, noteSendConfirmed, retryPush, noteReply, noteDraftInjected, noteTimeout, noteSendFailed, noteError, noteCurrentSession, isSessionOk, unpair, bindSession, acknowledge, reset, startPilot, stopPilot, setPilotDecision, notePilotInjected, beginPilotSubmit, notePilotSubmitted, decide, subscribe };
		}

		/** Per-apply runtime singleton (client.js factory runs once per process). */
		let syncRuntime = null;
		function ensureSyncRuntime(ctx) {
			if (syncRuntime) { syncRuntime.ctx = ctx; return syncRuntime; }
			syncRuntime = {
				ctx,
				controller: createSyncController({ getConfig, onTrace: traceControllerState }),
				dockBinding: { current: null },
				bridge: null,
				cancelled: false,
				dockDispose: null,
				// v1.2.6 B 方案：会话事件订阅所有权从 composer dock 上移到 runtime，
				// 按「配对会话优先」定向订阅，切走当前会话也不会停。
				eventSubs: { sid: "", stop: null }
			};
			return syncRuntime;
		}

		/** Wrap a <webview> element as the two-way executeJavaScript channel. */
		function makeWebviewBridge(element) {
			function run(expr) {
				if (!element || typeof element.executeJavaScript !== "function") return Promise.resolve(null);
				try { return Promise.resolve(element.executeJavaScript(expr)); } catch (error) { return Promise.resolve(null); }
			}
			return {
				send(text) { return run(bridgeSendExpression(buildBridgeConfig(), text)); },
				poll() { return run(bridgePollExpression(buildBridgeConfig())); },
				confirm() { return run(bridgeConfirmExpression(buildBridgeConfig())); }
			};
		}

		/**
		 * v1.2.3 发送确认（并行观测，零回归）：send 报 ok 只说明「填入 + 触发了发送尝试」，
		 * 并不等于网页真的提交了消息。延迟一个完整发送窗口后回读 guest 的用户消息节点计数：
		 * 出现新用户消息（或输入框已被清空）即确认成功；否则显式进入 error 并给「再试一次」。
		 * 该确认不改变现有 waiting/轮询流程；手写桥桩（无 confirm 方法）直接跳过。
		 */
		function scheduleSendConfirmation(rt, bridge) {
			if (!bridge || typeof bridge.confirm !== "function") return;
			setTimeout(() => {
				if (rt.cancelled) return;
				Promise.resolve()
					.then(() => bridge.confirm())
					.then((cs) => {
						if (rt.cancelled || !cs) return;
						// v1.3.0 诊断（纯观测）：无论状态是否推进，都先记录本轮发送的输入框状态时序，
						// 供定位「首轮残留」的时序竞态。diagnostics 独立于下面的状态回退判断。
						try {
							const diag = Array.isArray(cs.diag) ? cs.diag : [];
							writeLoopTrace({
								sendDiagAt: new Date().toISOString(),
								sendDiagCount: diag.length,
								sendDiag: JSON.stringify(diag)
							}, { stage: "send-diag", detail: "gen:" + (diag.length ? diag[diag.length - 1].gen : "?") + " " + JSON.stringify(diag) });
						} catch { /* 诊断失败不影响主链路 */ }
						// 已推进到 injected/done 等终态说明链路本就走通了，不再回退状态。
						const now = rt.controller.getState().state;
						if (now === "injected" || now === "done") return;
						rt.controller.noteSendConfirmed(!!cs.confirmed);
						writeLoopTrace({
							lastSendConfirmed: !!cs.confirmed,
							lastSendConfirmVia: String(cs.via || ""),
							lastSendUserMsgDelta: cs.delta == null ? null : cs.delta,
							lastSendConfirmAt: new Date().toISOString()
						}, { stage: "send-confirm", detail: cs.confirmed ? ("ok:" + (cs.via || "")) : "unconfirmed" });
						if (!cs.confirmed) {
							// v1.2.4 修复实机回归：早期确认（3.5s）在 DeepSeek 上会假阴性——站点没有
							// [data-message-author-role=user] 节点且输入框常残留草稿，delta=0 且未清空，
							// 但消息其实已发送、回复正在生成。此时绝不能 noteError：那会把 state 从
							// waiting 翻成 error，直接掐断 startReplyPolling（它只在 waiting 时存活），
							// 导致「回复生成完却抓不回来」。确认只写追踪/标志，失败上报交给回复窗口超时。
						}
					})
					.catch(() => { /* 观测失败不破坏主链路 */ });
			}, SEND_CONFIRM_DELAY);
		}

		/** Channel A: push the finished desktop answer into the web chat. */
		function pushAnswerToWeb(text) {
			const rt = syncRuntime;
			if (!rt || !rt.controller) return;
			const bridge = rt.bridge;
			if (!bridge || typeof bridge.send !== "function") {
				writeLoopTrace({ lastSendResult: "no-webview", lastSendAt: new Date().toISOString() }, { stage: "send", detail: "no-webview" });
				rt.controller.noteError("no-webview");
				return;
			}
			// v1.4.0 全自动：推送正文末尾追加输出契约，要求审查 agent 按定界符提炼回复。
			const sendText = isPilotActive(rt) ? buildPilotPush(text, getConfig()) : text;
			Promise.resolve()
				.then(() => bridge.send(sendText))
				.then((res) => {
					if (!res || !res.ok) {
						writeLoopTrace({ lastSendResult: "failed:" + String(res && res.reason), lastSendAt: new Date().toISOString() }, { stage: "send", detail: "failed" });
						rt.controller.noteSendFailed(res && res.reason);
						return;
					}
					// v1.2.2: 记录实际采用的发送方式（click / enter+ctrlEnter），便于实机 loop-trace 复核「填入后确已触发发送」。
					writeLoopTrace({ lastSendResult: "ok", lastSendMethod: String((res && res.method) || ""), lastSendAttempts: (res && res.attempts) || 0, lastSendAt: new Date().toISOString() }, { stage: "send", detail: "ok" });
					rt.controller.notePushed();
					// v1.2.3: 并行观测——延迟回读用户消息节点，确认消息真的提交到网页消息流。
					scheduleSendConfirmation(rt, bridge);
					// 半自动带回（v1.2.1）：跳过 DOM 停止按钮轮询，改由用户显式粘贴回复/导出 JSON。
					// 这是官方「结构化导入」思路的落地：不再依赖易变的网页 DOM（实机两次 180s 超时）。
					if (getConfig().halfAutoEnabled) {
						writeLoopTrace({}, { stage: "half-auto-armed", detail: "please paste the web reply / export JSON into the status bar" });
					} else {
						startReplyPolling(rt);
					}
				})
				.catch(() => {
					writeLoopTrace({ lastSendResult: "exception", lastSendAt: new Date().toISOString() }, { stage: "send", detail: "exception" });
					rt.controller.noteError("send-failed");
				});
		}

		/** Channel B: poll the web chat until the reply is complete. */
		function startReplyPolling(rt) {
			const started = Date.now();
			function step() {
				if (rt.cancelled) return;
				const st = rt.controller.getState();
				if (st.state !== "waiting") return;
				if (Date.now() - started > DEFAULT_REPLY_TIMEOUT) { rt.controller.noteTimeout(); return; }
				const bridge = rt.bridge;
				if (!bridge || typeof bridge.poll !== "function") { rt.controller.noteError("no-webview"); return; }
				Promise.resolve()
					.then(() => bridge.poll())
					.then((snap) => {
						if (rt.cancelled) return;
						if (snap && snap.phase === "done" && snap.text) {
							writeLoopTrace({
								lastResponseCompleteAt: new Date().toISOString(),
								lastResponsePreview: String(snap.text).slice(0, 80)
							}, { stage: "response-complete", detail: "via-poll" });
							if (isPilotActive(rt)) { handlePilotReply(rt, snap.text); return; }
						injectDraft(rt, rt.controller.noteReply(snap.text));
							return;
						}
						if (snap && snap.phase === "timeout") { rt.controller.noteTimeout(); return; }
						setTimeout(step, DEFAULT_POLL_INTERVAL);
					})
					.catch(() => { rt.controller.noteError("poll-failed"); });
			}
			setTimeout(step, DEFAULT_POLL_INTERVAL);
		}

		/**
		 * v1.2.6 B 方案：优先用官方「会话定向」草稿 API 注入配对会话，切走也能落到会话自己。
		 * ctx.get('conversation').input.requestDraftInitialization(binding, {prompt,whenDraftExists:'replace'})
		 * 由 InputHub 按 SessionBinding 定位 shell（WeakMap，不依赖当前 React mount），
		 * 官方 dsh-client-ui-workspace 导航切换即用此法为目标会话准备草稿。
		 * 返回 'applied'|'preserved'|'blocked'；binding 失效（会话关闭/重建）时回退当前 composer。
		 */
		function injectToSessionViaApi(rt, text) {
			let ctx;
			try { ctx = rt.ctx; } catch { return "unavailable"; }
			if (!ctx || typeof ctx.get !== "function") return "unavailable";
			let sessions, conversation;
			try { sessions = ctx.get("sessions"); conversation = ctx.get("conversation"); } catch { return "unavailable"; }
			if (!sessions || typeof sessions.binding !== "function") return "unavailable";
			if (!conversation || !conversation.input || typeof conversation.input.requestDraftInitialization !== "function") return "unavailable";
			const paired = rt.controller && typeof rt.controller.getState === "function" ? rt.controller.getState().pairedSessionId : "";
			if (!paired) return "unpaired";
			let binding;
			try { binding = sessions.binding(paired); } catch { return "binding-lost"; }
			if (!binding) return "binding-lost";
			try {
				const result = conversation.input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: "replace" });
				return String(result || "unknown");
			} catch { return "api-failed"; }
		}

		/** Write the web reply into the desktop draft — NEVER calls submit(). */
		function injectDraft(rt, text) {
			let ok = false;
			let detail = "no-dock";
			// v1.2.6 B 方案：先走官方会话定向 API（切走配对会话也能注入它自己的草稿）。
			const apiResult = injectToSessionViaApi(rt, text);
			if (apiResult === "applied" || apiResult === "preserved") {
				ok = true;
				detail = "session-api:" + apiResult;
			} else if (apiResult === "blocked" || apiResult === "binding-lost") {
				// binding 失效/冻结——明确记因，不静默写进当前会话（防反向串台）。
				detail = "session-api:" + apiResult;
			} else {
				// 官方 API 不可用（老版本 / 测试桩 / 未绑定）：回退当前 composer 的 setDraft。
				const dock = rt.dockBinding && rt.dockBinding.current;
				const dockSid = dock && dock.sessionId;
				const checkSession = rt.controller && typeof rt.controller.isSessionOk === "function";
				if (checkSession && !rt.controller.isSessionOk(dockSid)) {
					writeLoopTrace({
						lastDraftInjectedAt: new Date().toISOString(),
						lastDraftResult: "session-mismatch",
						lastDraftSessionId: String(dockSid == null ? "" : dockSid),
						lastDraftPreview: String(text || "").slice(0, 80)
					}, { stage: "draft-injected", detail: "session-mismatch" });
					rt.controller.noteDraftInjected(false);
					return false;
				}
				if (dock && dock.inputActions && typeof dock.inputActions.setDraft === "function") {
					try { dock.inputActions.setDraft(text); ok = true; detail = "setDraft-only"; } catch { /* graceful fallback below */ }
				}
			}
			let pairedForTrace = "";
			try { if (rt.controller && typeof rt.controller.getState === "function") pairedForTrace = String(rt.controller.getState().pairedSessionId || ""); } catch { /* ignore */ }
			writeLoopTrace({
				lastDraftInjectedAt: new Date().toISOString(),
				lastDraftResult: ok ? "ok" : detail,
				lastDraftSessionId: pairedForTrace,
				lastDraftPreview: String(text || "").slice(0, 80)
			}, { stage: "draft-injected", detail });
			rt.controller.noteDraftInjected(ok);
			return ok;
		}

		/** 全自动是否处于运行态：开关打开且 controller 已 startPilot。 */
		function isPilotActive(rt) {
			try {
				return !!(getConfig().autoPilotEnabled && rt && rt.controller && rt.controller.getState().autoPilot);
			} catch { return false; }
		}

		/**
		 * v1.4.0 全自动：用官方 conversation.send(text) 提交提炼后的审查意见，驱动桌面下一轮。
		 * 主路径不碰 DOM、不合成键盘（native 键盘桥截断合成事件），规避 v1.3.0 直写 DOM 翻车教训。
		 * 成功→notePushed + 重新进入轮询；失败→弹「请按发送」决策卡（kind=submit-unavailable）。
		 * 返回 Promise<boolean>。
		 */
		function tryAutoSubmit(rt, text) {
			const payload = String(text == null ? "" : text);
			rt.controller.beginPilotSubmit(); // waiting/injected → pushing，便于 notePushed 推进
			let ctx = null;
			try { ctx = rt.ctx; } catch { /* ignore */ }
			let conversation = null;
			if (ctx && typeof ctx.get === "function") {
				try { conversation = ctx.get("conversation"); } catch { /* ignore */ }
			}
			// 官方会话定向范式：ctx.sessions.scope(sessionId)?.get('conversation')
			if ((!conversation || typeof conversation.send !== "function") && ctx && typeof ctx.get === "function") {
				try {
					const sessions = ctx.get("sessions");
					const paired = rt.controller.getState().pairedSessionId;
					const scoped = sessions && typeof sessions.scope === "function" && paired ? sessions.scope(paired) : null;
					const c2 = scoped && typeof scoped.get === "function" ? scoped.get("conversation") : null;
					if (c2 && typeof c2.send === "function") conversation = c2;
				} catch { /* ignore */ }
			}
			if (!conversation || typeof conversation.send !== "function") {
				writeLoopTrace({ lastAutoSubmitAt: new Date().toISOString(), lastAutoSubmitResult: "unavailable" }, { stage: "auto-submit", detail: "unavailable" });
				rt.controller.setPilotDecision({ kind: "submit-unavailable", payload, reason: "api-unavailable" });
				return Promise.resolve(false);
			}
			return Promise.resolve()
				.then(() => conversation.send(payload))
				.then(() => {
					writeLoopTrace({ lastAutoSubmitAt: new Date().toISOString(), lastAutoSubmitResult: "ok", lastAutoSubmitMethod: "conversation.send" }, { stage: "auto-submit", detail: "ok" });
					// 提交给桌面后回到 idle，等待桌面下一轮 turn/end 驱动下一次回传网页。
					rt.controller.notePilotSubmitted();
					return true;
				})
				.catch((error) => {
					writeLoopTrace({ lastAutoSubmitAt: new Date().toISOString(), lastAutoSubmitResult: "failed", lastAutoSubmitError: String((error && error.message) || error) }, { stage: "auto-submit", detail: "failed" });
					rt.controller.setPilotDecision({ kind: "submit-unavailable", payload, reason: "send-failed" });
					return false;
				});
		}

		/**
		 * v1.4.0 全自动：网页回复回来后的中枢。
		 * 提炼 → 判定 →（continue: 写回草稿 + 自动提交下一轮 / done: 完成卡 / pause: 决策卡）。
		 */
		function handlePilotReply(rt, webReply) {
			const cfg = getConfig();
			const parsed = extractPilotPayload(webReply, cfg);
			writeLoopTrace({
				lastPilotExtractState: parsed.state,
				lastPilotPayload: String(parsed.text || "").slice(0, 200),
				lastPilotExtractAt: new Date().toISOString()
			}, { stage: "pilot-extract", detail: parsed.state });
			const st = rt.controller.getState();
			const verdict = classifyPilotReply(parsed, st.lastInjectPayload, {
				loopCount: st.loopCount,
				maxAutoLoops: cfg.maxAutoLoops,
				pilotDoneKeywords: cfg.pilotDoneKeywords,
				pilotRestartKeywords: cfg.pilotRestartKeywords,
				pilotHandoffKeywords: cfg.pilotHandoffKeywords,
				errorKeywords: cfg.errorKeywords
			});
			rt.controller.noteReply(webReply); // 记录原始回复，进入 injected
			if (verdict.action === "done") {
				rt.controller.setPilotDecision({ kind: "done", payload: parsed.text, reason: verdict.reason });
				return { action: "done" };
			}
			if (verdict.action === "pause") {
				rt.controller.setPilotDecision({ kind: verdict.kind, payload: parsed.text || String(webReply || ""), reason: verdict.reason });
				return { action: "pause", kind: verdict.kind };
			}
			// continue：只写回提炼区块，绝不投递网页全文。
			rt.controller.notePilotInjected(parsed.text);
			injectDraft(rt, parsed.text);
			if (cfg.pilotAutoSubmit) return tryAutoSubmit(rt, parsed.text);
			// 未开启自动提交：留在草稿态，由用户手动运行驱动下一轮。
			return Promise.resolve({ action: "draft" });
		}

		/** 启动全自动：绑定当前会话（若尚未配对）+ 清零状态，等待下一次 turn/end 起跑。 */
		function startAutoPilot(rt) {
			if (!rt || !rt.controller) return false;
			const cfg = getConfig();
			if (!cfg.autoSyncEnabled) return false; // 总开关必须开
			const st = rt.controller.getState();
			if (!st.pairedSessionId) {
				const sid = st.currentSessionId || (rt.dockBinding && rt.dockBinding.current && rt.dockBinding.current.sessionId) || "";
				if (sid) rt.controller.bindSession(sid);
			}
			rt.cancelled = false;
			rt.controller.startPilot();
			writeLoopTrace({ lastPilotStartedAt: new Date().toISOString() }, { stage: "pilot-start", detail: "ok" });
			return true;
		}

		/** 停止全自动：清除决策卡、退回 off，但保留总开关与配对会话。 */
		function stopAutoPilot(rt) {
			if (!rt || !rt.controller) return false;
			rt.controller.stopPilot();
			writeLoopTrace({ lastPilotStoppedAt: new Date().toISOString() }, { stage: "pilot-stop", detail: "ok" });
			return true;
		}

		/**
		 * v1.2.1 half-automatic bring-back, borrowed from the official
		 * @deepseek-ai/dsh-deepseek-chat-import semantics: the user pastes the web
		 * reply (plain text) or an official chat export JSON. We parse it with the
		 * structured-export rules (current_message_id branch, RESPONSE fragments,
		 * FINISHED status) instead of scraping the page DOM, write the result into
		 * the desktop draft, and let the user decide whether to run the next turn.
		 * This is the robust fallback for the DOM path that timed out in the field.
		 */
		function bringBackReply(rt, raw) {
			const parsed = extractExportReply(raw);
			if (!parsed.ok) return { ok: false, reason: parsed.reason || "no-finished-reply" };
			writeLoopTrace({
				lastResponseCompleteAt: new Date().toISOString(),
				lastResponsePreview: String(parsed.text).slice(0, 80)
			}, { stage: "response-complete", detail: "via-half-auto:" + parsed.source });
			injectDraft(rt, rt.controller.noteReply(parsed.text));
			rt.controller.acknowledge();
			return { ok: true, source: parsed.source, text: parsed.text };
		}

		/** React to append-only session events: turn/end + assistant/message. */
		function onSessionEvents(rt, source, sessionId) {
			// v1.2.5 跨会话串台修复：非配对会话的 turn/end 直接丢弃——
			// 不仅不搬运，连 trace 都不写，避免污染判读。未绑定时放行（由 handleTurnEnd 首次锁定）。
			// 手写桩无 isSessionOk 时放行（测试兼容，真实 controller 一定有）。
			const checkSession = rt.controller && typeof rt.controller.isSessionOk === "function";
			if (checkSession && !rt.controller.isSessionOk(sessionId)) return;
			let snapshot;
			try { snapshot = source.getSnapshot(); } catch { return; }
			const change = snapshot && snapshot.change;
			if (!change || change.kind !== "append") return;
			const entries = Array.isArray(change.entries) ? change.entries : [];
			for (const entry of entries) {
				const event = entry && (entry.event || entry);
				if (!event || event.type !== "turn/end") continue;
				const data = event.data || {};
				const reasonKind = data.reason && data.reason.kind;
				writeLoopTrace({
					lastTurnEndAt: new Date().toISOString(),
					lastTurnSessionId: String(sessionId == null ? "" : sessionId),
					lastTurnIndex: data.turn == null ? null : data.turn,
					lastTurnReason: String(reasonKind == null ? "" : reasonKind)
				}, { stage: "turn/end", detail: "reason=" + String(reasonKind == null ? "" : reasonKind) });
				const answerText = collectAnswerText(snapshot, data.turn);
				const decision = rt.controller.handleTurnEnd({ sessionId, turn: data.turn, reasonKind, answerText });
				if (decision.action === "push") pushAnswerToWeb(decision.text);
			}
		}

		/**
		 * v1.2.6 B 方案：会话事件订阅所有权从 composer dock 上移到 runtime。
		 * 目标会话 = 配对会话优先，未配对时才用当前 composer 会话（让首个 turn/end 能到达并锁定）。
		 * 一旦配对，切走当前会话不会换订/停订——闭环继续跟随配对会话跑。
		 */
		function ensureEventSubscription(rt, preferredSid) {
			const st = rt.controller && typeof rt.controller.getState === "function" ? rt.controller.getState() : null;
			const paired = st && st.pairedSessionId ? st.pairedSessionId : "";
			const target = paired || String(preferredSid == null ? "" : preferredSid);
			if (!target) return;
			if (rt.eventSubs && rt.eventSubs.sid === target && rt.eventSubs.stop) return; // 已订目标会话
			if (rt.eventSubs && rt.eventSubs.stop) {
				try { rt.eventSubs.stop(); } catch { /* ignore */ }
				rt.eventSubs.stop = null;
			}
			let sessions = null;
			try { sessions = rt.ctx.get("sessions"); } catch { return; }
			if (!sessions || typeof sessions.binding !== "function") return;
			let binding;
			try { binding = sessions.binding(target); } catch { return; }
			const source = binding && binding.eventSource;
			if (!source || typeof source.subscribe !== "function" || typeof source.getSnapshot !== "function") return;
			let stop;
			try { stop = source.subscribe(() => onSessionEvents(rt, source, target)); } catch { return; }
			if (!rt.eventSubs) rt.eventSubs = { sid: "", stop: null };
			rt.eventSubs.sid = target;
			rt.eventSubs.stop = stop;
		}

		/** Hidden conversation.composer.dock entry: captures InputActions + reports the current session. */
		function makeSyncDock(rt) {
			return function SyncDockBinding(props) {
				const p = props || {};
				if (p.inputActions && typeof p.inputActions.setDraft === "function") {
					rt.dockBinding.current = { inputActions: p.inputActions, sessionId: p.sessionId };
				}
				react.useEffect(() => {
					// v1.2.6: 只上报当前会话（信息用途）+ 确保订阅指向配对会话。
					// 订阅所有权在 runtime，dock cleanup 不再停订——切走也不中断闭环。
					try { if (rt.controller && typeof rt.controller.noteCurrentSession === "function") rt.controller.noteCurrentSession(p.sessionId); } catch { /* ignore */ }
					try { ensureEventSubscription(rt, p.sessionId); } catch { /* ignore */ }
					return undefined;
				}, [p.sessionId]);
				return null;
			};
		}

		/** Register / unregister the dock entry when the master switch is toggled. */
		function syncAutoLoop(rt, register) {
			const enabled = getConfig().autoSyncEnabled;
			rt.controller.refresh();
			if (enabled && !rt.dockDispose) {
				rt.cancelled = false;
				// v1.2.6: 配对会话变化（首次锁定 / 换绑 unpair / reset）后，重定向下订阅。
				if (!rt.pairListener) {
					let lastPaired = "";
					try {
						rt.pairListener = rt.controller.subscribe((snap) => {
							const paired = snap && snap.pairedSessionId ? snap.pairedSessionId : "";
							if (paired !== lastPaired) {
								lastPaired = paired;
								try { ensureEventSubscription(rt, paired || (snap && snap.currentSessionId)); } catch { /* ignore */ }
							}
						});
					} catch { rt.pairListener = null; }
				}
				rt.dockDispose = register("conversation.composer.dock", {
					name: "conversation.composer.dock",
					id: "deepseek-chat-auto-sync",
					order: 900,
					label: "DeepSeek auto-sync"
				}, makeSyncDock(rt));
			} else if (!enabled && rt.dockDispose) {
				try { rt.dockDispose(); } catch { /* ignore */ }
				rt.dockDispose = null;
				rt.cancelled = true;
				// v1.2.6: 关闭总开关时停订会话事件 + 注销配对监听。
				if (rt.eventSubs && rt.eventSubs.stop) {
					try { rt.eventSubs.stop(); } catch { /* ignore */ }
					rt.eventSubs.stop = null;
					rt.eventSubs.sid = "";
				}
				if (rt.pairListener) {
					try { rt.pairListener(); } catch { /* ignore */ }
					rt.pairListener = null;
				}
				rt.controller.refresh();
			}
		}

		/**
		 * 复用 DSH 官方设置页入口 settings.open。
		 *
		 * 桌面端（Electron）的 shortcuts 服务走 native keyboard bridge：
		 * installKeyboard(..., native=true) 会在 keydown handler 里 `if (native) return`
		 * 提前截断，所以合成 DOM keydown 在桌面端根本不会触发命令——账户菜单里的
		 * 「设置」项其实是走 registry.invoke('settings.open', context)。因此首选
		 * 直接调 registry.invoke（与官方菜单同款、跨版本稳定）；只有拿不到 registry
		 * 时才回退到合成 keydown（Web 端有效）。
		 *
		 * @param ctxArg  可选 cordis ctx（测试可注入）；缺省取 syncRuntime.ctx。
		 * @param docArg  可选 document（用于构造 modal/region context）。
		 */
		/**
		 * 设置面板打开后，把左侧导航切到本插件的「DeepSeek 聊天」section。
		 *
		 * 官方 settings.open 命令只接 {modal}、不支持 section 参数；shell store 的
		 * openSection(id) 又未通过 ctx.provide 暴露给外部插件。因此复用面板内真实
		 * DOM click（走 React 事件委托，不受桌面端 native 键盘桥对合成 keydown 的
		 * 截断——那正是上一版齿轮失效的根因）去点 label 为「DeepSeek 聊天 /
		 * DeepSeek Chat」的 nav 按钮。面板是异步渲染的，故先立即试一次，再短轮询。
		 * 任何一步失败都只是"停在默认 section"，不比修复前更差。
		 *
		 * @param docArg    可选 document（测试可注入）。
		 * @param timersArg 可选 setTimeout（测试可注入空函数以免异步残留）。
		 */
		function focusDeepSeekChatSection(docArg, timersArg) {
			const doc = docArg || (function () {
				try { if (typeof document !== "undefined") return document; } catch { /* ignore */ }
				return null;
			})();
			if (!doc || typeof doc.querySelectorAll !== "function") return false;
			const labels = ["DeepSeek 聊天", "DeepSeek Chat"];
			const findAndClick = () => {
				let buttons;
				try {
					// 只在设置 dialog 内找——主界面左侧栏也有「DeepSeek 聊天」按钮，
					// 面板没渲染时若回退到整个 document，会误点它、切走整个会话界面。
					// 找不到面板就直接返回 false，交给下面的短轮询重试。
					const panel = typeof doc.querySelector === "function"
						? doc.querySelector('[data-shortcut-modal="settings"]') : null;
					if (!panel) return false;
					buttons = panel.querySelectorAll("button");
				} catch { return false; }
				for (let i = 0; i < buttons.length; i += 1) {
					const btn = buttons[i];
					const text = String(btn.textContent == null ? "" : btn.textContent).trim();
					if (labels.indexOf(text) !== -1) {
						try {
							btn.click();
							try { if (typeof console !== "undefined" && console.info) console.info("[deepseek-chat] 齿轮定位：已点击设置页 section「" + text + "」"); } catch { /* ignore */ }
							return true;
						} catch { /* ignore */ }
					}
				}
				return false;
			};
			if (findAndClick()) return true;
			const T = timersArg || (function () {
				try { if (typeof setTimeout !== "undefined") return setTimeout; } catch { /* ignore */ }
				return null;
			})();
			if (typeof T !== "function") return false;
			// 面板异步渲染，不同 DSH 版本快慢不一，轮询窗口放宽到约 1 秒。
			[50, 120, 250, 450, 700, 1000].forEach((delay) => {
				try { T(findAndClick, delay); } catch { /* ignore */ }
			});
			return true;
		}

		function openSettingsViaShortcut(ctxArg, docArg, winArg, KeyEvArg, timersArg) {
			const ctx = ctxArg || (syncRuntime && syncRuntime.ctx) || null;
			const doc = docArg || (function () {
				try { if (typeof document !== "undefined") return document; } catch { /* ignore */ }
				return null;
			})();

			// —— 首选：直接调 shortcuts.registry.invoke('settings.open')（桌面端唯一可靠路径）——
			let shortcuts = null;
			try { if (ctx && typeof ctx.get === "function") shortcuts = ctx.get("shortcuts"); } catch { /* ignore */ }
			if (!shortcuts && ctx && ctx.shortcuts) shortcuts = ctx.shortcuts;
			let registry = null;
			if (shortcuts) {
				// registry 是 TS private，运行时为普通属性；部分版本也可能直接暴露 invoke。
				if (shortcuts.registry && typeof shortcuts.registry.invoke === "function") registry = shortcuts.registry;
				else if (typeof shortcuts.invoke === "function") registry = shortcuts;
			}
			if (registry) {
				try {
					const active = doc ? doc.activeElement : null;
					// modal 传 null：确保 resolve 走 shellInstance.actions.open()，
					// 不被其它已打开 modal 的 block 规则挡住（设置页已开时 open 幂等）。
					const context = { region: "page", modal: null, target: active, source: "menu" };
					registry.invoke("settings.open", context);
					try { if (typeof console !== "undefined" && console.info) console.info("[deepseek-chat] 齿轮：已通过 shortcuts.registry.invoke('settings.open') 请求打开设置页"); } catch { /* ignore */ }
					focusDeepSeekChatSection(doc, timersArg);
					return true;
				} catch { /* 落到下面的回退 */ }
			}

			// —— 回退：合成 primary+Comma keydown（Web 端有效；桌面端会被 native 截断）——
			const KE = KeyEvArg || (function () {
				try { if (typeof KeyboardEvent !== "undefined") return KeyboardEvent; } catch { /* ignore */ }
				try { if (typeof globalThis !== "undefined" && globalThis.KeyboardEvent) return globalThis.KeyboardEvent; } catch { /* ignore */ }
				return null;
			})();
			const win = winArg || (function () {
				try { if (typeof window !== "undefined") return window; } catch { /* ignore */ }
				try { if (typeof globalThis !== "undefined") return globalThis; } catch { /* ignore */ }
				return null;
			})();
			if (!KE || !win || typeof win.dispatchEvent !== "function") return false;
			let isMac = false;
			try {
				const nav = win.navigator || (typeof navigator !== "undefined" ? navigator : null);
				isMac = !!(nav && /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent || ""));
			} catch { /* assume non-Mac */ }
			try {
				win.dispatchEvent(new KE("keydown", {
					code: "Comma", key: ",",
					ctrlKey: !isMac, metaKey: isMac, altKey: false, shiftKey: false,
					bubbles: true, cancelable: true
				}));
				focusDeepSeekChatSection(doc, timersArg);
				return true;
			} catch { return false; }
		}

		/**
		 * 会话的展示标题：优先用 DSH 官方 displayTitle（标题→项目目录名→原始 id 的回退），
		 * 取不到（服务缺席 / 列表就绪前）时回退短 id，保证冷启动与测试桩零回归。
		 */
		function sessionDisplayTitle(rt, sid) {
			const id = String(sid == null ? "" : sid);
			if (!id) return "";
			try {
				const sessions = rt && rt.ctx ? rt.ctx.get("sessions") : null;
				const list = sessions && sessions.list;
				if (list && typeof list.getSnapshot === "function") {
					const snap = list.getSnapshot();
					const row = snap && snap.byId && snap.byId[id];
					if (row) {
						const title = row.displayTitle || row.title;
						if (title) return String(title);
					}
				}
			} catch { /* ignore */ }
			return id.slice(0, 18);
		}

		/** Human-facing status strip shown in the chat panel (read-only + copy fallback). */
		function SyncStatusBar() {
			const [, force] = react.useState(0);
			const [bringBackMsg, setBringBackMsg] = react.useState("");
			const [pilotEdit, setPilotEdit] = react.useState(null);
			const taRef = react.useRef(null);
			const rt = syncRuntime;
			react.useEffect(() => {
				const bump = () => force((v) => v + 1);
				const a = rt ? rt.controller.subscribe(bump) : null;
				const b = subscribeConfig(bump);
				// 会话标题可能晚于列表就绪才由 Host 投影，订阅列表以便标题到达后刷新显示。
				let c = null;
				try {
					const sessions = rt && rt.ctx ? rt.ctx.get("sessions") : null;
					const list = sessions && sessions.list;
					if (list && typeof list.subscribe === "function") c = list.subscribe(bump);
				} catch { /* ignore */ }
				return () => { try { if (a) a(); b(); if (c) c(); } catch { /* ignore */ } };
			}, []);
			if (!rt || !getConfig().autoSyncEnabled) return null;
			const st = rt.controller.getState();
			const halfAuto = !!getConfig().halfAutoEnabled;
			const onBringBack = () => {
				const node = taRef.current;
				const raw = node && typeof node.value === "string" ? node.value : "";
				const res = bringBackReply(rt, raw);
				if (res.ok) {
					setBringBackMsg(COPY.syncBringBackOk);
					try { if (node) node.value = ""; } catch { /* ignore */ }
				} else {
					setBringBackMsg(res.reason === "empty" ? COPY.syncBringBackEmpty : COPY.syncBringBackFailed);
				}
				force((v) => v + 1);
			};
			// v1.4.0 全自动决策卡：把用户选择交给 controller.decide，submit 意图再由 tryAutoSubmit 落地。
			const onPilotDecision = (action) => {
				const dec = st.pilotDecision;
				const text = action === "edit"
					? (pilotEdit != null ? pilotEdit : (dec && dec.payload) || "")
					: undefined;
				const res = rt.controller.decide(action, text);
				setPilotEdit(null);
				if (res && res.action === "submit") tryAutoSubmit(rt, res.text);
				force((v) => v + 1);
			};
			let label;
			// v1.2.6 B 方案：当前会话 != 配对会话时，说明闭环在后台配对会话继续跑、
			// 而用户人在别的会话——用专门文案说明「回复会进配对会话草稿，切回查看」。
			const awayFromPaired = !!(st.pairedSessionId && st.currentSessionId && st.pairedSessionId !== st.currentSessionId);
			const pilotActive = !!(st.autoPilot && getConfig().autoPilotEnabled);
			if (pilotActive && st.state !== "off") {
				// v1.4.0 全自动：运行态用专门文案 + 轮次；暂停时交给决策卡说明原因。
				label = st.state === "paused"
					? COPY.pilotPaused
					: (COPY.pilotRunning + " " + st.loopCount + "/" + normalizeMaxLoops(getConfig().maxAutoLoops));
			} else if (awayFromPaired) label = COPY.syncSwitchPaused;
			else switch (st.state) {
				case "off": label = COPY.syncStateOff; break;
				case "idle": label = COPY.syncStateIdle; break;
				case "pushing": label = COPY.syncStatePushing; break;
				case "waiting": label = halfAuto ? COPY.syncStateHalfAutoWaiting : COPY.syncStateWaiting; break;
				case "injected": label = COPY.syncStateInjected; break;
				case "paused": label = COPY.syncStatePaused; break;
				case "timeout": label = COPY.syncStateTimeout; break;
				case "error": label = COPY.syncStateError + (st.pausedReason ? " · " + st.pausedReason : ""); break;
				default: label = COPY.syncStateDone;
			}
			const children = [
				react.createElement("span", { style: styles.syncDot }, ""),
				react.createElement("span", { style: styles.syncLabel }, label),
				react.createElement("span", { style: styles.syncCount }, COPY.syncRound + " " + st.loopCount + "/" + normalizeMaxLoops(getConfig().maxAutoLoops)),
				// v1.4.0 全自动：一键启停。停止后回条件闭环老状态。
				react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": pilotActive ? "sync-pilot-stop" : "sync-pilot-start",
					style: pilotActive ? styles.syncPilotStop : styles.syncPilotStart,
					title: pilotActive ? COPY.pilotStop : COPY.pilotStart,
					onClick: () => { if (pilotActive) stopAutoPilot(rt); else startAutoPilot(rt); force((v) => v + 1); }
				}, pilotActive ? COPY.pilotStop : COPY.pilotStart)
			];
			// v1.2.5: 显示当前绑定的会话，闭环只服务这一个会话。
			// 优先用官方 displayTitle（会话标题），取不到才回退短 id。
			if (st.pairedSessionId) {
				children.push(react.createElement("span", { style: styles.syncCount },
					COPY.syncPairedTo + " " + sessionDisplayTitle(rt, st.pairedSessionId)));
				children.push(react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": "sync-rebind",
					style: styles.syncButton,
					onClick: () => { rt.controller.unpair(); rt.controller.reset(); }
				}, COPY.syncRebind));
			} else if (st.currentSessionId) {
				// 手动绑定：未锁定配对会话时，用当前 composer 会话作为目标一键绑定，
				// 无需先跑一轮 turn/end 才自动锁定。
				children.push(react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": "sync-bind",
					style: styles.syncButton,
					title: COPY.syncBindTitle,
					onClick: () => { try { rt.controller.bindSession(st.currentSessionId); } catch { /* ignore */ } }
				}, COPY.syncBind));
			}
			const needsReset = st.state === "paused" || st.state === "error" || st.state === "timeout";
			if (needsReset) {
				children.push(react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": "sync-reset",
					style: styles.syncButton,
					onClick: () => { rt.controller.reset(); }
				}, COPY.syncReset));
			}
			// v1.2.4: 「再试一次」只在 send 真正失败（res 不 ok / exception → error）时出现。
			// v1.2.3 曾把「3.5s 早期确认假阴性」也做成 error+重试，实机证明那会掐断回复轮询，
			// 现已把确认降级为纯观测，故这里不再用 pausedReason==="unconfirmed" 触发。
			const canRetry = st.state === "error" && st.pausedReason !== "unconfirmed" && st.lastPushText;
			if (canRetry) {
				children.push(react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": "sync-retry-send",
					style: styles.syncButton,
					onClick: () => {
						const decision = rt.controller.retryPush();
						if (decision && decision.action === "push") pushAnswerToWeb(decision.text);
					}
				}, COPY.syncRetrySend));
			}
			if (st.lastReply && (!st.draftInjected || needsReset)) {
				children.push(react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": "sync-copy",
					style: styles.syncButton,
					onClick: () => {
						try {
							const clip = navigator.clipboard;
							if (clip && typeof clip.writeText === "function") clip.writeText(st.lastReply);
						} catch { /* ignore */ }
					}
				}, COPY.syncCopyReply));
			}
			if (halfAuto && st.state === "waiting") {
				const row = [
					react.createElement("button", {
						type: "button",
						"data-dsh-plugin-deepseek-chat": "sync-bring-back",
						style: styles.syncButton,
						onClick: onBringBack
					}, COPY.syncBringBack),
					react.createElement("span", { style: styles.syncBringBackMsg }, bringBackMsg)
				];
				children.push(react.createElement("div", { style: styles.syncBringBack },
					react.createElement("textarea", {
						"data-dsh-plugin-deepseek-chat": "sync-bring-back-input",
						style: styles.syncBringBackInput,
						placeholder: COPY.syncBringBackPlaceholder,
						rows: 2,
						ref: taRef
					}),
					react.createElement("div", { style: styles.syncBringBackRow }, row)));
			}
			// v1.4.0 全自动决策卡：命中完成词/重启词/用户介入词/重复/错误/最大轮数等暂停时渲染。
			const pdec = st.pilotDecision;
			if (pilotActive && pdec) {
				const reasonKey = {
					done: "pilotReasonDone",
					restart: "pilotReasonRestart",
					handoff: "pilotReasonHandoff",
					duplicate: "pilotReasonDuplicate",
					error: "pilotReasonError",
					"max-loops": "pilotReasonMaxLoops",
					"no-marker": "pilotReasonNoMarker",
					"submit-unavailable": "pilotReasonSubmitUnavailable"
				}[pdec.kind] || "pilotDecisionHint";
				const cardChildren = [
					react.createElement("div", { style: styles.syncPilotCardTitle },
						pdec.kind === "done" ? COPY.pilotDone : COPY.pilotDecisionHint),
					react.createElement("div", { style: styles.syncPilotCardReason }, COPY[reasonKey] || COPY.pilotDecisionHint)
				];
				// 完成卡只需「终止」；其余卡提供继续/编辑/重试/终止。
				const row = [];
				if (pdec.kind !== "done") {
					row.push(react.createElement("button", {
						type: "button",
						"data-dsh-plugin-deepseek-chat": "sync-pilot-continue",
						style: styles.syncButton,
						onClick: () => onPilotDecision("continue")
					}, COPY.pilotContinue));
					row.push(react.createElement("button", {
						type: "button",
						"data-dsh-plugin-deepseek-chat": "sync-pilot-retry",
						style: styles.syncButton,
						onClick: () => onPilotDecision("retry")
					}, COPY.pilotRetry));
				}
				row.push(react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": "sync-pilot-terminate",
					style: styles.syncPilotStop,
					onClick: () => onPilotDecision("terminate")
				}, COPY.pilotTerminate));
				cardChildren.push(react.createElement("div", { style: styles.syncPilotCardRow }, row));
				// 编辑行：用户改写提炼意见后写回草稿并提交；仅在非完成卡显示。
				if (pdec.kind !== "done") {
					const editRow = [
						react.createElement("textarea", {
							"data-dsh-plugin-deepseek-chat": "sync-pilot-edit-input",
							style: styles.syncPilotCardBody,
							placeholder: COPY.pilotEditPlaceholder,
							rows: 3,
							value: pilotEdit != null ? pilotEdit : (pdec.payload || ""),
							onChange: (e) => setPilotEdit(e && e.target ? e.target.value : "")
						}),
						react.createElement("button", {
							type: "button",
							"data-dsh-plugin-deepseek-chat": "sync-pilot-edit",
							style: styles.syncButton,
							onClick: () => onPilotDecision("edit")
						}, COPY.pilotApplyEdit)
					];
					cardChildren.push(react.createElement("div", { style: styles.syncPilotCardRow }, editRow));
				}
				children.push(react.createElement("div", {
					style: styles.syncPilotCard,
					"data-dsh-plugin-deepseek-chat": "sync-pilot-card"
				}, cardChildren));
			}
			// 齿轮：点击复用官方 settings.open 入口，直接跳到本插件的设置页。
			// 用 inline SVG 齿轮（与 DSH 设置菜单的齿轮一致、比 unicode ⚙ 更清晰更大）。
			children.push(react.createElement("button", {
				type: "button",
				"data-dsh-plugin-deepseek-chat": "sync-settings",
				style: styles.syncGearButton,
				title: COPY.syncSettings,
				"aria-label": COPY.syncSettings,
				onClick: () => { openSettingsViaShortcut(); }
			}, react.createElement("svg", {
				viewBox: "0 0 24 24",
				width: 18,
				height: 18,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true"
			},
				react.createElement("path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }),
				react.createElement("circle", { cx: 12, cy: 12, r: 3 })
			)));
			return react.createElement("div", {
				style: styles.syncBar,
				"data-dsh-plugin-deepseek-chat": "sync-status"
			}, children);
		}

		// ── 关于 & 检查更新（v1.1.5）────────────────────────────────────────────
		/** status: idle | checking | up-to-date | found | failed | updating | updated | restart-required | update-failed. */
		let updateState = { status: "idle" };
		function getUpdateState() {
			return { ...updateState };
		}
		function setUpdateState(next) {
			updateState = next;
		}
		function resetUpdateState() {
			updateState = { status: "idle" };
		}

		/**
		 * Numeric comparison of dotted versions, so 1.1.10 > 1.1.9. Missing
		 * parts count as zero and a non-numeric part parses as zero. A local
		 * unreleased build can legitimately be ahead of the published "latest".
		 * @param a - first version.
		 * @param b - second version.
		 * @returns -1 when a < b, 0 when equal, 1 when a > b.
		 */
		function compareVersion(a, b) {
			const partsA = String(a ?? "").split(".").map((part) => parseInt(part, 10) || 0);
			const partsB = String(b ?? "").split(".").map((part) => parseInt(part, 10) || 0);
			const length = Math.max(partsA.length, partsB.length);
			for (let index = 0; index < length; index += 1) {
				const left = partsA[index] ?? 0;
				const right = partsB[index] ?? 0;
				if (left > right) return 1;
				if (left < right) return -1;
			}
			return 0;
		}

		/** Extract a dotted version from an npm dist-tags or package.json payload. */
		function versionFromPayload(text) {
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				return void 0;
			}
			if (parsed === null || typeof parsed !== "object") return void 0;
			const candidate = typeof parsed.latest === "string" && parsed.latest.length > 0
				? parsed.latest
				: parsed.version;
			if (typeof candidate !== "string") return void 0;
			const trimmed = candidate.trim();
			return /^\d+(?:\.\d+)*$/u.test(trimmed) ? trimmed : void 0;
		}

		/** The renderer's fetch, if available (no Host route is added). */
		function getFetch() {
			try {
				if (typeof fetch === "function") return fetch;
				if (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function") return globalThis.fetch;
			} catch {
				/* fetch unavailable */
			}
			return void 0;
		}

		/** GET one JSON endpoint with an abort timeout; return its version. */
		async function readVersionFrom(fetchImpl, url, timeoutMs) {
			const controller = typeof AbortController !== "undefined" ? new AbortController() : void 0;
			const timer = controller !== void 0 ? setTimeout(() => controller.abort(), timeoutMs) : void 0;
			try {
				const options = controller !== void 0 ? { signal: controller.signal } : {};
				const response = await fetchImpl(url, options);
				if (response === null || response === void 0 || response.ok === false) {
					throw new Error(`HTTP ${response?.status ?? "no response"}`);
				}
				const text = await response.text();
				const version = versionFromPayload(text);
				if (version === void 0) throw new Error("no version in payload");
				return version;
			} finally {
				if (timer !== void 0) clearTimeout(timer);
			}
		}

		/**
		 * npm first, GitHub raw package.json as a fallback. Both endpoints are
		 * public, need no authentication, and answer with permissive CORS.
		 * @param fetchImpl - fetch implementation.
		 * @param timeoutMs - per-request abort timeout.
		 * @returns {Promise<{version: string, source: string}>}
		 * @throws when both sources fail.
		 */
		async function fetchLatestVersion(fetchImpl, timeoutMs = 8000) {
			let npmError;
			try {
				const version = await readVersionFrom(fetchImpl, NPM_VERSION_URL, timeoutMs);
				return { version, source: "npm" };
			} catch (error) {
				npmError = error;
			}
			try {
				const version = await readVersionFrom(fetchImpl, GITHUB_VERSION_URL, timeoutMs);
				return { version, source: "GitHub" };
			} catch {
				/* fall through to the npm error */
			}
			throw npmError ?? new Error("npm and GitHub both failed");
		}

		/**
		 * Run the update check. State transitions are published through
		 * setUpdateState() and onChange() lets the Settings view repaint. Overlap
		 * is ignored while a check is in flight.
		 * @param onChange - called after each published state.
		 */
		async function checkForUpdates(onChange) {
			if (updateState.status === "checking") return;
			const publish = (next) => {
				setUpdateState(next);
				if (typeof onChange === "function") {
					try {
						onChange();
					} catch {
						/* a dead view must not break the check */
					}
				}
			};
			const fetchImpl = getFetch();
			if (fetchImpl === void 0) {
				publish({ status: "failed", reason: COPY.updateNoFetch });
				return;
			}
			publish({ status: "checking" });
			try {
				const { version, source } = await fetchLatestVersion(fetchImpl);
				publish(compareVersion(version, PLUGIN_VERSION) > 0
					? { status: "found", latest: version, source }
					: { status: "up-to-date", latest: version, source });
			} catch (error) {
				publish({ status: "failed", reason: String((error && error.message) || error) });
			}
		}

		/**
		 * One-click update (v1.1.10): ask the official DSH Host pluginManager
		 * to replace this bundle with the target version. ctx.get("remote") is
		 * a guard-allowed soft read, so remote is NOT added to exports.inject
		 * (declaring a service that is late on a cold start would park the whole
		 * plugin fiber). updateBundle answers with a ChangeResult whose
		 * application is applied / restart-required / failed / ...; a link:
		 * install is refused in updateRefusal and comes back as failed with an
		 * { code, diagnostic } error (no message), so every shape is handled.
		 * The npm / GitHub jump links stay visible as a manual fallback.
		 */
		async function runUpdate(ctx, version, onChange) {
			const publish = (next) => {
				setUpdateState(next);
				if (typeof onChange === "function") {
					try {
						onChange();
					} catch {
						/* a dead view must not break the update */
					}
				}
			};
			publish({ status: "updating", latest: version });
			let manager;
			try {
				const remote = typeof ctx.get === "function" ? ctx.get("remote") : void 0;
				manager = remote?.pluginManager;
			} catch {
				manager = void 0;
			}
			if (manager === void 0 || typeof manager.updateBundle !== "function") {
				publish({ status: "update-failed", latest: version, reason: COPY.updateNoChannel });
				return;
			}
			try {
				const answer = await manager.updateBundle(PLUGIN_NAME, version);
				const result = answer?.result ?? {};
				if (result.application === "applied") {
					publish({ status: "updated", latest: version });
				} else if (result.application === "restart-required") {
					publish({ status: "restart-required", latest: version });
				} else {
					const error = result.error;
					const reason = String(error?.message ?? error?.diagnostic ?? error?.code ?? COPY.updateInstallFailed);
					publish({ status: "update-failed", latest: version, reason });
				}
			} catch (error) {
				publish({ status: "update-failed", latest: version, reason: String((error && error.message) || error) });
			}
		}

		/**
		 * ONE stable guest partition for the whole process. release() destroys
		 * only the guest, never the partition's cookies, so this value is an
		 * absolute constant.
		 * @returns the fixed workspace identity for guest leases.
		 */
		function partitionKeyFor() {
			return PARTITION_BASE;
		}

		/**
		 * ONE stable conversation-memory key.
		 * @returns the fixed localStorage key.
		 */
		function storageKeyFor() {
			return STORAGE_BASE;
		}

		/**
		 * Parse a chat.deepseek.com page URL.
		 * @param value - candidate URL.
		 * @returns the parsed URL for the site origin, or undefined.
		 */
		function parseChatUrl(value) {
			if (typeof value !== "string" || value.length === 0 || value.length > 4096) return void 0;
			try {
				const url = new URL(value);
				if (url.protocol !== "https:" || url.hostname !== "chat.deepseek.com") return void 0;
				if (url.username !== "" || url.password !== "" || url.port !== "") return void 0;
				return url;
			} catch {
				return void 0;
			}
		}

		/**
		 * Destinations a guest popup may open. The chat site and the Platform
		 * login pages are the only hosts this panel deliberately navigates to;
		 * an arbitrary URL from the open-request bridge is never loaded.
		 * @param value - candidate URL.
		 * @returns the normalized URL, or undefined.
		 */
		function parsePopupUrl(value) {
			if (typeof value !== "string" || value.length === 0 || value.length > 4096) return void 0;
			try {
				const url = new URL(value);
				if (url.protocol !== "https:") return void 0;
				if (url.username !== "" || url.password !== "" || url.port !== "") return void 0;
				if (url.hostname !== "chat.deepseek.com" && url.hostname !== "platform.deepseek.com") return void 0;
				return url.toString();
			} catch {
				return void 0;
			}
		}

		/**
		 * Whether a URL deep enough to be a conversation page.
		 * @param url - parsed chat URL, possibly undefined.
		 * @returns true for a conversation, false for the new-chat root or an auth page.
		 */
		function isConversation(url) {
			if (url === void 0) return false;
			const path = url.pathname.replace(/\/+$/u, "") || "/";
			return !NON_CONVERSATION_PATHS.has(path);
		}

		/**
		 * Read the conversation remembered from the last visit.
		 * @param storageKey - storage key.
		 * @returns the URL to open; the site root when nothing usable is remembered.
		 */
		function rememberedTarget(storageKey) {
			try {
				const saved = parseChatUrl(window.localStorage.getItem(storageKey));
				return isConversation(saved) ? saved.toString() : CHAT_URL;
			} catch {
				return CHAT_URL;
			}
		}

		/**
		 * Remember where the guest currently is.
		 *
		 * A brand-new chat clears the memory so the next visit starts clean. An auth
		 * page never overwrites it, so a login detour does not lose the conversation.
		 * @param raw - current page URL reported by the guest.
		 * @param storageKey - storage key.
		 */
		function rememberTarget(raw, storageKey) {
			const url = parseChatUrl(raw);
			if (url === void 0) return;
			try {
				const path = url.pathname.replace(/\/+$/u, "") || "/";
				if (isConversation(url)) window.localStorage.setItem(storageKey, url.toString());
				else if (path === "/") window.localStorage.removeItem(storageKey);
			} catch {
				/* storage unavailable: the panel still works, it just forgets */
			}
		}

		// ── guest helpers ─────────────────────────────────────────────────────
		/**
		 * Whether the guest element is still in the document. Electron's webview
		 * methods throw once it is detached, so this gates every guest call.
		 * @param element - webview element.
		 * @returns true while the element can still host a guest.
		 */
		function attached(element) {
			try {
				return element.isConnected === true;
			} catch {
				return false;
			}
		}

		/** Guest URL, or undefined when the element cannot report one. */
		function readUrl(element) {
			if (!attached(element)) return void 0;
			try {
				const url = element.getURL();
				return typeof url === "string" && url.length > 0 ? url : void 0;
			} catch {
				return void 0;
			}
		}

		/**
		 * Navigate the guest without ever throwing.
		 * @returns false when the guest is gone, so the caller can report it.
		 */
		function navigate(element, url) {
			if (!attached(element)) return false;
			try {
				const pending = element.loadURL(url);
				if (pending !== void 0 && pending !== null && typeof pending.catch === "function") pending.catch(() => {});
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * Panel-list glyph, drawn on currentColor so the sidebar's active state owns
		 * the ink. Matches the sidebar's 16/18px icon seat.
		 */
		function ChatGlyph({ size = 18 }) {
			return react.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true",
				focusable: "false"
			}, react.createElement("path", {
				d: "M4.5 5.75C4.5 4.784 5.284 4 6.25 4h11.5c.966 0 1.75.784 1.75 1.75v8.5c0 .966-.784 1.75-1.75 1.75H9.56l-3.34 2.784c-.497.414-1.22.06-1.22-.586V5.75Z",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinejoin: "round"
			}), react.createElement("path", {
				d: "M8.5 9.25h7M8.5 12.25h4.5",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round"
			}));
		}

		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				flex: "1 1 auto",
				height: "100%",
				minHeight: "0",
				background: "var(--dsw-alias-bg-base)",
				color: "var(--dsw-alias-label-primary)"
			},
			host: {
				position: "relative",
				flex: "1",
				minHeight: "0",
				display: "flex"
			},
			guest: {
				width: "100%",
				height: "100%",
				border: "0",
				background: "transparent",
				display: "flex"
			},
			notice: {
				position: "absolute",
				inset: "0",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: "10px",
				padding: "24px",
				textAlign: "center",
				color: "var(--dsw-alias-label-tertiary)",
				font: "var(--dsw-font-xxs-12)",
				background: "var(--dsw-alias-bg-base)"
			},
			button: {
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-1)",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "4px 12px",
				cursor: "pointer",
				font: "var(--dsw-font-xxs-12)"
			},
			/**
			 * Tab entry wrapper. The conversation renderer's `viewArea` is a
			 * sibling of the sticky composerSeat; in the active phase it becomes
			 * `flex:1 0 auto` so `height:100%` on the panel has no definite
			 * parent height and the Session's own messages/composer stay visible
			 * below. An absolutely positioned overlay whose containing block is
			 * the conversation body (position:relative) covers exactly that body,
			 * hides the composer with an opaque background and a z-index above
			 * its 9, and leaves the header/tab row above the body clickable.
			 */
			overlay: {
				position: "absolute",
				inset: "0",
				zIndex: "50",
				display: "flex",
				flexDirection: "column",
				minHeight: "0",
				overflow: "hidden",
				background: "var(--dsw-alias-bg-base)"
			},
			// 三组卡片用「细边框 + 圆角 + 浅一档底色」把设置项分组；颜色全部取自
			// DSH 主题别名令牌，明暗主题自动适配，不写死任何颜色。
			settingsCard: {
				boxSizing: "border-box",
				margin: "0 0 14px",
				// 上留白 12px：分组标题不再紧贴卡片上边框；左右 18px 让标签列与值列
				// 都有稳定起点，两栏对齐更整齐。
				padding: "12px 18px 14px",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				background: "var(--dsw-alias-bg-layer-1)"
			},
			settingsRowLast: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "14px 0"
			},
			settingsPage: {
				boxSizing: "border-box",
				maxWidth: "620px",
				padding: "20px 24px",
				color: "var(--dsw-alias-label-primary)"
			},
			settingsTitle: {
				margin: "0 0 12px",
				fontSize: "16px",
				fontWeight: 600
			},
			settingsRow: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "14px 0",
				borderBottom: ".5px solid var(--dsw-alias-border-l3)"
			},
			settingsLabelRow: {
				display: "flex",
				alignItems: "center",
				gap: "10px",
				fontSize: "13px"
			},
			settingsCheckbox: {
				width: "16px",
				height: "16px",
				margin: "0",
				cursor: "pointer"
			},
			settingsHint: {
				margin: "0",
				fontSize: "12px",
				lineHeight: "1.6",
				color: "var(--dsw-alias-label-tertiary)"
			},
			settingsInput: {
				boxSizing: "border-box",
				width: "100%",
				marginTop: "2px",
				padding: "6px 10px",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				background: "var(--dsw-alias-bg-base)",
				color: "var(--dsw-alias-label-primary)",
				font: "var(--dsw-font-xxs-12)"
			},
			aboutSectionTitle: {
				margin: "18px 0 10px",
				fontSize: "13px",
				fontWeight: 600
			},
			// 严格两栏网格：标签列固定 88px、值列自适应；baseline 让标签与值的
			// 首行基线对齐，多行值也不会把标签挤歪。每行等距 padding，行距均匀。
			aboutRow: {
				display: "grid",
				gridTemplateColumns: "88px minmax(0, 1fr)",
				columnGap: "10px",
				alignItems: "baseline",
				padding: "5px 0",
				fontSize: "12px",
				lineHeight: "1.6"
			},
			aboutLabel: {
				whiteSpace: "nowrap",
				color: "var(--dsw-alias-label-tertiary)"
			},
			aboutValue: {
				minWidth: "0",
				wordBreak: "break-word"
			},
			aboutLink: {
				color: "var(--dsw-alias-label-link, var(--dsw-alias-label-primary))",
				textDecoration: "underline",
				cursor: "pointer",
				marginRight: "14px"
			},
			updateButton: {
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "6px 14px",
				cursor: "pointer",
				font: "var(--dsw-font-xxs-12)"
			},
			updateResult: {
				margin: "10px 0 0",
				padding: "10px 12px",
				borderRadius: "var(--dsw-radius-sm)",
				background: "var(--dsw-alias-bg-base)",
				fontSize: "12px",
				lineHeight: "1.7",
				color: "var(--dsw-alias-label-primary)"
			},
			// v1.2.0 自动闭环状态条：细横条放在 webview 上方，默认关闭时组件返回 null，
			// 不占据任何高度。颜色全部取主题别名令牌，明暗主题自动适配。
			syncBar: {
				boxSizing: "border-box",
				display: "flex",
				alignItems: "center",
				flexWrap: "wrap",
				gap: "8px",
				padding: "6px 12px",
				borderBottom: ".5px solid var(--dsw-alias-border-l3)",
				background: "var(--dsw-alias-bg-layer-1)",
				font: "var(--dsw-font-xxs-12)",
				color: "var(--dsw-alias-label-secondary)"
			},
			syncDot: {
				flex: "0 0 auto",
				width: "7px",
				height: "7px",
				borderRadius: "50%",
				background: "var(--dsw-alias-label-link, var(--dsw-alias-label-primary))"
			},
			syncLabel: {
				flex: "1 1 auto",
				minWidth: "0"
			},
			syncCount: {
				flex: "0 0 auto",
				color: "var(--dsw-alias-label-tertiary)"
			},
			syncButton: {
				flex: "0 0 auto",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "2px 8px",
				cursor: "pointer",
				font: "var(--dsw-font-xxs-12)"
			},
			syncGearButton: {
				flex: "0 0 auto",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				marginLeft: "4px",
				width: "24px",
				height: "24px",
				color: "var(--dsw-alias-label-secondary)",
				background: "transparent",
				border: "none",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "0",
				cursor: "pointer"
			},
			syncBringBack: {
				flex: "1 1 100%",
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "2px 0 4px"
			},
			syncBringBackInput: {
				width: "100%",
				boxSizing: "border-box",
				minHeight: "48px",
				resize: "vertical",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "6px 8px",
				font: "var(--dsw-font-xxs-12)"
			},
			syncBringBackRow: {
				display: "flex",
				alignItems: "center",
				gap: "8px"
			},
			syncBringBackMsg: {
				flex: "1 1 auto",
				minWidth: 0,
				color: "var(--dsw-alias-label-secondary)",
				font: "var(--dsw-font-xxs-12)"
			},
			// v1.4.0 全自动：启停按钮 + 决策卡
			syncPilotStart: {
				flex: "0 0 auto",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "2px 8px",
				cursor: "pointer",
				font: "var(--dsw-font-xxs-12)"
			},
			syncPilotStop: {
				flex: "0 0 auto",
				color: "var(--dsw-alias-status-negative, #e5484d)",
				background: "var(--dsw-alias-bg-layer-2)",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "2px 8px",
				cursor: "pointer",
				font: "var(--dsw-font-xxs-12)"
			},
			syncPilotCard: {
				flex: "1 1 100%",
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "8px",
				marginTop: "4px",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				background: "var(--dsw-alias-bg-layer-2)"
			},
			syncPilotCardTitle: {
				font: "var(--dsw-font-xs-13)",
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 600
			},
			syncPilotCardReason: {
				font: "var(--dsw-font-xxs-12)",
				color: "var(--dsw-alias-label-secondary)"
			},
			syncPilotCardBody: {
				width: "100%",
				boxSizing: "border-box",
				minHeight: "56px",
				resize: "vertical",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-layer-1)",
				border: ".5px solid var(--dsw-alias-border-l3)",
				borderRadius: "var(--dsw-radius-sm)",
				padding: "6px 8px",
				font: "var(--dsw-font-xxs-12)"
			},
			syncPilotCardRow: {
				display: "flex",
				flexWrap: "wrap",
				gap: "6px"
			}
		};

		/**
		 * Keeps a rendering failure inside this panel. DSH has no boundary of its own
		 * around slot entries: an escaping error unmounts the root slot, which is the
		 * whole application UI.
		 */
		class PanelBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failure: void 0 };
			}

			static getDerivedStateFromError(error) {
				return { failure: String((error && error.message) || error) };
			}

			componentDidCatch(error) {
				try {
					console.error("dsh-plugin-deepseek-chat: panel render failed", error);
				} catch {
					/* console unavailable */
				}
			}

			render() {
				if (this.state.failure !== void 0) {
					return react.createElement("div", { style: styles.root },
						react.createElement("div", { style: styles.notice },
							react.createElement("div", null, `${COPY.failed}: ${this.state.failure}`)));
				}
				return this.props.children ?? null;
			}
		}

		/**
		 * The web chat panel: a guest webview filling the available column, with
		 * no account strip above it.
		 *
		 * The guest is created only after the lease resolves, and it is mounted with
		 * `name`/`partition`/`src` already set, because the main process inspects
		 * exactly that bootstrap src when it approves the attachment. The identity
		 * and the conversation memory are both absolute constants, so switching
		 * between the sidebar panel and the conversation tab preserves the login.
		 */
		function ChatPanel() {
			const hostRef = react.useRef(null);
			const lastUrlRef = react.useRef(void 0);
			const [failure, setFailure] = react.useState(void 0);
			const [loading, setLoading] = react.useState(true);
			const [attempt, setAttempt] = react.useState(0);

			const retry = react.useCallback(() => {
				try {
					setFailure(void 0);
					setLoading(true);
					setAttempt((value) => value + 1);
				} catch {
					/* the panel is gone */
				}
			}, []);

			react.useEffect(() => {
				const host = hostRef.current;
				const bridge = globalThis.dshDesktop?.browser;
				if (host === null) return;
				if (bridge === void 0) {
					try {
						setFailure(COPY.unsupported);
						setLoading(false);
					} catch {
						/* the panel is gone */
					}
					return;
				}

				// Both identities are constants. The desktop shell caches one
				// session per workspace string; keeping them fixed is what makes
				// switching panels/sessions preserve the chat login.
				const storageKey = storageKeyFor();
				const partitionKey = partitionKeyFor();
				let disposed = false;
				let failed = false;
				let unsubscribeOpen;
				let lease;
				let watchdog;
				const element = document.createElement("webview");
				// v1.2.0: expose the guest's executeJavaScript channel to the module-level
				// auto-sync controller. Guard the singleton (Web surface never builds one).
				// ownsBridge lets cleanup clear only the bridge this webview installed.
				let ownsBridge = false;
				let myBridge;
				if (syncRuntime) {
					try {
						myBridge = makeWebviewBridge(element);
						syncRuntime.bridge = myBridge;
						ownsBridge = true;
					} catch {
						/* a broken guest channel must never stop the panel */
					}
				}
				const initialTarget = rememberedTarget(storageKey);
				let restoring = initialTarget !== CHAT_URL;

				Object.assign(element.style, styles.guest);
				element.setAttribute("allowpopups", "");

				/**
				 * Report a guest failure inside the panel; never throw. The dead
				 * guest element is removed immediately so a Retry cannot stack a
				 * second webview, and later events are suppressed. The lease is
				 * still released by the effect cleanup, exactly once.
				 */
				const fail = (error) => {
					if (disposed || failed) return;
					failed = true;
					try {
						element.remove();
					} catch {
						/* already detached */
					}
					if (watchdog !== void 0) {
						clearTimeout(watchdog);
						watchdog = void 0;
					}
					try {
						setLoading(false);
						setFailure(String((error && error.message) || error));
					} catch {
						/* the panel is gone */
					}
				};

				/** Remember the last document the guest reported. */
				const remember = (raw) => {
					if (raw === void 0) return;
					lastUrlRef.current = raw;
					rememberTarget(raw, storageKey);
				};

				const onDomReady = () => {
					if (disposed || failed) return;
					if (watchdog !== void 0) {
						clearTimeout(watchdog);
						watchdog = void 0;
					}
					if (!navigate(element, initialTarget)) fail(new Error(COPY.crashed));
					else remember(initialTarget);
				};
				const onStopLoading = () => {
					if (disposed || failed) return;
					const raw = readUrl(element);
					if (raw === void 0) return;
					remember(raw);
					restoring = false;
					try {
						setLoading(false);
					} catch {
						/* the panel is gone */
					}
				};
				const onNavigate = () => {
					if (disposed || failed) return;
					remember(readUrl(element));
				};
				const onNavigateInPage = (event) => {
					if (disposed || failed || event?.isMainFrame !== true) return;
					onNavigate();
				};
				const onFailLoad = (event) => {
					if (disposed || failed || event?.isMainFrame !== true) return;
					// -3 is ERR_ABORTED: a superseded navigation, not a failure.
					if (event.errorCode === -3) return;
					if (restoring) {
						// The remembered conversation is gone or unreachable; start clean.
						restoring = false;
						if (!navigate(element, CHAT_URL)) fail(new Error(COPY.crashed));
						else remember(CHAT_URL);
						return;
					}
					fail(`${event.errorDescription ?? event.errorCode}`);
				};
				/** The guest process exited or the guest was torn down underneath us. */
				const onGuestGone = () => {
					if (disposed || failed) return;
					fail(new Error(COPY.crashed));
				};

				const listeners = [
					["dom-ready", onDomReady],
					["did-stop-loading", onStopLoading],
					["did-navigate", onNavigate],
					["did-navigate-in-page", onNavigateInPage],
					["did-fail-load", onFailLoad],
					["render-process-gone", onGuestGone],
					["destroyed", onGuestGone]
				];

				// A listener that cannot be attached leaves a guest nobody can
				// drive; abort the start instead of mounting a silent webview.
				let listenersReady = false;
				try {
					for (const [name, handler] of listeners) {
						element.addEventListener(name, handler, name === "dom-ready" ? { once: true } : void 0);
					}
					listenersReady = true;
				} catch (error) {
					fail(error);
				}

				const start = async () => {
					try {
						const reservation = await bridge.acquire(partitionKey);
						if (disposed || failed) {
							try {
								Promise.resolve(bridge.release(reservation.lease)).catch(() => {});
							} catch {
								/* lease already gone */
							}
							return;
						}
						lease = reservation.lease;
						element.setAttribute("name", reservation.lease);
						element.setAttribute("partition", reservation.partition);
						element.setAttribute("src", `about:blank#${reservation.lease}`);
						try {
							unsubscribeOpen = bridge.onOpenRequested(reservation.lease, (raw) => {
								if (disposed || failed || typeof raw !== "string") return;
								const target = parsePopupUrl(raw);
								if (target !== void 0) navigate(element, target);
							});
						} catch {
							/* popup bridge unavailable: the guest still works */
						}
						host.append(element);
						watchdog = setTimeout(() => {
							watchdog = void 0;
							if (disposed || failed) return;
							if (readUrl(element) === void 0) fail(new Error(COPY.timeout));
						}, 15000);
					} catch (error) {
						fail(error);
					}
				};
				if (listenersReady) void start();

				return () => {
					disposed = true;
					// Drop the guest channel only if it is still ours: switching panels
					// can mount a new webview before the old effect's cleanup runs.
					if (ownsBridge && syncRuntime && syncRuntime.bridge === myBridge) {
						syncRuntime.bridge = null;
					}
					// Read before removal: React cleans up after taking the DOM away, and
					// Electron's getURL() throws on a detached webview.
					remember(readUrl(element) ?? lastUrlRef.current);
					if (watchdog !== void 0) {
						clearTimeout(watchdog);
						watchdog = void 0;
					}
					try {
						if (typeof unsubscribeOpen === "function") unsubscribeOpen();
					} catch {
						/* already detached */
					}
					for (const [name, handler] of listeners) {
						try {
							element.removeEventListener(name, handler);
						} catch {
							/* already detached */
						}
					}
					try {
						element.remove();
					} catch {
						/* already detached */
					}
					const released = lease;
					lease = void 0;
					if (released !== void 0) {
						try {
							Promise.resolve(bridge.release(released)).catch(() => {});
						} catch {
							/* lease already gone */
						}
					}
				};
			}, [attempt]);

			return react.createElement("div", { style: styles.root },
				react.createElement(SyncStatusBar),
				react.createElement("div", { style: styles.host, ref: hostRef },
					failure === void 0 && loading
						? react.createElement("div", { style: styles.notice }, COPY.loading)
						: null,
					failure === void 0
						? null
						: react.createElement("div", { style: styles.notice },
							react.createElement("div", null, `${COPY.failed}: ${failure}`),
							react.createElement("button", { type: "button", style: styles.button, onClick: retry }, COPY.retry))));
		}

		/** The registered panel: the boundary owns every rendering failure below it. */
		function ChatPanelShell() {
			return react.createElement(PanelBoundary, null, react.createElement(ChatPanel));
		}

		/**
		 * The conversation top-bar tab. Unlike the left-sidebar panel, this entry
		 * must fill the whole conversation body and cover the Session's own
		 * messages/composer (the "页面没有铺满下面" bug): an opaque, absolutely
		 * positioned overlay on the conversation body's containing block.
		 * The component is created ONCE (not per render) so React never remounts
		 * the guest webview on an unrelated re-render.
		 */
		function ViewTabShell() {
			return react.createElement("div", {
				"data-dsh-plugin-deepseek-chat": "view",
				style: styles.overlay
			}, react.createElement(PanelBoundary, null, react.createElement(ChatPanel)));
		}

		/**
		 * The right-sidebar card body. better-sidebar wraps native tab bodies in a
		 * `height:100%` column-flex host, so ChatPanelShell (root flex column,
		 * height 100%) fills it just like the left-sidebar panel. The component is
		 * created ONCE and reused; it ignores TabComponentProps (the web chat is
		 * session-independent).
		 */
		function CardView() {
			return react.createElement(ChatPanelShell);
		}

		/** Native icon for the + menu / tab chip; drawn on currentColor. */
		function CardGlyph(size) {
			return react.createElement(ChatGlyph, { size });
		}

		/**
		 * Build the TabDescriptor for better-sidebar. `title` is a thunk so the
		 * guide and tab chip re-read the current name on every render (renaming in
		 * Settings is immediate, no re-registration needed). `single` + a constant
		 * dedupeKey keep the card to one instance.
		 */
		function cardDescriptor() {
			return {
				id: CARD_ID,
				title: () => cardLabel(),
				description: COPY.label,
				icon: CardGlyph,
				order: CARD_ORDER,
				single: true,
				dedupeKey: () => CARD_ID,
				component: CardView
			};
		}

		/** Icon component for the native right-sidebar guide entry. */
		function CardGuideIcon(props) {
			return react.createElement(ChatGlyph, { size: props?.size ?? 18 });
		}

		/**
		 * Tab type for DSH's OWN native right-sidebar, used when better-sidebar is
		 * not running. id/kind are package-prefixed (unique across registered
		 * types); title is a thunk so a newly opened tab picks up the current name.
		 * The guide entry is the box in the "+ 添加 Tab 插件" / guide page. The body
		 * comes from a `sidebar.right.pane.tab` registration in apply(); no title
		 * slot is needed - the chip falls back to definition.title().
		 */
		function nativeCardDefinition() {
			return {
				id: CARD_ID,
				kind: CARD_ID,
				priority: "extension",
				keepMounted: true,
				title: () => cardLabel(),
				guide: [{
					id: CARD_ID + ":open",
					order: CARD_ORDER,
					title: () => cardLabel(),
					description: () => COPY.label,
					icon: CardGuideIcon
				}]
			};
		}
		/** One metadata row: a fixed-width label plus a value. */
		function infoRow(label, value) {
			return react.createElement("div", {
				"data-dsh-plugin-deepseek-chat": "info-row",
				style: styles.aboutRow
			},
				react.createElement("span", { style: styles.aboutLabel }, label),
				react.createElement("span", { style: styles.aboutValue }, value));
		}

		/** External https link; the desktop shell opens it in the system browser. */
		function externalLink(href, text) {
			return react.createElement("a", {
				href,
				target: "_blank",
				rel: "noopener noreferrer",
				style: styles.aboutLink
			}, text);
		}

		/** The two jump links shown in the About block and after an update check. */
		function linkRow() {
			// 与 infoRow 共用同一两栏网格 + 标记：整列（含「相关链接」）严格对齐。
			return react.createElement("div", {
				"data-dsh-plugin-deepseek-chat": "info-row",
				style: styles.aboutRow
			},
				react.createElement("span", { style: styles.aboutLabel }, COPY.infoLinks),
				react.createElement("span", { style: styles.aboutValue },
					externalLink(NPM_PAGE_URL, COPY.linkNpm),
					externalLink(GITHUB_PAGE_URL, COPY.linkGithub)));
		}

		/** Human-readable one-line status for the current update-check state. */
		function updateStatusLine(state) {
			if (state.status === "idle") return COPY.updateIdle;
			if (state.status === "checking") return COPY.updateChecking;
			if (state.status === "updating") return COPY.updateUpdating;
			if (state.status === "updated") return COPY.updateDone;
			let line;
			if (state.status === "found") {
				line = `${COPY.updateFound} ${state.latest}（${COPY.updateCurrent} ${PLUGIN_VERSION}）`;
			} else if (state.status === "up-to-date") {
				line = `${COPY.updateUpToDate}（${COPY.updateLatest} ${state.latest}）`;
			} else if (state.status === "restart-required") {
				line = COPY.updateRestart;
			} else if (state.status === "update-failed") {
				line = `${COPY.updateInstallFailed}：${state.reason ?? ""}`;
			} else {
				line = `${COPY.updateFailed}：${state.reason ?? ""}`;
			}
			if (state.source !== void 0) line += ` · ${COPY.updateSource} ${state.source}`;
			if (state.status === "restart-required" || state.status === "update-failed") line += ` · ${COPY.updateFallback}`;
			return line;
		}

		/**
		 * Settings page. Built once and reused: writing a checkbox or typing in the
		 * text box calls writeConfig(), which persists and notifies apply()'s
		 * subscriber; the local counter only refreshes this form's own state. The
		 * About block and the "检查更新" button are also part of this one component.
		 */
		function makeSettingsView(ctx) {
			return function SettingsView() {
				const state = react.useState(0);
				const rerender = () => state[1]((value) => value + 1);
				const current = getConfig();
				const update = getUpdateState();
				// Both names show their default as a grey placeholder, never as a
				// solid value the user must delete first. Each `draft` is
				// component-local: it stays empty while the config holds the
				// default and follows what the user types. Clearing it makes
				// writeConfig() fall back to the default again, so the box returns to
				// its empty placeholder state (real React keeps this component mounted).
				const tabDraftState = react.useState(current.tabLabel === DEFAULT_TAB_LABEL ? "" : current.tabLabel);
				const tabDraft = tabDraftState[0];
				const setTabDraft = tabDraftState[1];
				const cardDraftState = react.useState(current.cardLabel === DEFAULT_CARD_LABEL ? "" : current.cardLabel);
				const cardDraft = cardDraftState[0];
				const setCardDraft = cardDraftState[1];

				const onToggle = (event) => {
					writeConfig({ showTab: !!event?.target?.checked });
					rerender();
				};
				const onLabelChange = (event) => {
					const value = String(event?.target?.value ?? "");
					// Whitespace-only input resolves back to the default name, so keep
					// the box empty to let the grey placeholder show even without a
					// remount.
					setTabDraft(value.trim().length === 0 ? "" : value);
					writeConfig({ tabLabel: value });
					rerender();
				};
				const onToggleCard = (event) => {
					writeConfig({ showCard: !!event?.target?.checked });
					rerender();
				};
				const onCardLabelChange = (event) => {
					const value = String(event?.target?.value ?? "");
					setCardDraft(value.trim().length === 0 ? "" : value);
					writeConfig({ cardLabel: value });
					rerender();
				};
				const onCheckUpdate = () => {
					void checkForUpdates(rerender);
				};
				const onUpdateNow = () => {
					void runUpdate(ctx, update.latest, rerender);
				};

				const parseSelectorList = (raw, separator) => String(raw ?? "")
					.split(separator)
					.map((item) => item.trim())
					.filter((item) => item.length > 0);
				const onToggleSync = (event) => {
					writeConfig({ autoSyncEnabled: !!event?.target?.checked });
					rerender();
				};
				const onToggleHalfAuto = (event) => {
					writeConfig({ halfAutoEnabled: !!event?.target?.checked });
					rerender();
				};
				const onMaxLoopsChange = (event) => {
					const value = Number(event?.target?.value);
					writeConfig({ maxAutoLoops: Number.isFinite(value) ? value : DEFAULT_MAX_LOOPS });
					rerender();
				};
				const onErrorKeywordsChange = (event) => {
					writeConfig({ errorKeywords: parseSelectorList(event?.target?.value, /[,，\n]/) });
					rerender();
				};
				const onStopSelectorsChange = (event) => {
					writeConfig({ stopButtonSelectors: parseSelectorList(event?.target?.value, /\n/) });
					rerender();
				};
				const onSendSelectorsChange = (event) => {
					writeConfig({ sendButtonSelectors: parseSelectorList(event?.target?.value, /\n/) });
					rerender();
				};
				const onTextareaSelectorsChange = (event) => {
					writeConfig({ textareaSelectors: parseSelectorList(event?.target?.value, /\n/) });
					rerender();
				};
				const onAssistantSelectorsChange = (event) => {
					writeConfig({ assistantSelectors: parseSelectorList(event?.target?.value, /\n/) });
					rerender();
				};
				const onUserSelectorsChange = (event) => {
					writeConfig({ userMessageSelectors: parseSelectorList(event?.target?.value, /\n/) });
					rerender();
				};
				// v1.4.0 全自动投递通道设置项。
				const onToggleAutoPilot = (event) => {
					writeConfig({ autoPilotEnabled: !!event?.target?.checked });
					rerender();
				};
				const onTogglePilotAutoSubmit = (event) => {
					writeConfig({ pilotAutoSubmit: !!event?.target?.checked });
					rerender();
				};
				const onPilotMarkerChange = (key) => (event) => {
					const value = String(event?.target?.value ?? "").slice(0, 120);
					writeConfig({ [key]: value });
					rerender();
				};
				const onPilotContractChange = (event) => {
					writeConfig({ pilotOutputContract: String(event?.target?.value ?? "").slice(0, 2000) });
					rerender();
				};
				const onPilotKeywordsChange = (key) => (event) => {
					writeConfig({ [key]: parseSelectorList(event?.target?.value, /[,，\n]/) });
					rerender();
				};

				const showLinks = update.status === "found" || update.status === "up-to-date" || update.status === "failed" || update.status === "updating" || update.status === "updated" || update.status === "restart-required" || update.status === "update-failed";

				return react.createElement("div", { style: styles.settingsPage },
					react.createElement("h2", { style: styles.settingsTitle }, COPY.settingsTitle),

					// 第一组卡片：顶部标签栏（开关 + 名称）。
					react.createElement("div", { "data-dsh-plugin-deepseek-chat": "settings-card", style: styles.settingsCard },
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow },
								react.createElement("input", {
									type: "checkbox",
									style: styles.settingsCheckbox,
									"data-dsh-plugin-deepseek-chat": "show-tab",
									checked: current.showTab !== false,
									onChange: onToggle
								}),
								COPY.settingsEnableTab),
							react.createElement("p", { style: styles.settingsHint }, COPY.settingsEnableHint)),
						react.createElement("div", { style: styles.settingsRowLast },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.settingsTabLabel),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "tab-label",
								style: styles.settingsInput,
								value: tabDraft,
								placeholder: COPY.settingsPlaceholder,
								maxLength: 40,
								onChange: onLabelChange
							}),
							react.createElement("p", { style: styles.settingsHint }, COPY.settingsTabLabelHint))),

					// 第二组卡片：右边栏卡片（开关 + 名称）。
					react.createElement("div", { "data-dsh-plugin-deepseek-chat": "settings-card", style: styles.settingsCard },
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow },
								react.createElement("input", {
									type: "checkbox",
									"data-dsh-plugin-deepseek-chat": "show-card",
									style: styles.settingsCheckbox,
									checked: current.showCard !== false,
									onChange: onToggleCard
								}),
								COPY.settingsEnableCard),
							react.createElement("p", { style: styles.settingsHint }, COPY.settingsEnableCardHint)),
						react.createElement("div", { style: styles.settingsRowLast },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.settingsCardLabel),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "card-label",
								style: styles.settingsInput,
								value: cardDraft,
								placeholder: COPY.settingsPlaceholder,
								maxLength: 40,
								onChange: onCardLabelChange
							}),
							react.createElement("p", { style: styles.settingsHint }, COPY.settingsCardLabelHint))),

					// 第三组卡片：v1.2.0 条件触发式自动闭环（默认关闭）。
					react.createElement("div", { "data-dsh-plugin-deepseek-chat": "settings-card", style: styles.settingsCard },
						react.createElement("h3", { style: { ...styles.aboutSectionTitle, margin: "2px 0 10px" } }, COPY.syncTitle),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow },
								react.createElement("input", {
									type: "checkbox",
									"data-dsh-plugin-deepseek-chat": "sync-enable",
									style: styles.settingsCheckbox,
									checked: current.autoSyncEnabled === true,
									onChange: onToggleSync
								}),
								COPY.syncEnable),
							react.createElement("p", { style: styles.settingsHint }, COPY.syncEnableHint)),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow },
								react.createElement("input", {
									type: "checkbox",
									"data-dsh-plugin-deepseek-chat": "sync-half-auto",
									style: styles.settingsCheckbox,
									checked: current.halfAutoEnabled === true,
									onChange: onToggleHalfAuto
								}),
								COPY.syncHalfAutoEnable),
							react.createElement("p", { style: styles.settingsHint }, COPY.syncHalfAutoHint)),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.syncMaxLoops),
							react.createElement("input", {
								type: "number",
								min: 1,
								max: 20,
								"data-dsh-plugin-deepseek-chat": "sync-max-loops",
								style: styles.settingsInput,
								value: normalizeMaxLoops(current.maxAutoLoops),
								onChange: onMaxLoopsChange
							}),
							react.createElement("p", { style: styles.settingsHint }, COPY.syncMaxLoopsHint)),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.syncErrorKeywords),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "sync-error-keywords",
								style: styles.settingsInput,
								value: (current.errorKeywords || []).join(", "),
								onChange: onErrorKeywordsChange
							}),
							react.createElement("p", { style: styles.settingsHint }, COPY.syncErrorKeywordsHint)),
						react.createElement("div", { style: styles.settingsRowLast },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.syncStopSelectors),
							react.createElement("textarea", {
								"data-dsh-plugin-deepseek-chat": "sync-stop-selectors",
								style: styles.settingsInput,
								rows: 4,
								value: (current.stopButtonSelectors || []).join("\n"),
								onChange: onStopSelectorsChange
							}),
							react.createElement("p", { style: styles.settingsHint }, COPY.syncStopSelectorsHint)),
						react.createElement("div", { style: styles.settingsRowLast },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.syncSendSelectors),
							react.createElement("textarea", {
								"data-dsh-plugin-deepseek-chat": "sync-send-selectors",
								style: styles.settingsInput,
								rows: 3,
								value: (current.sendButtonSelectors || []).join("\n"),
								onChange: onSendSelectorsChange
							})),
						react.createElement("div", { style: styles.settingsRowLast },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.syncTextareaSelectors),
							react.createElement("textarea", {
								"data-dsh-plugin-deepseek-chat": "sync-textarea-selectors",
								style: styles.settingsInput,
								rows: 3,
								value: (current.textareaSelectors || []).join("\n"),
								onChange: onTextareaSelectorsChange
							})),
						react.createElement("div", { style: styles.settingsRowLast },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.syncAssistantSelectors),
							react.createElement("textarea", {
								"data-dsh-plugin-deepseek-chat": "sync-assistant-selectors",
								style: styles.settingsInput,
								rows: 3,
								value: (current.assistantSelectors || []).join("\n"),
								onChange: onAssistantSelectorsChange
							})),
						react.createElement("div", { style: styles.settingsRowLast },
								react.createElement("label", { style: styles.settingsLabelRow }, COPY.syncUserSelectors),
								react.createElement("textarea", {
									"data-dsh-plugin-deepseek-chat": "sync-user-message-selectors",
									style: styles.settingsInput,
									rows: 3,
									value: (current.userMessageSelectors || []).join("\n"),
									onChange: onUserSelectorsChange
								})),
							react.createElement("p", { style: styles.settingsHint }, COPY.syncSafetyNote)),

					// v1.4.0 全自动投递通道卡片（默认关闭，由用户启停）。
					react.createElement("div", { "data-dsh-plugin-deepseek-chat": "settings-card", style: styles.settingsCard },
						react.createElement("h3", { style: { ...styles.aboutSectionTitle, margin: "2px 0 10px" } }, COPY.pilotEnable),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow },
								react.createElement("input", {
									type: "checkbox",
									"data-dsh-plugin-deepseek-chat": "pilot-enable",
									style: styles.settingsCheckbox,
									checked: current.autoPilotEnabled === true,
									onChange: onToggleAutoPilot
								}),
								COPY.pilotEnable),
							react.createElement("p", { style: styles.settingsHint }, COPY.pilotEnableHint)),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow },
								react.createElement("input", {
									type: "checkbox",
									"data-dsh-plugin-deepseek-chat": "pilot-auto-submit",
									style: styles.settingsCheckbox,
									checked: current.pilotAutoSubmit !== false,
									onChange: onTogglePilotAutoSubmit
								}),
								COPY.pilotAutoSubmit),
							react.createElement("p", { style: styles.settingsHint }, COPY.pilotAutoSubmitHint)),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.pilotMarkers),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "pilot-marker-start",
								style: styles.settingsInput,
								value: current.pilotMarkerStart || "",
								placeholder: DEFAULT_PILOT_MARKER_START,
								maxLength: 120,
								onChange: onPilotMarkerChange("pilotMarkerStart")
							}),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "pilot-marker-end",
								style: styles.settingsInput,
								value: current.pilotMarkerEnd || "",
								placeholder: DEFAULT_PILOT_MARKER_END,
								maxLength: 120,
								onChange: onPilotMarkerChange("pilotMarkerEnd")
							})),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.pilotDoneKeywords),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "pilot-done-keywords",
								style: styles.settingsInput,
								value: (current.pilotDoneKeywords || []).join(", "),
								onChange: onPilotKeywordsChange("pilotDoneKeywords")
							})),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.pilotRestartKeywords),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "pilot-restart-keywords",
								style: styles.settingsInput,
								value: (current.pilotRestartKeywords || []).join(", "),
								onChange: onPilotKeywordsChange("pilotRestartKeywords")
							})),
						react.createElement("div", { style: styles.settingsRow },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.pilotHandoffKeywords),
							react.createElement("input", {
								type: "text",
								"data-dsh-plugin-deepseek-chat": "pilot-handoff-keywords",
								style: styles.settingsInput,
								value: (current.pilotHandoffKeywords || []).join(", "),
								onChange: onPilotKeywordsChange("pilotHandoffKeywords")
							})),
						react.createElement("div", { style: styles.settingsRowLast },
							react.createElement("label", { style: styles.settingsLabelRow }, COPY.pilotContract),
							react.createElement("textarea", {
								"data-dsh-plugin-deepseek-chat": "pilot-contract",
								style: styles.settingsInput,
								rows: 6,
								value: current.pilotOutputContract || "",
								placeholder: DEFAULT_PILOT_OUTPUT_CONTRACT,
								onChange: onPilotContractChange
							})),
						react.createElement("p", { style: styles.settingsHint }, COPY.pilotSafetyNote)),

					// 第四组卡片：关于本插件 + 检查更新。
					react.createElement("div", { "data-dsh-plugin-deepseek-chat": "settings-card", style: styles.settingsCard },
						// 关于本插件：版本号 / 作者 / 功能简介 / 许可证 / 相关链接。
						// 第一个分组标题：靠卡片上留白 + 2px 上边距下移，不再贴边框。
						react.createElement("h3", { style: { ...styles.aboutSectionTitle, margin: "2px 0 10px" } }, COPY.aboutTitle),
						infoRow(COPY.infoVersion, PLUGIN_VERSION),
						infoRow(COPY.infoAuthor, PLUGIN_AUTHOR),
						infoRow(COPY.infoDescription, COPY.infoSummary),
						infoRow(COPY.infoLicense, PLUGIN_LICENSE),
						linkRow(),

						// 检查更新：按钮 + 文字状态 + 跳转链接。
						react.createElement("h3", { style: styles.aboutSectionTitle }, COPY.updateTitle),
						react.createElement("button", {
							type: "button",
							"data-dsh-plugin-deepseek-chat": "check-update",
							style: styles.updateButton,
							disabled: update.status === "checking",
							onClick: onCheckUpdate
						}, COPY.checkUpdate),
						react.createElement("div", {
							"data-dsh-plugin-deepseek-chat": "update-status",
							style: styles.updateResult
						},
							react.createElement("div", null, updateStatusLine(update)),
							update.status === "found" ? react.createElement("button", {
								type: "button",
								"data-dsh-plugin-deepseek-chat": "update-now",
								style: styles.updateButton,
								onClick: onUpdateNow
							}, COPY.updateNow) : null,
							showLinks ? linkRow() : null)));

			};
		}

		/** Client service this plugin reads; the loader waits for the slot registry. */
		const inject = ["slots"];

		/**
		 * Register the contributions. On the Web surface there is no desktop guest
		 * bridge and an iframe cannot carry the site, so the plugin stays inert
		 * there. Each registration is isolated: one bad slot must not undo the
		 * others.
		 *
		 * Two entries are dynamic and driven by the Settings preferences:
		 *  - the conversation.view top-bar tab (label from tabLabel(), visibility
		 *    from showTab). The tab row only recomputes when the slot registry
		 *    changes, so on any preference change we dispose that single injection
		 *    and re-inject it (label thunk + showTab check).
		 *  - the better-sidebar right-sidebar card (label via a title thunk so
		 *    renaming is immediate; visibility from showCard, enforced by
		 *    disposing/re-registering the tab descriptor). better-sidebar is an
		 *    OPTIONAL soft dependency: ctx.get("betterSidebar") returns undefined
		 *    when it is not installed, and the rest of the plugin is unaffected.
		 *    The disposer is owned by the fiber (unregister on HMR / unload).
		 *
		 * The main/sidebar/settings entries are registered once.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			let bridge;
			try {
				bridge = globalThis.dshDesktop?.browser;
			} catch {
				return;
			}
			if (bridge === void 0 || bridge === null) return;

			// v1.2.0: the auto-sync controller is a module-level singleton shared by
			// every webview this plugin mounts. Built only on the desktop surface (the
			// Web surface returns above), reused on each apply so HMR keeps its state.
			const rt = ensureSyncRuntime(ctx);
			const register = (slot, options, component) => {
				try {
					return ctx.slots.inject(slot, () => ctx.slots.register(options, component));
				} catch (error) {
					try {
						console.error("dsh-plugin-deepseek-chat: " + slot + " registration failed", error);
					} catch {
						/* console unavailable */
					}
					return void 0;
				}
			};

			// Service readiness (v1.1.9). Decide the card path from what is ACTUALLY
			// running right now, not from a package list. Cordis notify() only wakes
			// fibers that DECLARE a service, and a bare ctx.get() soft probe registers
			// no dependent - so a one-shot probe returning undefined must be retried.
			// Three complementary triggers:
			//   1. ctx.on('internal/service', ..., {global:true}) - fires as soon as
			//      betterSidebar / sidebarRightTabs is provided (or a provider fiber
			//      becomes active and re-notifies), even on a slow cold start;
			//   2. an UNBOUNDED, cancellable 500ms browser-global timer (no hard cap,
			//      so the v1.1.8 "20s window expired" bug cannot recur);
			//   3. every sync() re-probes both services.
			// ctx.setTimeout / ctx.inject are unavailable to a dynamic plugin (guard
			// gates timers behind a declared 'timer' inject, and inject is not a
			// CTX_VERB), so only browser-global setTimeout is used.
			const getService = (name, method) => {
				try {
					if (typeof ctx.get !== "function") return void 0;
					const service = ctx.get(name);
					if (service === void 0 || service === null || typeof service[method] !== "function") return void 0;
					return service;
				} catch {
					return void 0;
				}
			};
			const getSidebarService = () => getService("betterSidebar", "registerTab");
			const getNativeRegistry = () => getService("sidebarRightTabs", "register");

			let cardRetryTimer = void 0;
			const cancelCardRetry = () => {
				if (cardRetryTimer === void 0) return;
				try { clearTimeout(cardRetryTimer); } catch { /* noop */ }
				cardRetryTimer = void 0;
			};
			const scheduleCardRetry = (retry) => {
				if (cardRetryTimer !== void 0) return;
				try {
					cardRetryTimer = setTimeout(() => {
						cardRetryTimer = void 0;
						retry();
					}, CARD_RETRY_DELAY);
				} catch {
					cardRetryTimer = void 0;
				}
			};
			const composeDisposers = (list) => () => {
				for (let i = list.length - 1; i >= 0; i -= 1) {
					const dispose = list[i];
					if (typeof dispose === "function") {
						try { dispose(); } catch { /* already gone */ }
					}
				}
			};
			const registerNativeCard = (registry) => {
				const disposers = [];
				try {
					disposers.push(registry.register(nativeCardDefinition()));
				} catch (error) {
					try {
						console.error("dsh-plugin-deepseek-chat: native right-sidebar tab type registration failed", error);
					} catch {
						/* console unavailable */
					}
					return void 0;
				}
				disposers.push(register("sidebar.right.pane.tab", {
					name: "sidebar.right.pane.tab",
					key: CARD_ID
				}, CardView));
				return composeDisposers(disposers);
			};

			// Static entries: left-sidebar panel + full main panel + Settings page.
			register("main", { name: "main", key: PANEL_ID }, ChatPanelShell);
			register("sidebar.panellist", {
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 5,
				label: () => COPY.label
			}, ChatGlyph);
			register("settings.section", {
				name: "settings.section",
				id: SETTINGS_ID,
				order: SETTINGS_ORDER,
				label: () => COPY.settingsNav
			}, makeSettingsView(ctx));

			// Dynamic entry: the conversation top-bar tab. Re-injected whenever
			// a preference changes so the tab row recomputes id/label/visibility.
			let disposeView = void 0;
			const syncView = () => {
				if (typeof disposeView === "function") {
					try {
						disposeView();
					} catch {
						/* already gone */
					}
				}
				disposeView = void 0;
				if (config.showTab === false) return;
				disposeView = register("conversation.view", {
					name: "conversation.view",
					id: VIEW_ID,
					order: VIEW_ORDER,
					label: () => tabLabel()
				}, ViewTabShell);
			};

			// Dynamic entry: the right-sidebar card. Two mutually exclusive paths:
			//   - betterSidebar service RUNNING  -> registerTab(cardDescriptor())
			//   - otherwise                      -> DSH native right-sidebar
			//     (sidebarRightTabs.register + sidebar.right.pane.tab body slot)
			// activeCardPath avoids needless dispose/re-register (a new webview
			// guest) when the decision has not changed.
			let disposeCard = void 0;
			let activeCardPath = "none";
			const clearCard = () => {
				if (typeof disposeCard === "function") {
					try { disposeCard(); } catch { /* already gone */ }
				}
				disposeCard = void 0;
				activeCardPath = "none";
			};
			const syncCard = () => {
				if (config.showCard === false) {
					cancelCardRetry();
					clearCard();
					return;
				}
				const better = getSidebarService();
				const native = better === void 0 ? getNativeRegistry() : void 0;
				const wanted = better !== void 0 ? "better" : (native !== void 0 ? "native" : "none");
				if (wanted === "none") {
					// Neither surface is up yet. Keep probing (no hard cap) and
					// drop any card from a surface that just went away.
					scheduleCardRetry(syncCard);
					clearCard();
					return;
				}
				if (wanted === activeCardPath) return;
				clearCard();
				cancelCardRetry();
				activeCardPath = wanted;
				if (wanted === "better") {
					try {
						disposeCard = better.registerTab(cardDescriptor());
					} catch (error) {
						try {
							console.error("dsh-plugin-deepseek-chat: right-sidebar card registration failed", error);
						} catch {
							/* console unavailable */
						}
						disposeCard = void 0;
						activeCardPath = "none";
					}
				} else {
					disposeCard = registerNativeCard(native);
					if (disposeCard === void 0) activeCardPath = "none";
				}
			};

			// One subscription drives both dynamic surfaces plus the readiness
			// retry. The effect owns the disposers, the service listener and the
			// timer so HMR/unload leaves nothing behind.
			const sync = () => {
				syncView();
				syncCard();
				// v1.2.0: the master switch also (de)registers the hidden composer dock
				// that captures InputActions + subscribes to turn/end. Disabled by
				// default, so no extra registration appears until the user opts in.
				syncAutoLoop(rt, register);
			};
			sync();

			const unsubscribe = subscribeConfig(sync);
			let disposeServiceListener = void 0;
			if (typeof ctx.on === "function") {
				try {
					disposeServiceListener = ctx.on("internal/service", (name) => {
						if (name === "betterSidebar" || name === "sidebarRightTabs") syncCard();
					}, { global: true });
				} catch {
					/* event subscription unavailable: the timer still probes */
				}
			}
			if (typeof ctx.effect === "function") {
				try {
					// ctx.effect(callback) runs the callback and keeps its RETURN value
					// as the fiber-owned disposer. Return a closure (do not run cleanup
					// now) so HMR / unload disposes the CURRENT registrations.
					ctx.effect(() => () => {
						unsubscribe();
						if (typeof disposeServiceListener === "function") disposeServiceListener();
						cancelCardRetry();
						if (typeof disposeView === "function") disposeView();
						clearCard();
						// v1.2.0: drop the hidden composer dock + cancel any in-flight
						// reply polling so the singleton is inert after unload.
						rt.cancelled = true;
						if (typeof rt.dockDispose === "function") {
							try { rt.dockDispose(); } catch { /* already gone */ }
						}
						rt.dockDispose = null;
						rt.dockBinding.current = null;
						rt.bridge = null;
						// v1.2.6: 卸载时停订会话事件 + 注销配对监听，避免悬挂订阅。
						if (rt.eventSubs && rt.eventSubs.stop) {
							try { rt.eventSubs.stop(); } catch { /* ignore */ }
							rt.eventSubs.stop = null;
							rt.eventSubs.sid = "";
						}
						if (rt.pairListener) {
							try { rt.pairListener(); } catch { /* ignore */ }
							rt.pairListener = null;
						}
					}, "dsh-plugin-deepseek-chat: settings sync");
				} catch {
					/* effect registration unavailable: the subscriber still lives */
				}
			}
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.__test__ = {
			CHAT_URL,
			STORAGE_BASE,
			PANEL_ID,
			VIEW_ID,
			VIEW_ORDER,
			SETTINGS_ID,
			SETTINGS_ORDER,
			CARD_ID,
			CARD_ORDER,
			CARD_RETRY_DELAY,
			CONFIG_KEY,
			DEFAULT_TAB_LABEL,
			DEFAULT_CARD_LABEL,
			DEFAULTS,
			PLUGIN_NAME,
			PLUGIN_VERSION,
			PLUGIN_AUTHOR,
			PLUGIN_LICENSE,
			NPM_PAGE_URL,
			GITHUB_PAGE_URL,
			NPM_VERSION_URL,
			GITHUB_VERSION_URL,
			parseChatUrl,
			parsePopupUrl,
			partitionKeyFor,
			storageKeyFor,
			readConfig,
			getConfig,
			normalizeLabel,
			normalizeTabLabel,
			tabLabel,
			cardLabel,
			writeConfig,
			subscribeConfig,
			cardDescriptor,
			nativeCardDefinition,
			CardGuideIcon,
			CardView,
			CardGlyph,
			compareVersion,
			versionFromPayload,
			readVersionFrom,
			fetchLatestVersion,
			getUpdateState,
			setUpdateState,
			resetUpdateState,
			checkForUpdates,
			runUpdate,
			// v1.2.0 自动闭环：离线自测用的纯函数 / 状态机 / 桥表达式构造器。
			BRIDGE_KEY,
			DEFAULT_MAX_LOOPS,
			DEFAULT_POLL_INTERVAL,
			DEFAULT_REPLY_TIMEOUT,
			DEFAULT_ERROR_KEYWORDS,
			DEFAULT_STOP_SELECTORS,
			DEFAULT_SEND_SELECTORS,
			DEFAULT_TEXTAREA_SELECTORS,
			DEFAULT_ASSISTANT_SELECTORS,
			BRIDGE_IMPL,
			extractContentText,
			eventAnswerText,
			containsErrorKeyword,
			collectAnswerText,
			normalizeMaxLoops,
			normalizeStringArray,
			normalizeSelectors,
			buildBridgeConfig,
			ensureBridgeExpression,
			bridgeSendExpression,
			bridgePollExpression,
			createSyncController,
			ensureSyncRuntime,
			makeWebviewBridge,
			injectDraft,
			onSessionEvents,
			makeSyncDock,
			syncAutoLoop,
			SyncStatusBar,
			// v1.2.0 闭环追踪：让探针与离线断言读到真实的阶段时间戳。
			LOOP_TRACE_KEY,
			LOOP_TRACE_EVENT_CAP,
			writeLoopTrace,
			traceControllerState,
			// v1.2.1 半自动带回：借鉴官方会话导入插件的结构化解析语义。
			selectExportBranch,
			exportReplyText,
			extractExportReply,
			bringBackReply,
			// v1.2.3 发送确认：用户消息节点计数 + 延迟确认 + 失败上报/再试一次。
			SEND_CONFIRM_DELAY,
			DEFAULT_USER_MESSAGE_SELECTORS,
			bridgeConfirmExpression,
			scheduleSendConfirmation,
			// v1.2.6 B 方案：跨会话草稿 API 注入 + 订阅上移。
			injectToSessionViaApi,
			ensureEventSubscription,
			// 手动绑定 + 齿轮跳设置页。
			openSettingsViaShortcut,
			focusDeepSeekChatSection,
			// v1.4.0 全自动投递通道：常量 / 纯函数 / 数据流。
			DEFAULT_PILOT_MARKER_START,
			DEFAULT_PILOT_MARKER_END,
			DEFAULT_PILOT_DONE_KEYWORDS,
			DEFAULT_PILOT_RESTART_KEYWORDS,
			DEFAULT_PILOT_HANDOFF_KEYWORDS,
			DEFAULT_PILOT_OUTPUT_CONTRACT,
			extractPilotPayload,
			buildPilotPush,
			classifyPilotReply,
			isPilotActive,
			tryAutoSubmit,
			handlePilotReply,
			startAutoPilot,
			stopAutoPilot
		};
		return module.exports;
	}
});
