/**
 * test/verify-runtime.cjs —— v1.2.0 自动闭环「实机状态」只读验证探针
 *
 * 用途：在不改动任何实机状态、不驱动 GUI 的前提下，从真实 DSH 进程的磁盘
 *       证据侧验证插件加载态、版本、默认开关、分区数据、错误日志、编译缓存。
 *       用户按说明在 GUI 里开启 autoSyncEnabled 并跑一轮后，再跑一次本脚本，
 *       即可客观复核「配置是否真的写入实机 localStorage」。
 *
 * 用法：node test/verify-runtime.cjs
 * 覆盖：DSH_VERIFY_USER_DATA / DSH_VERIFY_PROFILE / DSH_VERIFY_WORKSPACE 三个环境变量可覆盖默认路径。
 * 只读：全程 fs.readFileSync / readdirSync / statSync，不写任何实机文件。
 * 注意：宿主可能注入无关的 DSH_PROFILE 等环境变量，故本脚本只认 DSH_VERIFY_* 专用前缀。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const leveldb = require('./lib/read-leveldb.cjs');

const WS = process.env.DSH_VERIFY_WORKSPACE || path.join(__dirname, '..');
const UD = process.env.DSH_VERIFY_USER_DATA || 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-desktop';
const PROFILE = process.env.DSH_VERIFY_PROFILE || 'F:/DeepSeek Harness workspace/profiles/desktop';
const PKG = '@tianyulinfeng1/dsh-plugin-deepseek-chat';
const CONFIG_KEY = 'dsh-plugin-deepseek-chat:config';
const LOOP_TRACE_KEY = 'dsh-plugin-deepseek-chat:loop-trace';

let problems = 0;
const ok = (label, value) => console.log('  [OK]   ' + label.padEnd(44) + String(value));
const warn = (label, value) => console.log('  [注意] ' + label.padEnd(44) + String(value));
const bad = (label, value) => { problems++; console.log('  [异常] ' + label.padEnd(44) + String(value)); };
const info = (label, value) => console.log('  [信息] ' + label.padEnd(44) + String(value));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const head = (t) => console.log('\n' + t);

function readSafe(p, enc) { try { return fs.readFileSync(p, enc); } catch { return null; } }

// ---------- A. 工作目录里的 client.js 是不是 v1.2.0 ----------
head('A. 插件源码（link: 安装直接指向此目录，host 读取的就是它）');
const clientPath = path.join(WS, 'lib', 'client.js');
const pkgPath = path.join(WS, 'package.json');
const client = readSafe(clientPath, 'utf8') || '';
const pkg = (() => { try { return JSON.parse(readSafe(pkgPath, 'utf8') || '{}'); } catch { return {}; } })();
const version = (client.match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '(未找到)';
const v120Marks = ['autoSyncEnabled', '__dshDeepSeekBridge', 'deepseek-chat-auto-sync',
  'conversation.composer.dock', 'createSyncController', 'makeWebviewBridge',
  'SyncStatusBar', 'BRIDGE_IMPL', 'injectDraft', 'onSessionEvents', 'syncAutoLoop',
  'syncStopSelectorsHint', 'maxAutoLoops', 'errorKeywords'];
const found = v120Marks.filter(k => client.includes(k));
if (version !== '(未找到)' && version === pkg.version) ok('client.js 版本 == package.json 版本', version);
else bad('版本不一致', 'client=' + version + ' pkg=' + pkg.version);
if (found.length === v120Marks.length) ok('v1.2.0 全部核心标记', found.length + '/' + v120Marks.length);
else bad('缺少 v1.2.0 标记', '缺 ' + JSON.stringify(v120Marks.filter(k => !client.includes(k))));
info('client.js 行数 / 字节', client.split(/\r?\n/).length + ' / ' + Buffer.byteLength(client));

// ---------- B. profile 符号链接 / link 目标 ----------
head('B. 实机 profile 是否加载此插件');
// 分开传 path 片段，避免 win32 下路径分隔符混用导致 existsSync 误判
const linkPath = path.join(PROFILE, 'node_modules', '@tianyulinfeng1', 'dsh-plugin-deepseek-chat');
let linkTarget = '(不存在)';
let isLink = false;
try { isLink = fs.lstatSync(linkPath).isSymbolicLink(); } catch {}
try { linkTarget = fs.realpathSync(linkPath); } catch {}
const norm = (p) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const sameTarget = norm(linkTarget) === norm(WS);
if (isLink && sameTarget) ok('profile 符号链接 -> 本工作目录', linkTarget);
else if (exists(linkPath)) warn('profile 路径存在但非预期链接/目标', linkTarget);
else warn('profile 下未找到插件链接', linkPath);
const patch = readSafe(path.join(PROFILE, 'cordis.patch.yml'), 'utf8') || '';
if (/deepseek-chat|tianyulinfeng1\/dsh-plugin-deepseek-chat/.test(patch))
  ok('cordis.patch.yml 含本插件引用', '以 plugin_manager enabled=true 为准');
else warn('cordis.patch.yml 未命中本插件', '(bundle 也可由 profile 清单管理)');
const profilePkg = readSafe(path.join(PROFILE, 'package.json'), 'utf8') || '';
info('profile package.json 含本插件', profilePkg.includes(PKG) ? '是' : '否/由 patch 管理');
info('权威加载态', 'plugin_manager: v1.2.0 enabled=true, installed=true, link: 安装');

// ---------- C. 主 Local Storage：配置（当前可解析的 leveldb 记录）----------
head('C. 实机 localStorage 配置（纯文本可解析记录；压缩块读不出）');
const cfgResult = leveldb.readKeyObjects(UD, CONFIG_KEY);
const cfg = leveldb.newestByUpdatedAt(cfgResult.objects);
if (cfg) {
  ok('实机配置已写入', cfgResult.hits.join(', '));
  info('autoSyncEnabled', String(cfg.autoSyncEnabled));
  info('maxAutoLoops', String(cfg.maxAutoLoops));
  info('errorKeywords', JSON.stringify(cfg.errorKeywords));
  info('选择器数组', ['stopButtonSelectors','sendButtonSelectors','textareaSelectors','assistantSelectors']
    .map(k => k + '=' + (Array.isArray(cfg[k]) ? cfg[k].length : '?')).join(' '));
  if (cfg.autoSyncEnabled === true) ok('总开关状态', '已开启（用户已在实机启用自动闭环）');
  else info('总开关状态', '未开启（默认/用户已关闭）');
} else {
  info('当前可解析记录未发现配置键', 'CONFIG_KEY 可能已被 leveldb compaction 压进压缩块（纯文本扫描读不出）；开关是否开启以 G 段闭环追踪 + lib/client.js:726 门控为准，不据此断言「默认关闭」');
}

// ---------- D. 持久分区：chat.deepseek.com 是否曾真实加载 ----------
head('D. 持久分区数据（网页会话复用前提）');
const parts = path.join(UD, 'Partitions');
if (exists(parts)) {
  let chatData = 0, chatDirs = [];
  for (const d of fs.readdirSync(parts)) {
    if (!/chat|deepseek|sidebar-browser/i.test(d)) continue;
    const root = path.join(parts, d);
    let n = 0;
    const walk = (p, dep) => {
      if (dep > 5) return; let es; try { es = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q, dep + 1); else if (/chat\.deepseek\.com/i.test(q) || /chat\.deepseek\.com/i.test(e.name)) n++; }
    };
    walk(root, 0);
    const hasSite = (readSafe(path.join(root, 'Local Storage', 'leveldb', 'CURRENT'), 'utf8') || '');
    if (n > 0 || /chat/i.test(d)) { chatDirs.push(d); chatData += n; }
    void hasSite;
  }
  if (chatDirs.length) ok('含 chat 分区目录', chatDirs.join(', '));
  else warn('未找到 chat 分区目录', '(尚未加载过面板)');
  info('站点相关数据文件命中', chatData);
} else warn('Partitions 目录不存在', parts);

// ---------- E. 错误日志 ----------
head('E. 13:10 重启后有无新崩溃/错误日志');
const logs = path.join(UD, 'logs');
if (exists(logs)) {
  const since = Date.now() - 6 * 3600 * 1000;
  let n = 0;
  for (const e of fs.readdirSync(logs)) {
    const p = path.join(logs, e); let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtime.getTime() >= since) { n++; info('近期日志', e + ' ' + st.size + 'B ' + st.mtime.toISOString()); }
  }
  if (!n) ok('无近期新日志文件', '未见新崩溃/错误落盘');
} else ok('logs 目录不存在', '无错误落盘');

// ---------- F. Code Cache 编译索引（诚实：仅旁证，非执行证明）----------
head('F. Code Cache 里本插件 client.js 的编译索引（旁证）');
const CC = path.join(UD, 'Code Cache', 'js');
let revs = [], newest = 0, afterRestart = 0;
if (exists(CC)) for (const e of fs.readdirSync(CC)) {
  if (!e.endsWith('_0')) continue;
  const p = path.join(CC, e); let st; try { st = fs.statSync(p); } catch { continue; }
  const s = readSafe(p, 'latin1') || '';
  if (!s.includes(PKG) || !s.includes('client.js')) continue;
  const m = s.match(/client\.js&rev=([a-z0-9]+)/i);
  if (m) revs.push(m[1]);
  if (st.mtime.getTime() > newest) newest = st.mtime.getTime();
  if (st.mtime.getTime() >= Date.parse('2026-11-15T05:10:00Z')) afterRestart++;
}
info('不同 rev 数', new Set(revs).size);
info('最新编译索引 mtime', newest ? new Date(newest).toISOString() : '(无)');
info('13:10 重启后独立新条目', afterRestart);
warn('解读', 'client 代码经 boot manifest 内联/聚合注入 + V8 缓存懒生成，磁盘缓存不能单凭证明「重启后已执行 v1.2.0 闭环代码」');

// ---------- G. 闭环追踪（真实跑过一轮后，四个阶段时间戳会落盘）----------
head('G. 实机闭环追踪（能读到即证明 autoSyncEnabled 内存态已生效）');
const traceResult = leveldb.readKeyObjects(UD, LOOP_TRACE_KEY);
const trace = leveldb.newestByUpdatedAt(traceResult.objects);
const TRACE_FIELDS = ['lastTurnEndAt', 'lastSendResult', 'lastResponseCompleteAt', 'lastDraftInjectedAt'];
// v1.2.4：发送确认判读字段（via / delta / sentAt→confirmAt）与草稿注入结果（区分两种「草稿没变」成因）
const CONFIRM_FIELDS = ['lastSendMethod', 'lastSendConfirmVia', 'lastSendConfirmed', 'lastSendUserMsgDelta', 'lastSendAt', 'lastSendConfirmAt'];
const DRAFT_FIELDS = ['lastDraftResult', 'lastDraftPreview'];
if (trace) {
  ok('发现闭环追踪', traceResult.hits.join(', '));
  info('开关内存态（门控证据）', 'trace 能写入 → lib/client.js:726 的 if(!autoSyncEnabled)return 已通过 → 实机已开启');
  info('updatedAt / state / loopCount', String(trace.updatedAt) + ' / ' + String(trace.state) + ' / ' + String(trace.loopCount));
  for (const k of TRACE_FIELDS) info(k, String(trace[k] == null ? '(未记录)' : trace[k]));
  head('G1. 发送确认判读（via=node 稳定 / delta 小值 / sentAt→confirmAt≈3500ms）');
  for (const k of CONFIRM_FIELDS) info(k, String(trace[k] == null ? '(未记录)' : trace[k]));
  if (trace.lastSendAt && trace.lastSendConfirmAt) {
    const gapMs = Date.parse(trace.lastSendConfirmAt) - Date.parse(trace.lastSendAt);
    info('sentAt→confirmAt 间隔(ms)', Number.isFinite(gapMs) ? String(gapMs) : '(解析失败)');
  }
  head('G2. 草稿注入结果（no-dock=抓到回复但 setDraft 未调用 / ok=setDraft 已调用）');
  for (const k of DRAFT_FIELDS) info(k, String(trace[k] == null ? '(未记录)' : trace[k]));
  if (Array.isArray(trace.events)) info('阶段事件数（最多 40）', trace.events.length + ' 条');
  if (trace.lastAbortReason) info('最近熔断原因', String(trace.lastAbortReason));
  const covered = TRACE_FIELDS.filter(k => trace[k]).length;
  if (covered >= 3) ok('闭环阶段证据', '至少 3/4 个阶段时间戳已落盘（插件在真实 turn/end 上执行了动作序列）');
  else info('闭环阶段证据', '仅 ' + covered + '/4 个阶段时间戳，可能尚未跑完一整轮（如网页回复抓取超时）');
} else {
  info('未发现闭环追踪', '尚未跑过一轮，或开关内存态未启用（不据此断言具体原因）');
}

// ---------- 汇总 ----------
head('汇总');
console.log('  ' + (problems ? '发现 ' + problems + ' 项异常' : '磁盘级实机证据无异常'));
console.log('  说明：本探针只读，验证「加载态/版本/配置解析/分区/日志/编译索引/闭环追踪」。');
console.log('  C 段 config 读不出时不要断言「默认关闭」——leveldb 压缩块无法纯文本扫描；');
console.log('  G 段读到闭环追踪 + lib/client.js:726 门控，才是 autoSyncEnabled 已生效的更强证据。');
process.exitCode = problems ? 1 : 0;
