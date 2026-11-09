# Changelog

All notable changes to this project are documented here.

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
