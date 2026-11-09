# dsh-plugin-deepseek-chat v1.1.2 发布说明

**DeepSeek Harness（DSH）桌面版侧栏「DeepSeek 聊天」面板 —— 修复 v1.1.1 的 web boot 启动失败（duplicate factory registration）。**

本次是一个**紧急修复版本**：v1.1.1 上线后，DSH 桌面版在启动阶段会因为本插件的 client bundle 工厂 id 与包名不一致，重复执行 bundle、抛出 `duplicate factory registration`，最终报 `Error: web boot: 1 entry did not activate`，导致整个页面启动失败。v1.1.2 只修正这一处 id 并加上回归断言，其余功能与 v1.1.1 完全一致。

## Requires（环境要求）

| 项 | 要求 |
|---|---|
| DSH Desktop | `>= 0.2.2-rc.1`（含 `0.2.2-rc.1`） |
| Node.js | `>= 20` |
| 平台 | Windows / macOS / Linux 桌面壳 |

## ⚠️ 重点：修复 `crash-2026-11-09T08-27-01-314Z-web-boot.log` 中的 web boot 启动失败

### 崩溃日志

用户提供的崩溃日志文件：

```
C:\Users\Administrator\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-2026-11-09T08-27-01-314Z-web-boot.log
```

日志头部记录的运行环境（原文）：

```
time: 2026-11-09T08:27:01.314Z
source: web-boot
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1
win32 x64
electron 44.7.0
node 24.21.0
locale zh-CN
```

日志中的原始报错文本（原文）：

```
Error: web boot: 1 entry did not activate
@tianyulinfeng1/dsh-plugin-deepseek-chat: import failed (see console for the import error)
```

渲染进程（renderer）控制台中的原始报错（原文）：

```
client-modules: duplicate factory registration for "dsh-plugin-deepseek-chat" (bundle executed twice without invalidate?)
```

### 结论先行

这是 **v1.1.1 的打包回归**，与插件的业务逻辑（聊天面板、登录态、账号状态展示、崩溃隔离）无关。日志里 `dshmarket` 反复出现的 install / remove 只是**历史操作记录**，不是本次崩溃的原因；真正的原因是**工厂 id 没有跟着 npm 包名一起改**。

### 逐条根因链

1. **v1.1.1 改了包名**：为了在 npm 上以项目自己拥有的名字发布，v1.1.1 把 `package.json` 的 `name` 从无 scope 的短名 `dsh-plugin-deepseek-chat` 改成了带 scope 的完整包名 `@tianyulinfeng1/dsh-plugin-deepseek-chat`（`cordis.patch.yml` 也同步了这个名字）。
2. **工厂 id 没跟着改**：`lib/client.js` 里通过 `window.__ModuleLoader__.load({ id: ..., factory: ... })` 注册浏览器半侧的模块工厂，这个 `id` 在 v1.1.1 中仍然是旧的短名 `dsh-plugin-deepseek-chat`。于是出现了「client 图行 id 用带 scope 包名、工厂注册 id 用短名」的不一致。
3. **Host 用包名作图行 id**：DSH 的 `dsh-client-modules` Host 半侧以 `package.json` 的 `name`（即带 scope 的完整包名）作为 client 图中该包那一行的 id。
4. **执行后检查失败**：`arrive()` 执行完某个 bundle 脚本之后，会检查 `factories.has(<行 id>)`，用来确认「这个包确实注册过工厂」。由于工厂实际只注册在短名 `dsh-plugin-deepseek-chat` 下，对 `@tianyulinfeng1/dsh-plugin-deepseek-chat` 的检查结果是 `false`，Host 便判定该包**没有注册**。
5. **重复执行同一 bundle**：基于「没有注册」的判断，Host 把同一个 bundle 脚本**再执行一次**，试图让它完成注册。
6. **二次注册抛错**：第二次执行时，短名 id `dsh-plugin-deepseek-chat` 在工厂表里已经存在，于是抛出 `client-modules: duplicate factory registration for "dsh-plugin-deepseek-chat" (bundle executed twice without invalidate?)`。
7. **entry 未激活、页面启动失败**：该包因此被记为 `@tianyulinfeng1/dsh-plugin-deepseek-chat: import failed (see console for the import error)`；web boot 统计到「1 个 entry 未激活」，抛出 `Error: web boot: 1 entry did not activate`。由于 web boot 是页面启动的总入口，**整个页面启动失败**、界面打不开。

一句话：`package.json` 的 `name` 是 Host 认的名字，工厂 id 是 bundle 自己报的名字；两者对不上，Host 就以为包没装好、把脚本跑了两遍，第二遍自己把自己撞死了。

### 修改点与原理

**改了哪里**：只修改 `lib/client.js` 中 `window.__ModuleLoader__.load({ id: ... })` 的工厂 `id`，把它从短名 `dsh-plugin-deepseek-chat` 改成与 `package.json` 的 `name` **完全一致**的：

```
@tianyulinfeng1/dsh-plugin-deepseek-chat
```

没有改动包内的任何其他运行时逻辑。

**为什么这样能解决**：工厂 id 与 client 图行 id 对齐之后，`arrive()` 在 bundle 执行完做 `factories.has(<行 id>)` 检查时结果为 `true`，Host 认为该包已经正常注册，**不会**再重复执行同一份 bundle 脚本；没有第二次执行，就不会有第二次注册，也就不会抛出 `duplicate factory registration`，该 entry 正常激活，web boot 顺利完成。

