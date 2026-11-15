/**
 * Browser half of dsh-plugin-deepseek-chat (v1.2.2).
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
		const PLUGIN_VERSION = "1.2.2";
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
		const DEFAULT_REPLY_TIMEOUT = 180000;
		const DEFAULT_ERROR_KEYWORDS = ["Error", "Traceback", "Failed", "panic", "FATAL"];
		const DEFAULT_STOP_SELECTORS = ["[data-testid=\"stop-button\"]", ".stop-generate", "button[aria-label*=\"停止\"]", "button[aria-label*=\"Stop\"]"];
		const DEFAULT_SEND_SELECTORS = ["button[type=\"submit\"]", "[data-testid=\"send-button\"]", "button[aria-label*=\"发送\"]", "button[aria-label*=\"Send\"]"];
		const DEFAULT_TEXTAREA_SELECTORS = ["textarea", "[contenteditable=\"true\"]", "div[role=\"textbox\"]"];
		const DEFAULT_ASSISTANT_SELECTORS = ["[data-message-author-role=\"assistant\"]", ".ds-markdown", ".markdown", "[class*=\"markdown\"]"];

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
			infoSummary: "Opens chat.deepseek.com from the left sidebar, the conversation tab row, and a right-sidebar card that uses better-sidebar when it is running or DSH native right sidebar otherwise: switchable, renameable entries, a full-area web chat, and last-conversation memory.",
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
			syncBringBackOk: "Reply written to the draft — click Run / Continue yourself."
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
			infoSummary: "在左侧栏、会话顶栏与右边栏卡片直接打开 chat.deepseek.com 网页聊天；右边栏卡片按 better-sidebar 是否正常运行自动选择它或 DSH 原生右侧栏，入口可开关、可改名，网页铺满会话区并记住上次会话。",
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
			syncBringBackOk: "回复已写入草稿 — 请自行点击运行 / 继续。"
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
			// ── 半自动带回（v1.2.1，借鉴官方会话导入插件）——默认关闭 ──
			// 网页 DOM 抓取失败时的稳健替代：用户显式粘贴回复/导出 JSON → 结构化解析 → 写草稿，绝不 submit。
			halfAutoEnabled: false
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
				assistantSelectors: [...DEFAULTS.assistantSelectors]
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
				if (typeof parsed.halfAutoEnabled === "boolean") result.halfAutoEnabled = parsed.halfAutoEnabled;
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
			if (typeof patch.halfAutoEnabled === "boolean") next.halfAutoEnabled = patch.halfAutoEnabled;
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
      try { btn.click(); } catch (e) { return false; }
      sendClicks += 1; sendMethod = "click"; sent = true;
      return true;
    }
    return false;
  }
  function keyFallback() {
    if (!currentBox) return;
    // DeepSeek 默认「Enter 发送 / Shift+Enter 换行」，先发普通 Enter；
    // 仅当输入框仍未被清空（说明 Enter 没生效）时才补 Ctrl+Enter。
    keySend(false);
    if (!boxIsEmpty(currentBox)) keySend(true);
    sendMethod = "enter+ctrlEnter"; sent = true;
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
      sendMethod: sendMethod, sendAttempts: sendAttempts, sendClicks: sendClicks, sent: sent };
  }
  function reset() {
    disconnect();
    phase = "idle"; baseline = ""; resultText = ""; resultReason = "";
    wasGenerating = false; stableCount = 0; lastLen = -1; startTime = Date.now();
    currentBox = null; sendMethod = ""; sendAttempts = 0; sendClicks = 0; sent = false;
  }
  function fillAndSend(text) {
    reset();
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
			const dedup = new Map();
			const listeners = new Set();
			function snapshot() {
				return { state, loopCount, lastReply, pausedReason, lastSessionId, draftInjected };
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
				if (state === "paused") return { action: "skip", reason: "paused" };
				if (state === "waiting" || state === "pushing") return { action: "skip", reason: "busy" };
				if (loopCount >= normalizeMaxLoops(c.maxAutoLoops)) { set("paused", "max-loops"); return { action: "pause", reason: "max-loops" }; }
				if (e.reasonKind !== "completed" && e.reasonKind !== "max-tokens") return { action: "skip", reason: "turn-not-completed" };
				const sid = String(e.sessionId == null ? "" : e.sessionId);
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
				draftInjected = true;
				set("pushing", "");
				return { action: "push", text, sessionId: sid, turn: e.turn };
			}
			function notePushed() { if (state === "pushing") set("waiting", ""); }
			function noteReply(text) {
				lastReply = String(text == null ? "" : text);
				if (state === "waiting" || state === "pushing") set("injected", "");
				return lastReply;
			}
			function noteDraftInjected(ok) { draftInjected = !!ok; emit(); }
			function noteTimeout() { if (state === "waiting" || state === "pushing") set("timeout", "timeout"); }
			function noteSendFailed(reason) { if (state === "pushing") set("error", reason || "send-failed"); }
			function noteError(reason) { set("error", reason || "error"); }
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
				draftInjected = true;
				set(getConfig().autoSyncEnabled ? "idle" : "off", "");
			}
			function subscribe(listener) {
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			}
			return { getState: snapshot, refresh, handleTurnEnd, notePushed, noteReply, noteDraftInjected, noteTimeout, noteSendFailed, noteError, acknowledge, reset, subscribe };
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
				dockDispose: null
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
				poll() { return run(bridgePollExpression(buildBridgeConfig())); }
			};
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
			Promise.resolve()
				.then(() => bridge.send(text))
				.then((res) => {
					if (!res || !res.ok) {
						writeLoopTrace({ lastSendResult: "failed:" + String(res && res.reason), lastSendAt: new Date().toISOString() }, { stage: "send", detail: "failed" });
						rt.controller.noteSendFailed(res && res.reason);
						return;
					}
					// v1.2.2: 记录实际采用的发送方式（click / enter+ctrlEnter），便于实机 loop-trace 复核「填入后确已触发发送」。
					writeLoopTrace({ lastSendResult: "ok", lastSendMethod: String((res && res.method) || ""), lastSendAttempts: (res && res.attempts) || 0, lastSendAt: new Date().toISOString() }, { stage: "send", detail: "ok" });
					rt.controller.notePushed();
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

		/** Write the web reply into the desktop draft — NEVER calls submit(). */
		function injectDraft(rt, text) {
			const dock = rt.dockBinding && rt.dockBinding.current;
			let ok = false;
			if (dock && dock.inputActions && typeof dock.inputActions.setDraft === "function") {
				try { dock.inputActions.setDraft(text); ok = true; } catch { /* graceful fallback below */ }
			}
			writeLoopTrace({
				lastDraftInjectedAt: new Date().toISOString(),
				lastDraftResult: ok ? "ok" : "no-dock",
				lastDraftPreview: String(text || "").slice(0, 80)
			}, { stage: "draft-injected", detail: ok ? "setDraft-only" : "no-dock" });
			rt.controller.noteDraftInjected(ok);
			return ok;
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

		/** Hidden conversation.composer.dock entry: captures InputActions + sessionId. */
		function makeSyncDock(rt) {
			return function SyncDockBinding(props) {
				const p = props || {};
				if (p.inputActions && typeof p.inputActions.setDraft === "function") {
					rt.dockBinding.current = { inputActions: p.inputActions, sessionId: p.sessionId };
				}
				react.useEffect(() => {
					let sessions = null;
					try { sessions = rt.ctx.get("sessions"); } catch { return undefined; }
					if (!sessions || typeof sessions.binding !== "function" || !p.sessionId) return undefined;
					let binding;
					try { binding = sessions.binding(p.sessionId); } catch { return undefined; }
					const source = binding && binding.eventSource;
					if (!source || typeof source.subscribe !== "function" || typeof source.getSnapshot !== "function") return undefined;
					let stop;
					try { stop = source.subscribe(() => onSessionEvents(rt, source, p.sessionId)); } catch { return undefined; }
					return () => { try { if (stop) stop(); } catch { /* ignore */ } };
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
				rt.controller.refresh();
			}
		}

		/** Human-facing status strip shown in the chat panel (read-only + copy fallback). */
		function SyncStatusBar() {
			const [, force] = react.useState(0);
			const [bringBackMsg, setBringBackMsg] = react.useState("");
			const taRef = react.useRef(null);
			const rt = syncRuntime;
			react.useEffect(() => {
				const bump = () => force((v) => v + 1);
				const a = rt ? rt.controller.subscribe(bump) : null;
				const b = subscribeConfig(bump);
				return () => { try { if (a) a(); b(); } catch { /* ignore */ } };
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
			let label;
			switch (st.state) {
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
				react.createElement("span", { style: styles.syncCount }, COPY.syncRound + " " + st.loopCount + "/" + normalizeMaxLoops(getConfig().maxAutoLoops))
			];
			const needsReset = st.state === "paused" || st.state === "error" || st.state === "timeout";
			if (needsReset) {
				children.push(react.createElement("button", {
					type: "button",
					"data-dsh-plugin-deepseek-chat": "sync-reset",
					style: styles.syncButton,
					onClick: () => { rt.controller.reset(); }
				}, COPY.syncReset));
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

					// 第三组卡片：关于本插件 + 检查更新。
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
							showLinks ? linkRow() : null)),

					// 第四组卡片：v1.2.0 条件触发式自动闭环（默认关闭）。
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
						react.createElement("p", { style: styles.settingsHint }, COPY.syncSafetyNote)));
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
			bringBackReply
		};
		return module.exports;
	}
});
