# v1.4.1 发布说明 — 自定义聊天网页 URL

## 一句话
设置页新增「聊天网页 URL」输入框，默认 `https://chat.deepseek.com/`；填入 `https://www.doubao.com/chat/` 即把内嵌网页切到豆包，留空恢复默认。改完即时生效，无需重启。

## 需求来源
m00002：chat.deepseek.com 网页端限制多，希望在设置界面自定义聊天 URL，可在 DeepSeek 与豆包网页版之间切换。

## 实现要点
1. **配置层**：新增 `chatUrl`（默认 `https://chat.deepseek.com/`），纳入 `DEFAULTS` / `readConfig` 校验 / `writeConfig` 合并 / 持久化 / 订阅通知。
2. **白名单**：新增独立 `normalizeChatUrl` + `CUSTOM_URL_HOSTS`（`chat.deepseek.com`、`www.doubao.com`、`doubao.com`），只要求 https、无凭据、无显式端口。**刻意不碰** `parseChatUrl`/`parsePopupUrl`——它们是会话记忆与弹窗白名单，原有保证零改动。
3. **设置页**：第一张卡片内加一个输入框（`data-dsh-plugin-deepseek-chat="chat-url"`），中英文案齐全；卡片总数仍为 5。
4. **导航**：配置 URL 为 DeepSeek 时保留原「恢复上次会话」行为；切到豆包时直接加载配置 URL，避免旧的 DeepSeek 会话记忆覆盖。通过 `subscribeConfig` 即时切换，无需手动重试。
5. **测试**：新增 normalizeChatUrl 合法/非法用例、chatUrl 读写持久化用例、设置页输入框存在性断言；A–R 全段 `RESULT: PASS`。

## 限制
- 只接受白名单主机（DeepSeek / 豆包），任意第三方域名会被拒绝并回退默认，避免把任意站点塞进 webview。
- client bundle 进程启动时缓存；若为本地安装，仍需从托盘彻底退出 DSH 再重启才会加载新 bundle。

## 版本同步
`package.json`（version / description / files 加入本文件）、`lib/client.js`（PLUGIN_VERSION + 双语 infoSummary）、`README.md` / `README.en.md`、`CHANGELOG.md`、`locale/zh.json` / `locale/en.json`、本文件。

## 自检
`node test/check-client.mjs`（`RESULT: PASS`）。
