# dsh-plugin-deepseek-chat

English | [中文](README.md)

> **Current version: v1.1.1** | Targets DSH **0.2.2-rc.1**

Adds a **DeepSeek Chat** entry to the **DeepSeek Harness (DSH) desktop** sidebar. Clicking it opens `chat.deepseek.com` full-width in the main area, remembers the last conversation, and shows the current DSH account state.

> Repository: [GitHub](https://github.com/sweet560/dsh-plugin-deepseek-chat) | [Gitee mirror](https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat)

![panel screenshot](docs/screenshot.png)

## Features

- Sidebar icon entry, placed between **Plugins** and **Scheduled tasks**.
- Full-width embedded `https://chat.deepseek.com/` (Electron `<webview>` through the desktop guest-lease bridge `window.dshDesktop.browser`).
- **Last-conversation memory**: switching panels/sessions or restarting the app reopens the conversation you left, not a new chat.
- Auth pages never overwrite that memory; a dead conversation falls back to the site root.
- **Stable login session (fixed in v1.1.1)**: the guest partition is the constant `panel:deepseek-chat`; switching panels/sessions back no longer rebuilds the partition or asks for a fresh QR scan.
- **DSH account status**: a strip shows "Synced with the DSH account · name" / "No account" / "Account state unavailable" via the official `ctx.remote.account` Remote. **Display only — it never participates in the guest lifecycle.**
- **Crash containment**: if the embedded page's process dies, is destroyed, or never starts, the panel shows a Retry card — the app window no longer goes blank (fixed in v0.4.0).
- Inert on the plain Web surface (`dsh web`): the site sends `frame-ancestors 'none'`, so an iframe cannot carry it, and the guest bridge only exists in the desktop shell.

## Requirements

| Item | Requirement |
|---|---|
| DSH | Desktop `0.2.2-rc.1` or newer |
| Platform | Windows / macOS / Linux desktop shell |
| git | Only for the GitHub install route (pnpm fetches the repository) |

## Install

### Option 1 — Plugins page (recommended)

1. Open DSH desktop and click **Plugins** in the sidebar.
2. Click **Install a third-party plugin** above the list.
3. Enter:

   ```
   github:sweet560/dsh-plugin-deepseek-chat
   ```

   `https://github.com/sweet560/dsh-plugin-deepseek-chat` works too.
4. Click **Install** and wait for pnpm to finish.
5. The plugin is enabled automatically; **DeepSeek Chat** appears in the sidebar.

### Option 2 — CLI

```powershell
dsh plugin --profile desktop add github:sweet560/dsh-plugin-deepseek-chat
```

Then open **Plugins → Installed plugins** and make sure **DeepSeek Chat** is switched on (the CLI only installs the package).

### Option 3 — local checkout (development)

```powershell
dsh plugin --profile desktop add file:"<absolute path to this repository>"
```

## Why the web chat cannot reuse the DSH sign-in

**A pure plugin cannot make chat.deepseek.com reuse the already-signed-in DSH account.** This is an architecture limit of DSH 0.2.2-rc.1, verified against its source:

| | DSH desktop account | chat.deepseek.com web |
|---|---|---|
| Credential | platform.deepseek.com `x-dsh-auth-token` (Host-only `getPlatformSession()`) | the site's own Token (`api/v0/users/current` returns `40002 Missing Token` without it) |
| Storage | Host credential store | httpOnly cookie in the guest session |
| Exchange | **None** — zero `chat.deepseek.com` references, no SSO, no cookie injection in the whole archive | — |

- The renderer bridge `globalThis.dshDesktop` exposes only `browser.acquire/release/onOpenRequested` etc. — **no** `getAuthToken`, cookie write, or "open Platform to fetch token" API. `getAuthToken()` exists only in the desktop shell's embedded Platform view (`usage` / `top_up`) preload, main-frame + origin restricted.
- The `browserAcquire` IPC only allocates a partition/lease by workspace string; `configureSession()` sets permissions and download interception, **it injects no credentials**. The guest is forced to `sandbox / contextIsolation / webSecurity`.
- So the DSH account state can only be **displayed**; it cannot become a web-session login. One manual QR sign-in is still required.

**What went wrong in v1.1.0 (fixed in v1.1.1)**: the guest partition had been keyed to the asynchronous account probe. DSH's `getState()` can transiently fail during a reconnect or session switch; changing the partition hands the panel a brand-new cookie jar → a fresh QR scan every time you switched back. Now:

- `acquire()`'s workspace is the constant `panel:deepseek-chat`, and the conversation key is the constant `dsh-plugin-deepseek-chat:last-url`;
- account state changes only update the strip — no epoch, no guest rebuild, no partition change;
- a transient `unknown` is ignored; only a confirmed `signed-out` updates the display;
- the guest starts on mount immediately, without waiting for the async Remote (a failed probe never blocks chat);
- popup navigation is allowlisted to `chat.deepseek.com` and `platform.deepseek.com` (HTTPS, default port).

> To also avoid re-scanning **after restarting DSH**, run [scripts/patch-dsh-persistent-partition.cjs](scripts/patch-dsh-persistent-partition.cjs) per [docs/login-persistence.md](docs/login-persistence.md) to change DSH's random in-memory partition into a deterministic `persist:` one (an `app.asar` edit — modifying the installed app, at your own risk). **It also syncs the per-file SHA256 ASAR integrity required by 0.2.2-rc.1** — a byte-only replacement (the deprecated `.mjs` script) would crash DSH on restart. It requires fully exiting DSH first. That patch preserves web cookies across restarts; it does not make the web chat reuse the DSH token.

## Usage

- The first visit shows the chat.deepseek.com sign-in page; sign in once.
- Within one app run, switching panels or sessions keeps you signed in (fixed partition since v1.1.1).
- **Sign in again after restarting DSH**: DSH currently gives embedded browsers a random in-memory partition (`dsh-sidebar-browser-<uuid>`, no `persist:` prefix), so cookies are dropped when the process exits. This plugin does not modify DSH's installation files; to sign in once and stay signed in, apply the equal-length byte patch described in **[docs/login-persistence.md](docs/login-persistence.md)**.
- The conversation URL is stored under the fixed key `dsh-plugin-deepseek-chat:last-url`, so the last conversation is restored after a restart (while signed in and while it still exists).

## Persistent login (optional)

DSH hands embedded browsers an **in-memory partition** (`dsh-sidebar-browser-${randomUUID()}`, no `persist:` prefix), so every app restart drops the cookies. To sign in once and stay signed in, replace that partition with a fixed `persist:` one inside `resources/app.asar` — the two statements are the same length, so the archive can be patched byte-for-byte in place.

Cause, script, verification, rollback and per-platform paths:

**→ [docs/login-persistence.md](docs/login-persistence.md)**

Note: this modifies the installed application and is outside DSH's support; a DSH update overwrites `app.asar` and the patch must be re-applied (the `Partitions` data survives). Back up first and proceed at your own risk.

## Known limitations

- chat.deepseek.com detects the Electron embedding and occasionally shows a "usage environment is abnormal" notice. That is site-side behaviour, unrelated to this plugin.
- Desktop only; `dsh web` in a browser shows no entry.
- If the site changes its conversation URL scheme (currently `/a/chat/s/<id>`), the memory falls back to the site root.
- The DSH account status is display-only; it cannot turn the DSH OAuth token into a chat.deepseek.com web session, so the web chat still needs one manual sign-in on first use.
- `getProfile()` is used only for the display name. If it is temporarily unavailable the strip may lag briefly, but it **never** affects the guest or the login state.
- Restarting DSH still requires a fresh web sign-in unless the persistent-partition patch in [docs/login-persistence.md](docs/login-persistence.md) is applied.

## Crash containment (v0.4.0)

Earlier versions could leave the whole app a blank window a second or two after opening the panel, with no crash dialog and no `crash-*.log`.

Root cause: React runs effect cleanups after it has removed the DOM, and Electron's `<webview>` throws from `getURL()` once detached. DSH treats any uncaught plugin error as `slot entry crashed in 'root'` and unmounts the root slot — the entire UI.

The current implementation guards every guest call behind an `isConnected` check and `try/catch`, reads the URL before removing the element, wraps every event handler, puts a React error boundary around the panel, listens for `render-process-gone` / `destroyed` / `did-fail-load`, and has a 15-second start watchdog. On failure the dead guest element is removed **before** the Retry card, so retrying cannot stack webviews; a listener-registration failure never starts a guest, and popup URLs are allowlisted (v1.1.0).

## Version history

| Version | Changes |
|---|---|
| **1.1.1** | **Fixes the "scan the QR code again on every panel switch" regression**: the guest partition and conversation key are constants; account state is display-only and never touches the guest lifecycle; a transient `unknown` is ignored; the guest no longer waits for the async probe; self-check now asserts a fixed partition and no rebuild on state churn (35 cases). Documents why a pure plugin cannot reuse the DSH token. |
| 1.1.0 | DSH `0.2.2-rc.1`: DSH account status strip; correct generated Remote envelope parsing; stricter conversation and popup URL validation; dead guest removal on failure. **This release keyed the partition to account state and broke login persistence (fixed in 1.1.1).** |
| 1.0.0 | First local release: sidebar entry, full-width chat, conversation memory, crash containment. |

## Development

```powershell
git clone https://github.com/sweet560/dsh-plugin-deepseek-chat.git
cd dsh-plugin-deepseek-chat
node test/check-client.mjs
```

`test/check-client.mjs` loads `lib/client.js` in a `node:vm` sandbox with fake React/DOM/bridge objects and checks registration, Remote envelope parsing, a fixed partition/key, no rebuild on account-state churn, partition reuse across panel switches, conversation memory, lease release, popup allowlisting and crash containment.

```
lib/index.js           host half (empty; it only gives the client bundle a Loader entry)
lib/client.js          browser half: entry, panel, account status strip, webview lifecycle, crash containment
cordis.patch.yml       bundle patch that inserts this plugin's Loader row
locale/{zh,en}.json    Plugins-page title/description
icon.svg               Plugins-page icon
docs/login-persistence.md  optional byte patch for DSH's in-memory browser partition
test/check-client.mjs  offline self-check
```

## Uninstall

```powershell
dsh plugin --profile desktop remove dsh-plugin-deepseek-chat
```

## License

[MIT](LICENSE)
