/**
 * Browser half of dsh-plugin-deepseek-chat.
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
 * Failure containment is the hard rule of this file. DSH treats any uncaught
 * error thrown by a plugin as a crash of its slot entry, and a crash inside the
 * `root` slot unmounts the entire application UI (the native frame stays, every
 * panel disappears). Electron throws from webview methods such as `getURL()`
 * and `loadURL()` as soon as the element leaves the document, and React runs
 * effect cleanups after the DOM removal — so every guest call here is attached-
 * checked and wrapped, every event handler catches, and a React error boundary
 * keeps a render failure inside this panel. A dead guest is reported in the
 * panel with a Retry button; it never escapes to the shell.
 *
 * Leaving the panel unmounts this page and releases the guest, so the page
 * remembers the last conversation URL and reopens there instead of starting a
 * new chat every time.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-deepseek-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const PANEL_ID = "deepseek-chat";
		const CHAT_URL = "https://chat.deepseek.com/";
		/**
		 * Storage identity for the guest partition. The main process keeps one
		 * partition per identity for the lifetime of the process, so switching
		 * panels or sessions keeps the page state and its login.
		 */
		const PARTITION_KEY = "panel:deepseek-chat";

		const english = typeof navigator !== "undefined" && /^en\b/i.test(navigator.language ?? "");
		const COPY = english ? {
			label: "DeepSeek Chat",
			loading: "Loading DeepSeek Chat…",
			unsupported: "The embedded chat needs the desktop app.",
			failed: "The chat page could not be opened",
			crashed: "The embedded chat stopped responding",
			timeout: "The embedded chat did not start",
			retry: "Retry"
		} : {
			label: "DeepSeek 聊天",
			loading: "正在加载 DeepSeek 聊天…",
			unsupported: "内嵌聊天窗口需要桌面版 App。",
			failed: "聊天页面打开失败",
			crashed: "内嵌聊天进程已退出",
			timeout: "内嵌聊天页面没有启动",
			retry: "重试"
		};

		/** Where the last visited conversation URL is remembered; the shell keeps this storage across restarts. */
		const STORAGE_KEY = "dsh-plugin-deepseek-chat:last-url";
		/** Paths that are not a conversation: a brand-new chat, or an auth page. */
		const NON_CONVERSATION_PATHS = new Set(["/", "/sign_in", "/login", "/signup", "/auth"]);

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
				if (url.username !== "" || url.password !== "") return void 0;
				return url;
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
		 * @returns the URL to open; the site root when nothing usable is remembered.
		 */
		function rememberedTarget() {
			try {
				const saved = parseChatUrl(window.localStorage.getItem(STORAGE_KEY));
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
		 */
		function rememberTarget(raw) {
			const url = parseChatUrl(raw);
			if (url === void 0) return;
			try {
				const path = url.pathname.replace(/\/+$/u, "") || "/";
				if (isConversation(url)) window.localStorage.setItem(STORAGE_KEY, url.toString());
				else if (path === "/") window.localStorage.removeItem(STORAGE_KEY);
			} catch {
				/* storage unavailable: the panel still works, it just forgets */
			}
		}

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

		/**
		 * Guest URL, or undefined when the element cannot report one. This is the
		 * call that used to escape: React cleans up effects after removing the DOM,
		 * and Electron then throws from `getURL()`.
		 * @param element - webview element.
		 * @returns the URL string, or undefined.
		 */
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
		 * @param element - webview element.
		 * @param url - target URL.
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
		 * @param props - size passed by the sidebar panel list.
		 * @returns the glyph element.
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
		 * The global chat panel: a guest webview filling the main column.
		 *
		 * The guest is created only after the lease resolves, and it is mounted with
		 * `name`/`partition`/`src` already set, because the main process inspects
		 * exactly that bootstrap src when it approves the attachment. The first load
		 * goes to the remembered conversation; navigation events keep that memory
		 * current. A dead guest (crash, destroy, failed start) turns into a retry card
		 * inside the panel; cleanup releases the lease and never calls into a detached
		 * element.
		 * @returns the panel element tree.
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

				let disposed = false;
				let unsubscribeOpen;
				let lease;
				let watchdog;
				const element = document.createElement("webview");
				const initialTarget = rememberedTarget();
				let restoring = initialTarget !== CHAT_URL;

				Object.assign(element.style, styles.guest);
				element.setAttribute("allowpopups", "");

				/** Report a guest failure inside the panel; never throw. */
				const fail = (error) => {
					if (disposed) return;
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
					rememberTarget(raw);
				};

				const onDomReady = () => {
					if (disposed) return;
					if (watchdog !== void 0) {
						clearTimeout(watchdog);
						watchdog = void 0;
					}
					if (!navigate(element, initialTarget)) fail(new Error(COPY.crashed));
					else remember(initialTarget);
				};
				const onStopLoading = () => {
					if (disposed) return;
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
					if (disposed) return;
					remember(readUrl(element));
				};
				const onNavigateInPage = (event) => {
					if (disposed || event?.isMainFrame !== true) return;
					onNavigate();
				};
				const onFailLoad = (event) => {
					if (disposed || event?.isMainFrame !== true) return;
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
					if (disposed) return;
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

				try {
					for (const [name, handler] of listeners) {
						element.addEventListener(name, handler, name === "dom-ready" ? { once: true } : void 0);
					}
				} catch (error) {
					fail(error);
				}

				const start = async () => {
					try {
						const reservation = await bridge.acquire(PARTITION_KEY);
						if (disposed) {
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
							unsubscribeOpen = bridge.onOpenRequested(reservation.lease, (url) => {
								if (!disposed && typeof url === "string") navigate(element, url);
							});
						} catch {
							/* popup bridge unavailable: the guest still works */
						}
						host.append(element);
						watchdog = setTimeout(() => {
							watchdog = void 0;
							if (disposed) return;
							if (readUrl(element) === void 0) fail(new Error(COPY.timeout));
						}, 15000);
					} catch (error) {
						fail(error);
					}
				};
				void start();

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
		return module.exports;
	}
});
