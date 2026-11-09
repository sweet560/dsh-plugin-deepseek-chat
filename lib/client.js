/**
 * Browser half of dsh-plugin-deepseek-chat (v1.1.1).
 *
 * Registers one global left-sidebar panel — the same mechanism the Plugins and
 * Scheduled tasks entries use:
 *   `sidebar.panellist` (list) contributes the icon row, and the root `main`
 *   keyed slot with the same key renders the panel page.
 *
 * The page hosts chat.deepseek.com in an Electron `<webview>`. The site sends
 * `content-security-policy: frame-ancestors 'none'`, so an iframe cannot carry
 * it; the desktop shell exposes `globalThis.dshDesktop.browser`, the same guest
 * lease bridge the built-in sidebar browser uses: acquire a lease → create a
 * webview named by the lease with its approved partition → load the URL.
 *
 * Stable login session (v1.1.1)
 * -----------------------------
 * The desktop shell caches ONE process-lifetime session per `workspace` string
 * passed to acquire(), and release() destroys only the guest, never the
 * partition's cookies. So the workspace MUST be an absolute constant:
 * `panel:deepseek-chat`. v1.1.0 keyed it to an async account probe, which
 * transiently fails during reconnects — every change handed the panel a fresh
 * cookie jar and forced another QR scan. That regression is fixed here.
 *
 * Account awareness (display only)
 * --------------------------------
 * DSH's own sign-in is a platform.deepseek.com OAuth grant; the chat site uses
 * a different, site-owned Token. There is no official exchange, and the
 * renderer bridge exposes no token/cookie API, so a pure plugin cannot reuse
 * the DSH token for the web chat (see docs/login-persistence.md §6). All this
 * file does with the account is DISPLAY it:
 *
 *   - a soft probe reads the Client `remote.account` namespace
 *     (`getState`/`getProfile`, generated `{ ok, value }` envelopes) and shows
 *     the state/name in a small strip;
 *   - the account state NEVER feeds the lease identity, the storage key, an
 *     epoch, or the guest lifecycle — no rebuild, no partition change, ever;
 *   - a transient `unknown` is ignored; only a confirmed `signed-out` updates
 *     the strip; a missing/late Remote never blocks the guest from starting.
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
		/**
		 * DSH runtime version sent as `x-client-version` on Platform account
		 * reads. The boot manifest carries the exact connected release; the
		 * minimum supported release is the fallback for a page without it.
		 */
		const HOST_VERSION_FALLBACK = "0.2.2-rc.1";
		const CHAT_URL = "https://chat.deepseek.com/";
		/**
		 * Constant storage identities for the guest partition and the
		 * last-conversation memory. The main process keeps one partition per
		 * `workspace` string for the process lifetime; both values MUST NOT
		 * depend on account state, or a transient probe failure would swap the
		 * cookie jar and force a fresh QR scan. v1.1.1 regression fix.
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
			probing: "Syncing the DSH account…",
			synced: "Synced with the DSH account",
			syncedAs: (name) => `Synced with the DSH account · ${name}`,
			unsigned: "No DSH account signed in — the chat panel is not synced",
			unknown: "Account state unavailable — conversation kept locally"
		} : {
			label: "DeepSeek 聊天",
			loading: "正在加载 DeepSeek 聊天…",
			unsupported: "内嵌聊天窗口需要桌面版 App。",
			failed: "聊天页面打开失败",
			crashed: "内嵌聊天进程已退出",
			timeout: "内嵌聊天页面没有启动",
			retry: "重试",
			probing: "正在同步 DSH 登录账号…",
			synced: "已与 DSH 登录账号同步",
			syncedAs: (name) => `已与 DSH 登录账号同步 · ${name}`,
			unsigned: "未登录 DSH 账号，聊天面板暂未同步",
			unknown: "账号状态不可用，会话按本地模式保存"
		};

		/** Normalized account states the panel can distinguish. */
		const ACCOUNT_UNKNOWN = "unknown";
		const ACCOUNT_SIGNED_IN = "signed-in";
		const ACCOUNT_SIGNED_OUT = "signed-out";

		/**
		 * ONE stable guest partition for the whole process.
		 *
		 * The desktop shell keys a process-lifetime partition Map by the
		 * `workspace` string passed to acquire() and reuses the same session for
		 * every acquire() with that key. release() destroys only the guest, never
		 * the partition's cookies. Consequently, changing this value — even once
		 * — hands the panel a fresh cookie jar and forces the user to scan the
		 * chat login QR code again. It MUST NOT depend on the DSH account probe:
		 * that probe is asynchronous, runs every 5 seconds, and can transiently
		 * return "unknown" during a reconnect or session switch.
		 * @returns the fixed workspace identity for guest leases.
		 */
		function partitionKeyFor() {
			return PARTITION_BASE;
		}

		/**
		 * ONE stable conversation-memory key. Account status changes must not
		 * move it either, or a transient probe failure would silently lose the
		 * remembered conversation.
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
		 * Read the conversation remembered from the last visit for one account.
		 * @param storageKey - account-scoped storage key.
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
		 * @param storageKey - account-scoped storage key.
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

		// ── account sync store ────────────────────────────────────────────────
		/**
		 * One module-level snapshot shared by every mounted panel. The account
		 * Remote is display/awareness only; it never feeds the lease identity or
		 * the guest lifecycle, so a flaky probe can never recreate the webview.
		 */
		let accountSnapshot = { status: ACCOUNT_UNKNOWN, label: "", probed: false };
		const accountListeners = new Set();

		function notifyAccount() {
			for (const listener of [...accountListeners]) {
				try {
					listener(accountSnapshot);
				} catch {
					/* a dead panel must not break another one */
				}
			}
		}

		/** Subscribe a mounted panel; returns its disposer. */
		function subscribeAccount(listener) {
			accountListeners.add(listener);
			return () => {
				accountListeners.delete(listener);
			};
		}

		/**
		 * Publish a probed account state. This ONLY updates the account strip:
		 * it never bumps an epoch and never rebuilds the guest. A transient
		 * "unknown" during reconnect is deliberately ignored so the displayed
		 * state does not flicker; a confirmed sign-out is shown immediately.
		 * @param status - normalized account state.
		 */
		function publishAccount(status) {
			const previous = accountSnapshot;
			// Ignore a transient unknown once we know a real state: it is usually
			// a reconnect, not a sign-out, and must not disturb the panel.
			const settled = status === ACCOUNT_UNKNOWN && previous.probed && previous.status !== ACCOUNT_UNKNOWN
				? previous.status
				: status;
			accountSnapshot = {
				status: settled,
				// Preserve the name through a transient unknown; clear it only on a
				// confirmed sign-out when the display explicitly publishes "".
				label: settled === ACCOUNT_SIGNED_OUT ? "" : previous.label,
				probed: true
			};
			notifyAccount();
		}

		/** Publish a display name; a stale result from an older probe is dropped. */
		function publishAccountLabel(label) {
			if (accountSnapshot.label === label) return;
			accountSnapshot = { ...accountSnapshot, label };
			notifyAccount();
		}

		/**
		 * Read one generated `ctx.remote.account` method. Generated Remotes answer
		 * with an `{ ok, value, error }` envelope, so a bare payload is never
		 * assumed; an absent namespace or a refused call degrades to undefined.
		 * @param ctx - client plugin context.
		 * @param method - generated account method name.
		 * @param args - method arguments.
		 * @returns the envelope's `value`, or undefined when unavailable.
		 */
		async function callAccount(ctx, method, args = []) {
			let remote;
			try {
				remote = typeof ctx.get === "function" ? ctx.get("remote") : ctx.remote;
			} catch {
				remote = void 0;
			}
			const account = remote?.account;
			const call = account?.[method];
			if (typeof call !== "function") return void 0;
			const result = await call.apply(account, args);
			if (result === null || typeof result !== "object" || result.ok !== true) return void 0;
			return result.value;
		}

		/** Platform client identity headers, read at call time as the UI does. */
		function accountClient(ctx) {
			return {
				version: globalThis.__DSH_BOOT__?.release?.version || HOST_VERSION_FALLBACK,
				locale: typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
			};
		}

		/**
		 * Read the live DSH account state and display name. This is awareness
		 * ONLY: no value here may ever feed the guest lease or rebuild the
		 * webview, or a transient Remote failure would drop the chat session.
		 * @param ctx - client plugin context.
		 * @returns `{ status, label }`.
		 */
		async function probeAccount(ctx) {
			let state;
			try {
				state = await callAccount(ctx, "getState");
			} catch {
				state = void 0;
			}
			if (state?.status !== "credential-stored") {
				return {
					status: state?.status === "signed-out" ? ACCOUNT_SIGNED_OUT : ACCOUNT_UNKNOWN,
					label: ""
				};
			}
			const probe = { status: ACCOUNT_SIGNED_IN, label: "" };
			try {
				const outcome = await callAccount(ctx, "getProfile", [accountClient(ctx)]);
				const value = outcome?.status === "ready" ? outcome.value : void 0;
				probe.label = [value?.name, value?.contact, value?.id]
					.find((item) => typeof item === "string" && item.length > 0) ?? "";
			} catch {
				/* profile is display-only: failure keeps the bare state */
			}
			return probe;
		}

		/**
		 * Start the account watcher once per plugin activation. A 5-second poll
		 * plus `connection/reset` gives self-heal without depending on the exact
		 * Client shape of the account `watch` stream, and every resource is
		 * released through the plugin's own ctx effect.
		 * @param ctx - client plugin context.
		 */
		let accountSyncStarted = false;
		function startAccountSync(ctx) {
			if (accountSyncStarted) return;
			accountSyncStarted = true;
			let stopped = false;
			let timer;

			const refresh = async () => {
				if (stopped) return;
				let probe = { status: ACCOUNT_UNKNOWN, label: "" };
				try {
					probe = await probeAccount(ctx);
				} catch {
					/* Remote unavailable: publishAccount ignores a transient unknown */
					probe = { status: ACCOUNT_UNKNOWN, label: "" };
				}
				if (stopped) return;
				publishAccount(probe.status);
				if (probe.label !== "") publishAccountLabel(probe.label);
			};

			const schedule = () => {
				if (stopped) return;
				timer = setTimeout(() => {
					void refresh().finally(schedule);
				}, 5000);
				// A long-lived page keeps the poll; a minimal context (or a Node
				// self-check) must not be held open by its timer alone.
				try {
					if (typeof timer.unref === "function") timer.unref();
				} catch {
					/* not a Node timer */
				}
			};

			void refresh().finally(schedule);

			let offReset;
			try {
				if (typeof ctx.on === "function") offReset = ctx.on("connection/reset", () => {
					void refresh();
				});
			} catch {
				/* optional: the poll still self-heals */
			}

			let hasDisposal = false;
			try {
				if (typeof ctx.effect === "function") {
					ctx.effect(() => () => {
						stopped = true;
						if (timer !== void 0) clearTimeout(timer);
						try {
							if (typeof offReset === "function") offReset();
						} catch {
							/* already detached */
						}
						accountListeners.clear();
						accountSyncStarted = false;
					}, "deepseek-chat: account sync");
					hasDisposal = true;
				}
			} catch {
				/* fall through to the no-disposal path */
			}
			if (!hasDisposal) {
				stopped = true;
				if (timer !== void 0) clearTimeout(timer);
				try {
					if (typeof offReset === "function") offReset();
				} catch {
					/* already detached */
				}
				// Without a real ctx effect there is no teardown to stop the poll;
				// keep the first probe but never leave a repeating timer behind.
				accountSyncStarted = false;
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
				height: "100%",
				minHeight: "0",
				background: "var(--dsw-alias-bg-base)",
				color: "var(--dsw-alias-label-primary)"
			},
			accountBar: {
				flex: "none",
				display: "flex",
				alignItems: "center",
				gap: "6px",
				minHeight: "24px",
				padding: "3px 10px",
				borderBottom: ".5px solid var(--dsw-alias-border-l3)",
				color: "var(--dsw-alias-label-tertiary)",
				font: "var(--dsw-font-xxxs-11)"
			},
			accountDot: {
				width: "6px",
				height: "6px",
				borderRadius: "50%",
				background: "currentColor",
				flex: "none"
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
			}
		};

		/** Copy for the account strip; the dot's opacity encodes the state. */
		function accountCopy(account) {
			if (account.status === ACCOUNT_SIGNED_IN) return {
				text: account.label ? COPY.syncedAs(account.label) : COPY.synced,
				opacity: "1"
			};
			if (account.status === ACCOUNT_SIGNED_OUT) return { text: COPY.unsigned, opacity: ".45" };
			if (!account.probed) return { text: COPY.probing, opacity: ".3" };
			return { text: COPY.unknown, opacity: ".3" };
		}

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
		 * The global chat panel: an account strip and a guest webview filling the
		 * main column.
		 *
		 * The guest is created only after the lease resolves, and it is mounted with
		 * `name`/`partition`/`src` already set, because the main process inspects
		 * exactly that bootstrap src when it approves the attachment. The identity
		 * and the conversation memory are both scoped to the current DSH account;
		 * an account transition bumps `epoch`, which tears down the old guest and
		 * re-acquires a lease for the new identity.
		 */
		function ChatPanel() {
			const hostRef = react.useRef(null);
			const lastUrlRef = react.useRef(void 0);
			const [account, setAccount] = react.useState(accountSnapshot);
			const [failure, setFailure] = react.useState(void 0);
			const [loading, setLoading] = react.useState(true);
			const [attempt, setAttempt] = react.useState(0);

			react.useEffect(() => subscribeAccount((next) => {
				try {
					setAccount(next);
				} catch {
					/* the panel is gone */
				}
			}), []);

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

			const copy = accountCopy(account);

			return react.createElement("div", { style: styles.root },
				react.createElement("div", { style: styles.accountBar },
					react.createElement("span", { style: { ...styles.accountDot, opacity: copy.opacity }, "aria-hidden": "true" }),
					react.createElement("span", null, copy.text)),
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

		/** Client service this plugin reads; the loader waits for the slot registry. */
		const inject = ["slots"];

		/**
		 * Register the left-sidebar entry and its main panel.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			try {
				// The panel needs the desktop guest bridge; on the Web surface an iframe
				// cannot carry the site, so the plugin stays inert there.
				if (globalThis.dshDesktop?.browser === void 0) return;
			} catch {
				return;
			}

			try {
				startAccountSync(ctx);
			} catch (error) {
				try {
					console.error("dsh-plugin-deepseek-chat: account sync failed", error);
				} catch {
					/* console unavailable */
				}
			}

			try {
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: PANEL_ID
				}, ChatPanelShell));

				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 5,
					label: () => COPY.label
				}, ChatGlyph));
			} catch (error) {
				try {
					console.error("dsh-plugin-deepseek-chat: registration failed", error);
				} catch {
					/* console unavailable */
				}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test__ = {
			ACCOUNT_UNKNOWN,
			ACCOUNT_SIGNED_IN,
			ACCOUNT_SIGNED_OUT,
			CHAT_URL,
			STORAGE_BASE,
			accountCopy,
			getSnapshot: () => accountSnapshot,
			partitionKeyFor,
			storageKeyFor,
			publishAccount,
			publishAccountLabel,
			probeAccount,
			callAccount,
			resetAccountSync() {
				accountSnapshot = { status: ACCOUNT_UNKNOWN, label: "", probed: false };
				accountListeners.clear();
				accountSyncStarted = false;
			}
		};
		return module.exports;
	}
});
