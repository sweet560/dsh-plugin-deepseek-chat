# 让「DeepSeek 聊天」在 DSH 重启后免登录

> **TL;DR** — DSH 桌面壳目前给内嵌浏览器的是**内存分区**，进程退出即清空 cookie，所以本插件每次重启都要重新登录。把 `resources/app.asar` 里 `lib/main.js` 的那行分区名改成**固定且带 `persist:` 前缀**的值（等长字节替换 + **同步 ASAR 逐文件 SHA256 integrity**），登录一次后即可长期免登录。本文给出原因、完整步骤、脚本、验证与回滚方式。
>
> **版本核对**：已在 DSH Desktop `0.2.2-rc.1`（`app.asar` 版本 `0.2.2-rc.1`，构建提交 `c59d10a`）中核对并**实际应用**：`DesktopBrowserGuests.acquire()` 原本使用 `dsh-sidebar-browser-${randomUUID()}`、无 `persist:` 前缀；该构建 **22102 个文件全部带 integrity**，因此必须使用会重算哈希的 `patch-dsh-persistent-partition.cjs`，纯字节替换会导致 DSH 重启崩溃。补丁后全量校验 20519 文件、0 失败。`dshDesktop.browser` 的 `protocolVersion` 仍为 `1`，`acquire()` 仍返回 `{ lease, partition }`。插件 v1.1.1 要求 DSH ≥ `0.2.2-rc.1`。
>
> **两件不同的事，请勿混淆**：
> - **切换面板/会话回来就要重新扫码** → 这是插件 v1.1.0 的回归（分区被绑到异步账号状态），**v1.1.1 已修复**，无需改 `app.asar`，见 README「关于免扫码的真相」。
> - **重启 DSH 后要重新扫码** → 这才是本文补丁要解决的问题（内存分区不落盘），需要改 `app.asar`。
> - **想让网页直接复用 DSH 已登录账号、完全不扫码** → 纯插件做不到（两套 token、渲染层无 token/cookie 通道、归档中 `chat.deepseek.com` 零引用），本文补丁也做不到，它只保留首次扫码后的网页 cookie。

---

## 1. 现象与原因

**现象**：在「DeepSeek 聊天」面板登录 chat.deepseek.com 后，关掉 DSH 再打开，又回到登录页。

**原因**：DSH 桌面主进程给每个浏览器 guest 分配的是**内存分区**：

```js
// resources/app.asar → lib/main.js（DesktopBrowserGuests.acquire）
let partition = this.partitions.get(workspace);
if (partition === void 0) {
    partition = `dsh-sidebar-browser-${randomUUID()}`;   // ← 没有 persist: 前缀
    this.configureSession(session.fromPartition(partition));
    this.partitions.set(workspace, partition);
}
```

Electron 的 `partition` 只有在带 `persist:` 前缀时才会把 cookie、localStorage、IndexedDB 等写到磁盘：

| 分区名 | 存储位置 | 进程退出后 |
|---|---|---|
| `dsh-sidebar-browser-<uuid>` | 内存 | **清空** |
| `persist:dsh-sidebar-browser-chat-v1` | `…/Partitions/dsh-sidebar-browser-chat-v1/` | **保留** |

而且这里的 `randomUUID()` 每次启动都不同，所以连"跨进程复用同一分区"都做不到。

**为什么插件自己解决不了**：分区名由桌面主进程决定，渲染层只能使用桥（`window.dshDesktop.browser.acquire()`）返回的 `partition`，插件无权指定。因此只能在主进程侧改这一行。

---

## 2. 解决思路

把上面那行改成固定名字 + `persist:` 前缀：

```js
// 修改前（分区名 36 字符，整条语句 50 字节）
partition = `dsh-sidebar-browser-${randomUUID()}`;

// 修改后（分区名同为 36 字符，整条语句同为 50 字节）
partition = `persist:dsh-sidebar-browser-chat-v1`;
```

两条语句**字节数完全相同**（均 50 字节），因此可以在 `app.asar` 里做等长字节替换，ASAR 头部记录的文件偏移与大小都不变。

> **⚠️ 关键（0.2.1-rc.3+，含当前 0.2.2-rc.1）：必须同步 ASAR integrity**
> 该构建的 ASAR 头部为**每个文件**记录了 SHA256 `integrity`（`hash` + 按 `blockSize` 分块的 `blocks`），Electron 读取时会校验。实测 0.2.2-rc.1 的 `app.asar` 有 **22102 个文件带 integrity**（`lib/main.js` 单块 4 MiB）。
> **只替换字节而不重算并重填 `lib/main.js` 的哈希，DSH 重启会直接 `ASAR Integrity Violation` 退出。** 因此不要用「纯字节替换」脚本；必须使用下方会同步哈希并做全量校验的 `patch-dsh-persistent-partition.cjs`（来自上游仓库 sweet560/dsh-plugin-deepseek-chat）。

