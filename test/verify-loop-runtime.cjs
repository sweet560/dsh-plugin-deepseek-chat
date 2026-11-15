/**
 * test/verify-loop-runtime.cjs —— v1.2.0 自动闭环「触发 + 观测」验证脚本
 *
 * 目标：把验证从「静态探针」升级为「触发一轮真实 turn，再观测插件是否真的执行了
 *       回传-发送-抓取-注入的动作序列」。证据来自插件写进主窗口 localStorage 的
 *       LOOP_TRACE_KEY（Chromium 落盘到 <UserData>/Local Storage/leveldb）。
 *
 * ---------------------------------------------------------------------------
 * 如实改道（与用户最初设想的差异，取证于本机 DSH 0.2.2-rc.3）：
 *  1. 用户设想用 `dshx / dsh-exec` 从脚本触发一个 turn。本机核实 dshx / dsh-exec
 *     并不存在（where / npm view / 安装目录全扫均无），dsh-ops 也没有触发 turn 的子命令。
 *     故本脚本的「触发」阶段是【可选】的：检测到 dshx 才触发，缺失时诚实降级、
 *     不伪装成「已触发」，把重点放在「观测」阶段。
 *  2. 用户设想插件写 ~/.dsh/.../loop-trace.json。但 renderer 插件在
 *     contextIsolation:true / sandbox:true 下没有 Node fs 能力，写不了磁盘 JSON。
 *     真实可行且已验证的落盘载体是 window.localStorage（插件本就用它存 config）。
 *     故 trace 从 leveldb 读（复用 test/lib/read-leveldb.cjs，避免重复造轮子）。
 *  3. 用户设想「与 dsh-hooks-bus 的 TurnEnd payload 结构一致」。本机真实事件是
 *     session 的 'turn/end'（reason 是判别联合对象 {kind:'completed'}），
 *     没有 dsh-hooks-bus 包。插件用 eventSource.subscribe 监听真实 turn/end。
 *  4. 修复原脚本两处会崩的 bug：前置 spawn --status 的异步 error 未被 await 捕获；
 *     主 spawn 没注册 'error' handler，dshx 缺失时会抛未捕获异常而非明确报错。
 *
 * 用法：node test/verify-loop-runtime.cjs
 * 覆盖：DSH_VERIFY_USER_DATA / DSH_VERIFY_DSHX 可覆盖默认 userData 与 dshx 命令名。
 * 只读观测：绝不改动实机状态、不驱动 GUI、不替用户开启 autoSyncEnabled。
 */
'use strict';
const { spawn } = require('child_process');
const leveldb = require('./lib/read-leveldb.cjs');

const UD = process.env.DSH_VERIFY_USER_DATA || 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-desktop';
const LOOP_TRACE_KEY = 'dsh-plugin-deepseek-chat:loop-trace';
const CONFIG_KEY = 'dsh-plugin-deepseek-chat:config';
const DSHX = process.env.DSH_VERIFY_DSHX || (process.platform === 'win32' ? 'dshx.cmd' : 'dshx');
const PROBE_TASK = 'run: node -e "console.log(\'DSH_CLOSED_LOOP_PROBE_OK\')"';
const TURN_END_TIMEOUT_MS = 120_000;
const POST_TURN_WAIT_MS = 30_000;

const line = () => console.log('  ' + '-'.repeat(66));
const info = (k, v) => console.log('  [信息] ' + k.padEnd(30) + String(v));
const yes = (k, v) => console.log('  [已证实] ' + k.padEnd(28) + String(v));
const todo = (k, v) => console.log('  [需人工] ' + k.padEnd(28) + String(v));
const warn = (k, v) => console.log('  [降级] ' + k.padEnd(29) + String(v));
const fail = (msg) => { console.error('  [异常] ' + msg); process.exitCode = 2; };

