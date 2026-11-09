# Changelog

All notable changes to this project are documented here.

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