**回归防护**：`test/check-client.mjs` 新增了一条断言——**「工厂 id 必须等于 `package.json` 的 `name`」**。以后任何人再改包名却忘了同步 `lib/client.js` 的工厂 id，离线自检会立刻失败，同样的回归不会再被带进发布包。

## What's fixed（修复内容）

- 修复 v1.1.1 因 client bundle 工厂 id 与 npm 包名不一致导致的 web boot 启动失败（`duplicate factory registration` / `1 entry did not activate`），详见上面的重点段落。
- 新增「工厂 id == `package.json` 的 `name`」回归断言，防止同类打包回归再次发布。
- v1.1.1 已修复的登录态问题（固定 guest 分区、账号状态仅展示、崩溃隔离等）在 v1.1.2 中保持不变。

## What changed（逐文件改动）

| 文件 | 改动 |
|---|---|
| `lib/client.js` | 把 `window.__ModuleLoader__.load({ id: ... })` 的工厂 id 从 `dsh-plugin-deepseek-chat` 改为 `@tianyulinfeng1/dsh-plugin-deepseek-chat`，与 `package.json` 的 `name` 完全一致；源码注释补充了「id 必须等于包名，否则 Host 会重复执行 bundle」的说明。 |
| `test/check-client.mjs` | 新增回归断言：读取 `package.json` 的 `name`，断言 client bundle 注册的工厂 id 与之相等；离线自检仍为 35 项，全部通过。 |
| `package.json` | 版本号 `1.1.1` → `1.1.2`（包名、`engines`、安装路由均不变）。 |
| `CHANGELOG.md` | 新增 `1.1.2` 章节，重点记录崩溃日志、根因、修改点、验证与打包。 |
| `README.md` / `README.en.md` | 当前版本改为 v1.1.2；功能/版本历史补充 web boot 崩溃修复说明。 |
| `docs/RELEASE_NOTES_v1.1.2.md` | 本文件，完整发布说明。 |

> 注：`lib/client.js` 与 `test/check-client.mjs` 的改动由发布流程的代码负责人完成，本文档仅作如实记录。

## Verification（验证结果）

- **离线自检 35 项全部通过**：`node test/check-client.mjs`，输出 `RESULT: PASS`；其中包含新增的「工厂 id 必须等于 `package.json` 的 `name`」回归断言。
- **全量一致性扫描**：对当前 DSH profile 下全部 **30 个 web client bundle** 逐一核对「工厂 id / 包名」一致性，结果 **0 处不匹配**，确认不存在其他同类隐患。
- 崩溃日志中复现路径已按上述根因链逐条对照：修复后 `arrive()` 不再重复执行 bundle，`duplicate factory registration` 与 `1 entry did not activate` 不再出现。

## Upgrade（如何升级）

> 建议先退出 DSH 桌面版再升级，升级完成后重新启动。已从 v1.1.1（或更早版本）安装的，直接覆盖安装即可；也可先 `remove` 再 `add`。

### 方式一：npm（推荐）

```powershell
dsh plugin --profile desktop remove @tianyulinfeng1/dsh-plugin-deepseek-chat
dsh plugin --profile desktop add @tianyulinfeng1/dsh-plugin-deepseek-chat
```

插件页「安装第三方插件」里也可以直接填包名 `@tianyulinfeng1/dsh-plugin-deepseek-chat`（会拉取最新版本 `1.1.2`）。

### 方式二：GitHub

```powershell
dsh plugin --profile desktop add github:sweet560/dsh-plugin-deepseek-chat
```

或在插件页「安装第三方插件」中填入 `github:sweet560/dsh-plugin-deepseek-chat` / `https://github.com/sweet560/dsh-plugin-deepseek-chat`。

### 方式三：Gitee 镜像

```powershell
dsh plugin --profile desktop add https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat
```

或在插件页「安装第三方插件」中填入 Gitee 镜像地址 `https://gitee.com/wtt520wyl/dsh-plugin-deepseek-chat`。

### 方式四：本地 tgz / 目录

```powershell
dsh plugin --profile desktop add file:"<dsh-plugin-deepseek-chat-1.1.2.tgz 的绝对路径>"
```

装完打开 **插件 → 已安装插件**，确认「DeepSeek 聊天」处于启用状态，并确认版本显示为 `1.1.2`。

## Assets（发布产物）

- `dsh-plugin-deepseek-chat-1.1.2.tgz` —— 完整可安装的 npm / bundle 包（沿用 v1.1.1 的 Release 附件命名；`npm pack` 对 scoped 包的原生输出名为 `tianyulinfeng1-dsh-plugin-deepseek-chat-1.1.2.tgz`）。
- `Source code (zip / tar.gz)` —— 由 GitHub / Gitee 自动生成的源码归档。

## Honest limitation（诚实限制）

沿用 v1.1.1 的源码结论：**纯插件无法让 `chat.deepseek.com` 复用 DSH 已登录的账号、做不到免扫码**。DSH 桌面版用的是 platform.deepseek.com 的 `x-dsh-auth-token`，网页版用的是站点自带的 Token；渲染层桥 `globalThis.dshDesktop` 没有读 token / 写 cookie / 打开 Platform 取 token 的 API，归档里也没有 SSO 或 cookie 注入入口。因此首次仍需在网页里扫码登录一次。可选的「持久分区补丁」（见 [login-persistence.md](login-persistence.md)）只能让这次登录的 cookie 在重启 DSH 后保留，并不能把 DSH token 兑换成网页登录态。
