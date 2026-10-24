# 让「DeepSeek 聊天」在 DSH 重启后免登录

> **TL;DR** — DSH 桌面壳目前给内嵌浏览器的是**内存分区**，进程退出即清空 cookie，所以本插件每次重启都要重新登录。把 `resources/app.asar` 里 `lib/main.js` 的那行分区名改成**固定且带 `persist:` 前缀**的值（等长字节替换），登录一次后即可长期免登录。仓库自带补丁脚本 [`docs/patch-dsh-persistent-partition.cjs`](patch-dsh-persistent-partition.cjs)，已适配 `0.2.1-rc.3` 的逐文件 ASAR integrity，支持幂等重跑、自动备份、全量校验与 `--dry-run`。

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
// 修改前（36 字符的分区名）
partition = `dsh-sidebar-browser-${randomUUID()}`;

// 修改后（同样 36 字符，整条语句等长）
partition = `persist:dsh-sidebar-browser-chat-v1`;
```

两条语句**字节数完全相同**，因此可以直接在 `app.asar` 里做字节级替换：ASAR 头部记录的文件偏移与大小都不变。

> **`0.2.1-rc.3` 起的新变化**：该构建的 ASAR 头部为每个文件记录了 SHA256 `integrity`（`hash` + 按 `blockSize` 分块的 `blocks`），Electron 读取文件时会校验；只替换字节而不同步哈希会触发 `ASAR Integrity Violation` 并强制退出。仓库脚本会自动重算并更新 `lib/main.js` 的 integrity 字段，并在写入前全量核对所有文件的块哈希。

替换后的效果：

- 登录状态写入 `%APPDATA%\@deepseek-ai\dsh-desktop\Partitions\dsh-sidebar-browser-chat-v1\`；
- 重启 DSH 直接带着 cookie，不再扫码/输密码；
- 左侧栏「DeepSeek 聊天」和右侧栏内置浏览器**共用**这个分区，两边登录态一致。

---

## 3. 操作步骤（Windows）

> 适用于 DSH Desktop `0.2.1-rc.2` / `0.2.1-rc.3`（在 Windows 上验证）。其他版本请先按第 5 节用 `--dry-run` 确认待替换的字符串仍然存在，再动手。

1. **完全退出 DSH**：托盘图标右键 → 退出（只关窗口是隐藏到托盘，文件仍被占用）。
2. **备份** `F:\DeepSeek Harness\resources\app.asar`（脚本会自动生成带时间戳的 `.bak-*`，也可以手动复制一份）。
3. 用仓库自带的补丁脚本做字节替换（Node 18+；脚本会先做全量体检，失败则不改文件）。
4. 重新启动 DSH，打开「DeepSeek 聊天」，登录一次。
5. 退出 DSH 再打开，验证仍是登录状态。

### 脚本

仓库自带补丁脚本：[`docs/patch-dsh-persistent-partition.cjs`](patch-dsh-persistent-partition.cjs)（Node 18+，零依赖）。

```powershell
# 打补丁（写入前自动备份为 app.asar.bak-<时间戳>）
node docs/patch-dsh-persistent-partition.cjs "F:\DeepSeek Harness\resources\app.asar"

# 只预演、不写盘
node docs/patch-dsh-persistent-partition.cjs "F:\DeepSeek Harness\resources\app.asar" --dry-run
```

脚本行为：

- **等长替换**：校验两条语句字节数一致，补丁后文件大小不变，ASAR 偏移不受影响；
- **integrity 同步**：检测到 `lib/main.js` 带 `integrity` 元数据时（`0.2.1-rc.3+`），重算 SHA256 并同步更新 `hash` 与 `blocks`；
- **幂等**：已打过补丁时直接返回 `0`，可反复执行；
- **自动备份**：写入前生成带时间戳的 `app.asar.bak-*`；
- **全量校验**：遍历 ASAR 头部所有文件的 integrity 分块并逐块核对，任一失败则拒绝写入；补丁完成后再次全量校验并打印 `integrity: N file(s) verified, 0 failed`；
- **`--dry-run`**：完整跑一遍检查并给出结论，但不修改文件；
- **安全兜底**：目标语句不存在/出现多次、长度不一致、头部 JSON 长度变化、多块 integrity 布局等情况一律中止并返回非 0。

退出码：`0` 成功或已是补丁态，`1` 拒绝/校验失败，`2` 参数错误。

### 验证是否生效

```powershell
# 1) 登录一次后，确认分区目录和 cookie 已落盘
Get-Item "$env:APPDATA\@deepseek-ai\dsh-desktop\Partitions\dsh-sidebar-browser-chat-v1\Cookies" |
  Select-Object FullName, Length, LastWriteTime
```

- 有该文件且大小非 0 → 分区已持久化；
- 重启 DSH 打开聊天面板仍是登录态 → 完成。

补丁脚本自身会打印校验结果（`integrity: … 0 failed`）。补充说明：`0.2.1-rc.3` 的 Electron fuse 中 `EnableEmbeddedAsarIntegrityValidation` 为关闭状态，因此 exe 内嵌的 ASAR 头部哈希不会被校验；但 ASAR 的逐文件 integrity 在读取时会被 Electron 校验，所以脚本仍必须同步 `lib/main.js` 的哈希。

### 回滚

```powershell
# 先完全退出 DSH
Copy-Item "F:\DeepSeek Harness\resources\app.asar.bak-<时间戳>" "F:\DeepSeek Harness\resources\app.asar" -Force
```

磁盘上的 `Partitions\dsh-sidebar-browser-chat-v1\` 数据不会被删，之后重新打补丁仍可复用。

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
- **版本相关**：字符串在不同 DSH 版本可能变化。补丁前先用 `--dry-run` 检查：

  ```powershell
  node docs/patch-dsh-persistent-partition.cjs "F:\DeepSeek Harness\resources\app.asar" --dry-run
  ```

  输出 `dry-run: patch would be applied` 表示可打补丁；`target statement not found` 表示该版本已变化或官方已内置 `persist:`，请先解出 `lib/main.js` 检查。

- **等长是硬性要求**：脚本会校验长度，不等长直接中止（修改长度会破坏 ASAR 头部记录的偏移）。若要自定义分区名，必须把名字凑成与 `${randomUUID()}` 等长（`persist:` + `dsh-sidebar-browser-` + 7 字符）。
- **未来版本**：如果 DSH 官方把 guest 分区改成 `persist:`，就不再需要本补丁——升级后先检查原文是否还在，不在即说明已内置支持。
- **共享分区**：补丁对**所有**浏览器 guest 生效，左侧聊天面板与右侧内置浏览器会共用同一个持久分区（这是有意为之：两边登录态一致）。若你希望两者隔离，需要改为按 workspace 区分的固定分区名（保持总长度不变）。

---

## 6. 与 DSH 账号的关系

DSH 自身的登录是 platform.deepseek.com 的 OAuth token（`~/.dsh/.credentials.yaml`），与 chat.deepseek.com 的 httpOnly 会话 cookie **不同源**，没有官方兑换入口，因此本方案的实际效果是：

> 首次用你的 DeepSeek 账号登录一次 chat.deepseek.com，之后长期记住、点开即用；而不是让网页版复用 DSH 的 token。

---

*本文档基于 DSH Desktop `0.2.1-rc.2` / `0.2.1-rc.3` / Windows 验证；其他版本请先运行 `--dry-run` 检查，再决定是否动手。*