替换后的效果：

- 登录状态写入 `%APPDATA%\@deepseek-ai\dsh-desktop\Partitions\dsh-sidebar-browser-chat-v1\`；
- 重启 DSH 直接带着 cookie，不再扫码/输密码；
- 左侧栏「DeepSeek 聊天」和右侧栏内置浏览器**共用**这个分区，两边登录态一致。

---

## 3. 操作步骤（Windows）

> 适用于 DSH Desktop `0.2.2-rc.1`（在 Windows 上核对并应用；`0.2.1-rc.2` / `0.2.1-rc.3` 亦适用）。其他版本请先按第 5 节用 `--dry-run` 确认待替换的字符串存在、且 integrity 校验能通过。
>
> 注意：`partitions` 是**进程内** Map，按传入 `acquire()` 的 workspace 字符串缓存；`release()` 只销毁 guest、不清 cookie。本插件 v1.1.1 起 workspace 恒为 `panel:deepseek-chat`，补丁后的固定 `persist:` 分区在**同一进程内切换面板**和**重启后同名分区**都能保留 cookie。

1. **完全退出 DSH**：托盘图标右键 → 退出（只关窗口是隐藏到托盘，`app.asar` 仍被独占锁定，脚本会写入失败）。
2. **备份** `F:\DeepSeek Harness\resources\app.asar`（脚本会自动生成带时间戳的 `.bak-*`）。
3. 用仓库自带的 [scripts/patch-dsh-persistent-partition.cjs](../scripts/patch-dsh-persistent-partition.cjs) 打补丁（Node 18+，零依赖），见下。
4. 重新启动 DSH，打开「DeepSeek 聊天」，**扫码登录一次**。
5. 退出 DSH 再打开，验证仍是登录状态——此后不再需要扫码。

### 脚本（唯一推荐）

上游仓库配套的 `patch-dsh-persistent-partition.cjs` 已适配逐文件 ASAR integrity，支持 `--dry-run`、幂等重跑、自动备份与**全量哈希校验**：

```powershell
cd dsh-plugin-deepseek-chat
$asar = "F:\DeepSeek Harness\resources\app.asar"

# 1) 先只看不改：确认目标唯一、等长、全量 integrity 无失败
node scripts/patch-dsh-persistent-partition.cjs $asar --dry-run

# 2) 完全退出 DSH 后应用（自动备份；重算 lib/main.js 的 SHA256 并同步头部）
node scripts/patch-dsh-persistent-partition.cjs $asar

# 3) 已打过补丁时再跑也安全（幂等，会再次全量校验）
node scripts/patch-dsh-persistent-partition.cjs $asar --dry-run
```

成功输出形如：

```
dry-run: patch would be applied
integrity: 20519 file(s) verified, 0 failed
```

脚本行为：
- **等长替换**：两条语句均 50 字节，补丁后文件大小不变，ASAR 偏移不受影响；
- **integrity 同步（关键）**：检测 `lib/main.js` 的 `integrity`，用补丁后的字节重算 SHA256，替换头部 JSON 中的 `hash`/`blocks`（长度不变）；多块布局会拒绝而不是猜测；
- **全量校验**：写入前后遍历所有文件的 integrity 分块逐块核对，任一失败即拒绝写入（实测 0.2.2-rc.1 为 20519 个文件、0 失败）；
- **幂等**：已是补丁态直接返回 0 并复验；
- **自动备份**：写入前生成 `app.asar.bak-<时间戳>`；
- **安全兜底**：目标不存在/出现多次、长度不一致、头部 JSON 长度变化、多块 integrity 等情况一律中止。

退出码：`0` 成功或已是补丁态，`1` 拒绝/校验失败，`2` 参数错误。

> `scripts/patch-dsh-persistent-partition.mjs` 是早期**纯字节替换**版本，缺少 integrity 同步，会让 0.2.1-rc.3+ 的 DSH 重启崩溃，已废弃（运行即报错退出）。**不要使用**。

### 验证是否生效

```powershell
# 1) 补丁本身：再跑一次 dry-run，应显示 already patched + 全量 integrity 0 failed
node scripts/patch-dsh-persistent-partition.cjs "F:\DeepSeek Harness\resources\app.asar" --dry-run

# 2) 登录一次后，确认分区目录和 cookie 已落盘
Get-Item "$env:APPDATA\@deepseek-ai\dsh-desktop\Partitions\dsh-sidebar-browser-chat-v1\Cookies" |
  Select-Object FullName, Length, LastWriteTime