/** 用 Promise 包装一次 spawn，正确捕获 spawn 阶段的 ENOENT 与退出码。 */
function runSpawn(cmd, args, onLine, timeoutMs) {
  return new Promise((resolve) => {
    let child, done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { finish({ ok: false, reason: 'spawn-throw: ' + e.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, reason: 'timeout' }); }, timeoutMs || 15000);
    const clear = () => clearTimeout(timer);
    child.on('error', (e) => { clear(); finish({ ok: false, reason: 'spawn-error: ' + e.message }); });
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const ln = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (ln && onLine) onLine(ln);
      }
    };
    if (child.stdout) child.stdout.on('data', feed);
    if (child.stderr) child.stderr.on('data', feed);
    child.on('close', (code) => { clear(); finish({ ok: code === 0, reason: 'exit=' + code }); });
  });
}

/** NDJSON 行里识别 turn/end（兼容 user 设想里的多种命名），收集 sessionId。 */
function scanNdjson(ln, acc) {
  if (!ln || ln[0] !== '{') return;
  let obj; try { obj = JSON.parse(ln); } catch { return; }
  const t = String(obj.type || obj.event || obj.kind || '');
  if (/^thread[./]started$/i.test(t) && obj.sessionId) acc.sessionId = String(obj.sessionId);
  if (/^(turn[./]end|turnend|turn_completed)$/i.test(t)) acc.turnEnd = true;
  if (obj.session_id && !acc.sessionId) acc.sessionId = String(obj.session_id);
}

/** 阶段一（可选触发）：dshx 存在才真正 trigger 一个 turn。 */
async function tryTrigger() {
  const acc = { turnEnd: false, sessionId: '' };
  line();
  console.log('  阶段一 · 触发（可选，取决于本机是否安装 dshx / dsh-exec）');
  line();
  const probe = await runSpawn(DSHX, ['--status'], null, 8000);
  if (!probe.ok) {
    warn('未检测到可用的 dshx', DSHX + ' → ' + probe.reason);
    info('诚实说明', '本机无 dsh-exec/dshx，无法从脚本自动触发真实 turn（已取证：where/npm view/安装目录全扫无命中）');
    info('影响', '「触发」阶段跳过；本脚本继续做「观测」阶段，不伪装成已触发');
    return { triggered: false, acc };
  }
  info('dshx --status', probe.reason + '（可用，继续触发）');
  const result = await runSpawn(DSHX, ['--json', PROBE_TASK], (l) => scanNdjson(l, acc), TURN_END_TIMEOUT_MS);
  info('dshx --json 结果', result.reason);
  info('识别到 turn/end', acc.turnEnd ? '是' : '否');
  if (acc.sessionId) info('会话 sessionId', acc.sessionId);
  if (acc.turnEnd) {
    info('等待闭环动作完成', POST_TURN_WAIT_MS + 'ms（回传-发送-抓取-注入）');
    await new Promise((r) => setTimeout(r, POST_TURN_WAIT_MS));
  }
  return { triggered: true, acc };
}

/** 阶段二（观测）：读实机 loop-trace 与 config，做状态断言。 */
function observe(trigger) {
  line();
  console.log('  阶段二 · 观测（读取插件写进实机 localStorage 的闭环追踪）');
  line();
  const cfg = leveldb.newestByUpdatedAt(leveldb.readKeyObjects(UD, CONFIG_KEY).objects);
  if (!cfg) warn('实机配置键未解析到', 'CONFIG_KEY 可能已被 leveldb compaction 压进压缩块，纯文本扫描读不出；不能据此断言开关状态');
  else info('autoSyncEnabled', String(cfg.autoSyncEnabled) + ' / maxAutoLoops=' + String(cfg.maxAutoLoops));

  const tr = leveldb.readKeyObjects(UD, LOOP_TRACE_KEY);
  const trace = leveldb.newestByUpdatedAt(tr.objects);
  if (!trace) {
    warn('未发现闭环追踪', '尚未跑过一轮或开关内存态未启用（符合惰性设计，不伪装成已跑）');
    return { trace: null, cfg };
  }
  info('追踪来源', tr.hits.join(', '));
  if (!cfg) info('开关内存态（交叉验证）', 'trace 能写入 → lib/client.js:726 门控通过 → autoSyncEnabled 已生效；config 读不出是 leveldb 压缩，非「未开启」');
  info('updatedAt / state / loopCount', String(trace.updatedAt) + ' / ' + String(trace.state) + ' / ' + String(trace.loopCount));
  const FIELDS = [
    ['lastTurnEndAt', '真实 turn/end 到达插件监听器'],
    ['lastSendResult', '执行了「回传-发送」动作（ok/失败原因）'],
    ['lastResponseCompleteAt', '网页回复完成被抓取'],
    ['lastDraftInjectedAt', '草稿注入（仅 setDraft，不 submit）']
  ];
  for (const [k] of FIELDS) info(k, String(trace[k] == null ? '(未记录)' : trace[k]));
  if (Array.isArray(trace.events)) info('阶段事件数', trace.events.length + ' 条（上限 40）');
  return { trace, cfg };
}

