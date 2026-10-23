# 让「DeepSeek 聊天」在 DSH 重启后免登录

> **TL;DR** — DSH 桌面壳目前给内嵌浏览器的是**内存分区**，进程退出即清空 cookie，所以本插件每次重启都要重新登录。把 `resources/app.asar` 里 `lib/main.js` 的那行分区名改成**固定且带 `persist:` 前缀**的值（等长字节替换），登录一次后即可长期免登录。本文给出原因、完整步骤、脚本、验证与回滚方式。

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

两条语句**字节数完全相同**，因此可以直接在 `app.asar` 里做字节级替换：ASAR 头部记录的文件偏移与大小都不变（该构建的头部没有 `integrity` 字段，实测替换后正常启动）。

替换后的效果：

- 登录状态写入 `%APPDATA%\@deepseek-ai\dsh-desktop\Partitions\dsh-sidebar-browser-chat-v1\`；
- 重启 DSH 直接带着 cookie，不再扫码/输密码；
- 左侧栏「DeepSeek 聊天」和右侧栏内置浏览器**共用**这个分区，两边登录态一致。

---

## 3. 操作步骤（Windows）

> 适用于 DSH Desktop `0.2.1-rc.2`（在 Windows 上验证）。其他版本请先按第 5 节确认待替换的字符串仍然存在，再动手。

1. **完全退出 DSH**：托盘图标右键 → 退出（只关窗口是隐藏到托盘，文件仍被占用）。
2. **备份** `F:\DeepSeek Harness\resources\app.asar`（脚本会自动生成带时间戳的 `.bak-*`，也可以手动复制一份）。
3. 用下面的脚本做字节替换（Node 20+）。
4. 重新启动 DSH，打开「DeepSeek 聊天」，登录一次。
5. 退出 DSH 再打开，验证仍是登录状态。

### 脚本

保存为 `patch-dsh-persistent-partition.mjs`，然后：

```powershell
node patch-dsh-persistent-partition.mjs "F:\DeepSeek Harness\resources\app.asar"
```

```js
// patch-dsh-persistent-partition.mjs
// Byte-level replacement of DSH's per-guest in-memory browser partition with a
// fixed persist: partition, so chat logins survive an app restart.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const ORIGINAL = "partition = `dsh-sidebar-browser-${randomUUID()}`;";
const PATCHED = "partition = `persist:dsh-sidebar-browser-chat-v1`;";

const asar = process.argv[2];
if (!asar || !existsSync(asar)) {
  console.error("usage: node patch-dsh-persistent-partition.mjs <path to app.asar>");
  process.exit(2);
}
if (ORIGINAL.length !== PATCHED.length) {
  console.error("statement lengths differ; refusing to patch");
  process.exit(1);
}

const buffer = readFileSync(asar);
// latin1 maps every byte to one character, so this round-trips unchanged bytes.
const text = buffer.toString("latin1");

if (text.includes(PATCHED)) {
  console.log("already patched:", asar);
  process.exit(0);
}
const first = text.indexOf(ORIGINAL);
if (first === -1) {
  console.error("target statement not found; this DSH build differs — inspect lib/main.js first");
  process.exit(1);
}
if (text.indexOf(ORIGINAL, first + 1) !== -1) {
  console.error("target statement appears more than once; aborting");
  process.exit(1);
}

const backup = `${asar}.bak-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
copyFileSync(asar, backup);

const patched = Buffer.from(
  text.slice(0, first) + PATCHED + text.slice(first + ORIGINAL.length),
  "latin1"
);
if (patched.length !== buffer.length) {
  console.error("patched size differs from the original; aborting (restore from backup)");
  process.exit(1);
}
writeFileSync(asar, patched);
console.log("patched:", asar);
console.log("backup :", backup);
```

### 验证是否生效

```powershell
# 1) 登录一次后，确认分区目录和 cookie 已落盘
Get-Item "$env:APPDATA\@deepseek-ai\dsh-desktop\Partitions\dsh-sidebar-browser-chat-v1\Cookies" |
  Select-Object FullName, Length, LastWriteTime
```

- 有该文件且大小非 0 → 分区已持久化；
- 重启 DSH 打开聊天面板仍是登录态 → 完成。

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
- **版本相关**：字符串在不同 DSH 版本可能变化。补丁前可先确认原文存在：

  ```powershell
  # 用任意支持字节搜索的工具，或先解出 lib/main.js 检查
  node -e "const fs=require('fs');const s=fs.readFileSync(process.argv[1]).toString('latin1');console.log(s.includes('dsh-sidebar-browser-${randomUUID()}'))" "F:\DeepSeek Harness\resources\app.asar"
  ```

- **等长是硬性要求**：脚本会校验长度，不等长直接中止（修改长度会破坏 ASAR 头部记录的偏移）。若要自定义分区名，必须把名字凑成与 `${randomUUID()}` 等长（`persist:` + `dsh-sidebar-browser-` + 7 字符）。
- **未来版本**：如果 DSH 官方把 guest 分区改成 `persist:`，就不再需要本补丁——升级后先检查原文是否还在，不在即说明已内置支持。
- **共享分区**：补丁对**所有**浏览器 guest 生效，左侧聊天面板与右侧内置浏览器会共用同一个持久分区（这是有意为之：两边登录态一致）。若你希望两者隔离，需要改为按 workspace 区分的固定分区名（保持总长度不变）。

---

## 6. 与 DSH 账号的关系

DSH 自身的登录是 platform.deepseek.com 的 OAuth token（`~/.dsh/.credentials.yaml`），与 chat.deepseek.com 的 httpOnly 会话 cookie **不同源**，没有官方兑换入口，因此本方案的实际效果是：

> 首次用你的 DeepSeek 账号登录一次 chat.deepseek.com，之后长期记住、点开即用；而不是让网页版复用 DSH 的 token。

---

*本文档基于 DSH Desktop `0.2.1-rc.2` / Windows 验证；其他版本请以第 5 节的检查结果为准。*