```

- `already patched` + `integrity: … 0 failed` → ASAR 完整性没问题，重启不会崩；
- `Cookies` 存在且非 0 → 分区已持久化；
- 重启 DSH 打开聊天面板仍是登录态 → 完成。

### 回滚

```powershell
# 先完全退出 DSH
Copy-Item "F:\DeepSeek Harness\resources\app.asar.bak-<时间戳>" "F:\DeepSeek Harness\resources\app.asar" -Force
```

备份是**补丁前**的完整字节副本（含原始 integrity），直接覆盖即可恢复。磁盘上的 `Partitions\dsh-sidebar-browser-chat-v1\` 数据不会被删，之后重新打补丁仍可复用。

---

## 4. 其他平台路径

| 平台 | `app.asar` | 分区数据目录 |
|---|---|---|
| Windows | `…\DeepSeek Harness\resources\app.asar` | `%APPDATA%\@deepseek-ai\dsh-desktop\Partitions\…` |
| macOS | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` | `~/Library/Application Support/@deepseek-ai/dsh-desktop/Partitions/…` |
| Linux | `<安装目录>/resources/app.asar` | `~/.config/@deepseek-ai/dsh-desktop/Partitions/…` |

macOS 上若应用有代码签名，修改 `app.asar` 可能破坏签名校验，需要自行重新签名或使用未签名构建；替换前请先备份。

---

## 5. 注意事项与风险

- **非官方修改**：改动已安装应用的 `app.asar` 不在 DSH 支持范围内，出问题请用备份回滚；请在动手前确认你接受这个风险。
- **DSH 升级会覆盖 `app.asar`**：每次更新后需要重新执行一次本补丁；`Partitions` 目录里的登录数据不会丢，重新打补丁后照旧免登录。
- **版本相关 + integrity 是硬性要求**：字符串在不同 DSH 版本可能变化，且 `0.2.1-rc.3+` 起 ASAR 带逐文件 SHA256 integrity。补丁前**必须**用 `--dry-run` 全量体检：

  ```powershell
  node scripts/patch-dsh-persistent-partition.cjs "F:\DeepSeek Harness\resources\app.asar" --dry-run
  ```

  输出 `dry-run: patch would be applied` + `integrity: … 0 failed` 才可打；`target statement not found` 表示该版本已变化或官方已内置 `persist:`。**千万不要用纯字节替换脚本**，否则重启必崩。
- **等长是硬性要求**：脚本会校验长度，不等长直接中止（修改长度会破坏 ASAR 头部记录的偏移）。若要自定义分区名，必须把名字凑成与 `${randomUUID()}` 等长（`persist:` + `dsh-sidebar-browser-` + 7 字符）。
- **未来版本**：如果 DSH 官方把 guest 分区改成 `persist:`，就不再需要本补丁——升级后先检查原文是否还在，不在即说明已内置支持。
- **共享分区**：补丁对**所有**浏览器 guest 生效，左侧聊天面板与右侧内置浏览器会共用同一个持久分区（这是有意为之：两边登录态一致）。若你希望两者隔离，需要改为按 workspace 区分的固定分区名（保持总长度不变）。

---

## 6. 与 DSH 账号的关系（v1.1.1 核对）

DSH 自身的登录是 platform.deepseek.com 的 OAuth 授权（Host `deepseekAccount` 服务，`x-dsh-auth-token`），而 chat.deepseek.com 用的是**站点自带的 Token**（`api/v0/users/current` 无 token 返回 `40002 Missing Token`），两者不同源、不同凭据，归档中 `chat.deepseek.com` 零引用、**没有任何官方兑换/SSO/cookie 注入入口**。因此本方案的实际效果是：

> 首次用你的 DeepSeek 账号登录一次 chat.deepseek.com，之后长期记住、点开即用；而不是让网页版复用 DSH 的 token。

**渲染层也拿不到 DSH token**：`globalThis.dshDesktop` 只暴露 `browser.acquire/release/onOpenRequested` 等，没有 `getAuthToken`、写 cookie、打开 Platform 取 token 的 API；`getAuthToken()` 只存在于桌面壳内嵌 Platform 页（`usage`/`top_up`）的专用 preload 且受主帧 + origin 限制。`browserAcquire` IPC 只按 workspace 分配分区/租约，`configureSession()` 不注入凭据。所以**纯插件无法免扫码**。

**v1.1.1 起，本插件的账号状态条仅作展示**：读取 `ctx.remote.account.getState()` / `getProfile()` 显示昵称与登录状态，但**绝不参与 guest 分区或生命周期**。v1.1.0 曾把分区绑到账号状态，导致 `getState()` 瞬时失败就换分区、每次切回面板都要重新扫码——这是已修复的回归，不是「账号同步」的应有行为。

本文的持久分区补丁负责「网页 cookie 不因**重启**丢失」；v1.1.1 的固定分区负责「网页 cookie 不因**切换面板**丢失」。两者都保留首次扫码后的网页会话，都不能把 DSH token 变成网页登录态。

---

*本文档基于 DSH Desktop `0.2.2-rc.1` / Windows 核对（原文字符串仍在；早期验证于 `0.2.1-rc.2`）；其他版本请以第 5 节的检查结果为准。*