/** 输出「脚本已证实」/「仍需人工确认」两段。 */
function report(trigger, obs) {
  line();
  console.log('  ■ 脚本已证实');
  line();
  const t = obs.trace;
  if (trigger.triggered && trigger.acc.turnEnd) yes('脚本真实触发了一个 turn', 'dshx --json + NDJSON 识别到 turn/end');
  else warn('脚本触发真实 turn', 'dshx 不存在，未触发（如实降级，非失败）');
  if (t) {
    yes('插件写下了闭环追踪', 'LOOP_TRACE_KEY 落盘于实机 leveldb');
    if (t.lastTurnEndAt) yes('真实 turn/end 到达监听器', t.lastTurnEndAt);
    if (t.lastSendResult) yes('执行了回传-发送', String(t.lastSendResult));
    if (t.lastResponseCompleteAt) yes('网页回复完成被抓取', t.lastResponseCompleteAt);
    if (t.lastDraftInjectedAt) yes('草稿注入（setDraft）', String(t.lastDraftResult || 'ok'));
    if (t.lastAbortReason) yes('熔断/暂停原因', String(t.lastAbortReason));
    const covered = ['lastTurnEndAt', 'lastSendResult', 'lastResponseCompleteAt', 'lastDraftInjectedAt'].filter(k => t[k]).length;
    if (covered === 4) yes('完整动作序列', '四阶段时间戳齐全 → 插件在真实 turn 上跑通了闭环');
    else info('动作序列完整度', covered + '/4 阶段已落盘');
  } else {
    warn('插件闭环动作序列', '尚无追踪数据（未跑一轮 / 开关未启用），无法从脚本证实');
  }
  line();
  console.log('  ■ 仍需人工确认（最后一厘米，脚本无法访问 <webview> DOM）');
  line();
  todo('网页输入框里的草稿', '肉眼确认 DeepSeek 输入框是否出现网页回复文本');
  todo('是否没被自动执行', '肉眼确认 Harness 没有自动跑下一轮（决定权仍在用户）');
  todo('错误关键词熔断', '构造含 Error/Traceback 的失败 turn，肉眼确认不自动回传');
  todo('最大轮次封顶', '设 maxAutoLoops 小值连跑，肉眼确认到上限后暂停');
  // 仅当「没有追踪证据」且 config 也未解析到已开启时，才提示人工去开总开关。
  // 若 G 段已读到 trace，lib/client.js:726 门控证明开关已生效，不再误提示。
  if (!t && (!obs.cfg || obs.cfg.autoSyncEnabled !== true))
    todo('开启总开关', '设置页第 4 张卡勾选 autoSyncEnabled（建议先 maxAutoLoops=2 观察一轮）');
  line();
  info('改道说明', 'dshx 缺失 / renderer 无 fs / 真实事件是 turn/end —— 见文件头注释 4 点');
}

async function main() {
  console.log('\n=== v1.2.0 自动闭环「触发 + 观测」验证 ===');
  const trigger = await tryTrigger();
  const obs = observe(trigger);
  report(trigger, obs);
  // 诚实降级不算失败：只有「dshx 可用却触发异常」才给非零退出码。
  if (trigger.triggered && !trigger.acc.turnEnd) fail('dshx 可用但未识别到 turn/end，请检查 NDJSON 输出');
}
main().catch((e) => fail(e && (e.stack || e.message)));
