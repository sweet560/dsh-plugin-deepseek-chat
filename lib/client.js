/**
 * Browser half of dsh-plugin-deepseek-chat (v1.1.7).
 *
 * Four contributions, all showing chat.deepseek.com in an Electron <webview>:
 *   - the global left-sidebar panel (a `sidebar.panellist` icon row + the root
 *     `main` keyed slot), the same mechanism Plugins / Scheduled tasks use;
 *   - a conversation top-bar tab registered in the `conversation.view` list
 *     slot, so the web chat is reachable from the 对话 / 轨迹 / 上下文 … tab row
 *     without leaving the current Session (this one can be switched off);
 *   - a right-sidebar card registered through dsh-better-sidebar's
 *     `betterSidebar` service (see "Right-sidebar card" below);
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
 * Right-sidebar card (v1.1.7)
 * ---------------------------
 * dsh-better-sidebar exposes a client-only `betterSidebar` service and renders
 * every `registerTab()` descriptor as a DSH native right-sidebar tab. The
 * cheapest, zero-dependency integration is a SOFT probe: `ctx.get('betterSidebar')`
 * returns undefined when the plugin is not installed (the dynamic Cordis guard
 * allows `ctx.get()` without declaring an inject), and `registerTab` is callable
 * through the guarded service proxy. No package.json `dsh.client.inject`, no
 * peer dependency and no `exports.inject` change is needed; the left-sidebar,
 * top-bar tab and Settings page keep working on machines without better-sidebar.
 * The disposer returned by registerTab is held by `ctx.effect`, so unloading
 * this plugin removes the card. The card title is a thunk (re-evaluated on every
 * render), so renaming it in Settings is immediate; toggling it off disposes
 * the registration and toggling on re-registers it.
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
		const CHAT_URL = "https://chat.deepseek.com/";

		/**
		 * Plugin metadata shown in Settings. Kept as plain constants (the client
		 * bundle cannot import package.json) and asserted against package.json by
		 * the offline self-test — the same pattern the factory id uses.
		 */
		const PLUGIN_NAME = "@tianyulinfeng1/dsh-plugin-deepseek-chat";
		const PLUGIN_VERSION = "1.1.7";
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

		const english = typeof navigator !== "undefined" && /^en\b/i.test(navigator.language ?? "");
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
			settingsEnableCardHint: "Register a right-sidebar tab through dsh-better-sidebar (if installed); turning it off removes the card.",
			settingsCardLabel: "Right-sidebar card name",
			settingsCardLabelHint: "Default: DeepSeek 聊天. Leave the box empty to restore the default. Independent of the top-bar tab name.",
			aboutTitle: "About this plugin",
			infoVersion: "Version",
			infoAuthor: "Author",
			infoLicense: "License",
			infoDescription: "Description",
			infoSummary: "Opens chat.deepseek.com from the left sidebar, the conversation tab row and a better-sidebar right-sidebar card: switchable, renameable entries, a full-area web chat, and last-conversation memory.",
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
			updateCurrent: "Current"
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
			settingsEnableCardHint: "通过 dsh-better-sidebar（若已安装）注册一张右边栏卡片；关闭后移除该卡片。",
			settingsCardLabel: "右边栏卡片名称",
			settingsCardLabelHint: "默认：DeepSeek 聊天；留空即恢复默认。与顶部标签栏名称相互独立。",
			aboutTitle: "关于本插件",
			infoVersion: "插件版本号",
			infoAuthor: "作者",
			infoLicense: "开源许可证",
			infoDescription: "功能简介",
			infoSummary: "在左侧栏、会话顶栏与 better-sidebar 右边栏卡片直接打开 chat.deepseek.com 网页聊天；入口可开关、可改名，网页铺满会话区并记住上次会话。",
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
			updateCurrent: "当前版本"
		};

		/** localStorage key for the four user preferences (separate from last-url memory). */
		const CONFIG_KEY = "dsh-plugin-deepseek-chat:config";
		const DEFAULT_TAB_LABEL = "DeepSeek 聊天";
		const DEFAULT_CARD_LABEL = "DeepSeek 聊天";
		const DEFAULTS = {
			showTab: true,
			tabLabel: DEFAULT_TAB_LABEL,
			showCard: true,
			cardLabel: DEFAULT_CARD_LABEL
		};
		const configListeners = new Set();
		let config = readConfig();

		/** Read preferences, validating each field's type against DEFAULTS. */
		function readConfig() {
			const result = { ...DEFAULTS };
			try {
				const raw = window.localStorage.getItem(CONFIG_KEY);
				if (typeof raw !== "string" || raw.length === 0) return result;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return result;
				if (typeof parsed.showTab === "boolean") result.showTab = parsed.showTab;
				if (typeof parsed.tabLabel === "string") result.tabLabel = normalizeLabel(parsed.tabLabel, DEFAULT_TAB_LABEL);
				if (typeof parsed.showCard === "boolean") result.showCard = parsed.showCard;
				if (typeof parsed.cardLabel === "string") result.cardLabel = normalizeLabel(parsed.cardLabel, DEFAULT_CARD_LABEL);
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

		// ── 关于 & 检查更新（v1.1.5）────────────────────────────────────────────
		/** status: idle | checking | up-to-date | found | failed. */
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
			let line;
			if (state.status === "found") {
				line = `${COPY.updateFound} ${state.latest}（${COPY.updateCurrent} ${PLUGIN_VERSION}）`;
			} else if (state.status === "up-to-date") {
				line = `${COPY.updateUpToDate}（${COPY.updateLatest} ${state.latest}）`;
			} else {
				line = `${COPY.updateFailed}：${state.reason ?? ""}`;
			}
			if (state.source !== void 0) line += ` · ${COPY.updateSource} ${state.source}`;
			return line;
		}

		/**
		 * Settings page. Built once and reused: writing a checkbox or typing in the
		 * text box calls writeConfig(), which persists and notifies apply()'s
		 * subscriber; the local counter only refreshes this form's own state. The
		 * About block and the "检查更新" button are also part of this one component.
		 */
		function makeSettingsView() {
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

				const showLinks = update.status === "found" || update.status === "up-to-date" || update.status === "failed";

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

			const register = (slot, options, component) => {
				try {
					return ctx.slots.inject(slot, () => ctx.slots.register(options, component));
				} catch (error) {
					try {
						console.error(`dsh-plugin-deepseek-chat: ${slot} registration failed`, error);
					} catch {
						/* console unavailable */
					}
					return void 0;
				}
			};

			// Soft-detect the optional better-sidebar service. Never declare it in
			// inject (that would make the WHOLE plugin fail to activate when the
			// optional package is absent). ctx.get() is the guard-approved way.
			let betterSidebar = void 0;
			try {
				if (typeof ctx.get === "function") betterSidebar = ctx.get("betterSidebar");
			} catch {
				betterSidebar = void 0;
			}

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
			}, makeSettingsView());

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

			// Dynamic entry: the better-sidebar right-sidebar card. Its title is a
			// thunk, so renaming needs no re-registration; the showCard switch is
			// implemented by disposing/re-registering the descriptor (an `available`
			// flag would only grey the + menu, not remove an open tab).
			let disposeCard = void 0;
			const syncCard = () => {
				if (typeof disposeCard === "function") {
					try {
						disposeCard();
					} catch {
						/* already gone */
					}
				}
				disposeCard = void 0;
				if (betterSidebar === void 0 || betterSidebar === null) return;
				if (typeof betterSidebar.registerTab !== "function") return;
				if (config.showCard === false) return;
				try {
					disposeCard = betterSidebar.registerTab(cardDescriptor());
				} catch (error) {
					try {
						console.error("dsh-plugin-deepseek-chat: right-sidebar card registration failed", error);
					} catch {
						/* console unavailable */
					}
					disposeCard = void 0;
				}
			};

			// One subscription drives both dynamic surfaces. The effect owns both
			// disposers so an HMR/unload cleans up the better-sidebar tab too.
			const sync = () => {
				syncView();
				syncCard();
			};
			sync();

			const unsubscribe = subscribeConfig(sync);
			if (typeof ctx.effect === "function") {
				try {
					// ctx.effect(callback) runs the callback and keeps its RETURN value
					// as the fiber-owned disposer. Return a closure (do not run cleanup
					// now) so HMR / unload disposes the CURRENT registrations.
					ctx.effect(() => () => {
						unsubscribe();
						if (typeof disposeView === "function") disposeView();
						if (typeof disposeCard === "function") disposeCard();
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
			CardView,
			CardGlyph,
			compareVersion,
			versionFromPayload,
			readVersionFrom,
			fetchLatestVersion,
			getUpdateState,
			setUpdateState,
			resetUpdateState,
			checkForUpdates
		};
		return module.exports;
	}
});
