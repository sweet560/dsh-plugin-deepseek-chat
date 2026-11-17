# dsh-plugin-deepseek-chat

English | [中文](README.md)

> **Current version: v1.4.0** | Targets DSH **0.2.2-rc.3**
>
> ⚠️ **The "Full auto-pilot channel" is experimental and has NOT been tested on a real machine** (offline self-check only). Please try it in a small scope first; use the status bar "■ Stop auto-pilot" to take over anytime. See [RELEASE_NOTES_v1.4.0.md](docs/RELEASE_NOTES_v1.4.0.md).
> [GitHub](https://github.com/sweet560/dsh-plugin-deepseek-chat) | [Gitee mirror](https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat)

Embeds `chat.deepseek.com` in DSH and **two-way bridges desktop conversations with the web chat** into an automation tool. npm package: `@tianyulinfeng1/dsh-plugin-deepseek-chat`.

![panel screenshot](docs/screenshot.png)

![Chat page (signed in)](docs/screenshot-chat.png)

## Core features

- **Three entries**: sidebar icon, conversation-header tab, and right-sidebar card (default name "DeepSeek Chat", each switchable / renameable) — all open the same full-area web chat and remember the last conversation.
- **Conditional auto-loop** (opt-in): a finished desktop turn → auto-transfer to the web and send → grab the web reply → **write only into the desktop draft**, never auto-executed; whether to continue is always your call. Three safety valves: max loops / error-keyword breaker / per-turn dedup.
- **Full auto-pilot channel** (v1.4.0, opt-in): desktop session = dev agent, web chat = reviewer, you = decision maker, chained into an unattended loop. The reviewer's reply is **extracted only from the `<TO_DEV>…</TO_DEV>` block** (the full page text is NEVER delivered — saving context and tokens) and **auto-submits the next turn via the official `conversation.send`**; hitting a done / restart / handoff (e.g. "please restart the host for acceptance") / same-text-twice / error / max-loops condition **pauses on a decision card** (continue / edit / retry / terminate), with one-click start/stop in the status bar and takeover anytime.
- **Half-automatic bring-back** (opt-in): instead of scraping the web DOM, paste the web reply or exported JSON manually to avoid timeouts.
- **Settings page**: toggles, renaming, loop & auto-pilot config, About, check for updates, one-click update.
- **Stability**: webview crash containment — shows a Retry card in the panel instead of blanking the whole app.

> For the backstory, implementation details and per-release changes, see [CHANGELOG.md](CHANGELOG.md); the current release is detailed in [RELEASE_NOTES_v1.4.0.md](docs/RELEASE_NOTES_v1.4.0.md).

## Requirements

| Item | Requirement |
|---|---|
| DSH | Desktop `0.2.2-rc.3` or newer |
| Platform | Windows / macOS / Linux desktop shell |
| git | Only needed for the GitHub install method |

## Installation

**1. npm (recommended)**

```powershell
dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat
```

**2. Plugins page** — DSH sidebar → Plugins → "Install third-party plugin" → enter `@tianyulinfeng1/dsh-plugin-deepseek-chat` or `github:sweet560/dsh-plugin-deepseek-chat` → Install.

**3. Command line (GitHub)**

```powershell
dsh plugin --profile desktop add github:sweet560/dsh-plugin-deepseek-chat
```

**4. Local directory (development)**

```powershell
dsh plugin --profile desktop add file:"<absolute path to this repo>"
```

Then confirm "DeepSeek Chat" is enabled under Plugins → Installed plugins.

## Usage

- Sign in once at chat.deepseek.com on first open; within one app run, switching panels/sessions keeps you signed in.
- **Sign in again after restarting DSH** (DSH uses an in-memory partition for embedded browsers). See [Persistent login](#persistent-login-optional) to stay signed in.
- The conversation URL is stored in localStorage (key `dsh-plugin-deepseek-chat:last-url`), so the last conversation is restored on restart.
- Settings page: DSH Settings → "DeepSeek Chat" — independently toggle/rename the header tab and right-sidebar card, and configure the auto-loop / auto-pilot channel; changes apply immediately.
- Selecting the header tab fills the conversation area with the web chat; click back to "Dialogue" to restore.

## About "no QR scan / DSH account reuse"

A pure plugin **cannot** make the web chat reuse the signed-in DSH account — an architectural limit: DSH credentials live in the Host process (`x-dsh-auth-token`) while the web chat uses its own cookie token, with no exchange endpoint and no render-layer bridge API to write cookies or fetch a token. A first web sign-in is unavoidable. Since v1.1.3 the panel shows no account status at all.

## Persistent login (optional)

DSH assigns embedded browsers an **in-memory partition** (`dsh-sidebar-browser-<uuid>`), so every restart drops cookies. You can replace it with a fixed `persist:` partition via an in-place equal-length byte patch in `resources/app.asar` to stay signed in.

Full cause, script, verification, rollback and per-platform paths: **[docs/login-persistence.md](docs/login-persistence.md)**. The `scripts/` folder ships plug-and-play batch files (`一键补丁.bat` / `回滚.bat` / `find-dsh.ps1`) that auto-locate DSH, dry-run check, and back up / roll back. Modifies the installed application; a DSH upgrade overwrites `app.asar` and requires re-patching — proceed at your own risk.

## Known limitations

- Desktop only; `dsh web` in a browser shows no entry.
- chat.deepseek.com occasionally shows a "usage environment is abnormal" notice — site-side behavior, unrelated to this plugin.
- A pure plugin cannot reuse the DSH token — one manual web sign-in is required (see above).
- Restarting DSH requires a fresh web sign-in unless the persistent-partition patch is applied.

## Version history

Only major milestones are listed; the full per-release log is in **[CHANGELOG.md](CHANGELOG.md)**, with release notes in [docs/](docs/):

| Version | Milestone |
|---|---|
| **1.4.0** | Full auto-pilot channel (delimited-block extraction + official `conversation.send` auto-submit + decision card) |
| **1.3.0** | Manual session bind + status-bar settings gear + session title |
| **1.2.1** | Half-automatic bring-back (structured parsing of official exports) |
| **1.2.0** | Conditional auto-loop (three safety valves) |
| **1.1.7** | Right-sidebar card (dsh-better-sidebar) |
| **1.1.1** | Fixed repeated QR scans on panel switch / restart |
| **1.0.0** | First local release |

## Development

```powershell
git clone https://github.com/sweet560/dsh-plugin-deepseek-chat.git
cd dsh-plugin-deepseek-chat
node test/check-client.mjs
```

`test/check-client.mjs` is an offline self-check: it loads `lib/client.js` in `node:vm` with fake React/DOM/bridge objects and verifies slot registration, the right-sidebar dual path, the config layer, the auto-loop, the auto-pilot channel and the update flow — all sections `RESULT: PASS`.

| File | Purpose |
|---|---|
| `lib/client.js` | Browser half: panel, header overlay, right-sidebar card, settings page, auto-loop / auto-pilot, crash containment |
| `lib/index.js` | Host half (empty; provides the Loader entry) |
| `locale/{zh,en}.json` | Plugins-page title / description |
| `docs/login-persistence.md` | Persistent-partition patch guide |
| `test/check-client.mjs` | Offline self-check |

## Uninstall

```powershell
dsh plugin --profile desktop remove @tianyulinfeng1/dsh-plugin-deepseek-chat
```

## Author

- **Author**: 伍悦匿匿 (sweet560) — 437830488@qq.com
- GitHub https://github.com/sweet560 | Gitee https://gitee.com/wtt520wyl
- Mirror repo https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat

## License

[MIT](LICENSE)
