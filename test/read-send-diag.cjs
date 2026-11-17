/**
 * test/read-send-diag.cjs —— 只读解析发送诊断日志（v1.3.0）
 *
 * 插件在每次 DSH→网页 chat 发送时，把输入框状态时序写进 loop-trace 的
 * send-diag 事件（event.stage="send-diag"，event.detail="gen:N [{...}]"）。
 * 这个脚本从 Chromium leveldb 里读出这些事件、按轮次格式化成可读表，
 * 用来定位「首轮残留 / 每轮残留」这类 React 受控输入框时序问题。
 *
 * 只读：全程 readFileSync / readdirSync，绝不写任何实机文件。
 *
 * 用法：
 *   node test/read-send-diag.cjs
 *   DSH_VERIFY_USER_DATA="..." node test/read-send-diag.cjs   # 覆盖 UserData 路径
 */
'use strict';
const leveldb = require('./lib/read-leveldb.cjs');

const UD = process.env.DSH_VERIFY_USER_DATA || 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-desktop';
const LOOP_TRACE_KEY = 'dsh-plugin-deepseek-chat:loop-trace';

const tr = leveldb.readKeyObjects(UD, LOOP_TRACE_KEY);
const objects = (tr && tr.objects) || [];
if (!objects.length) {
  console.log('未找到 loop-trace（可能未开启自动闭环，或 UserData 路径不对）。');
  console.log('当前 UserData：' + UD);
  process.exit(0);
}
// 取最新的一条 trace（events 是累积数组，包含多轮 send-diag）。
const trace = leveldb.newestByUpdatedAt(objects);
const events = Array.isArray(trace.events) ? trace.events : [];
const diagEvents = events.filter((e) => e && e.stage === 'send-diag');

console.log('UserData：' + UD);
console.log('trace 更新时间：' + (trace.updatedAt || '?'));
console.log('send-diag 事件数：' + diagEvents.length);
console.log('='.repeat(78));

if (!diagEvents.length) {
  console.log('没有 send-diag 事件。请确认已用带诊断的版本重启 DSH，并跑一轮自动闭环。');
  process.exit(0);
}

for (const ev of diagEvents) {
  const detail = String(ev.detail || '');
  const split = detail.indexOf(' ');
  const gen = split > 0 ? detail.slice(0, split) : detail;
  let rows = [];
  try {
    const json = split > 0 ? detail.slice(split + 1) : '';
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) rows = parsed;
  } catch (e) {
    console.log('[' + ev.at + '] ' + gen + '（detail 解析失败）: ' + detail.slice(0, 200));
    continue;
  }
  console.log('\n[' + ev.at + '] ' + gen + '  共 ' + rows.length + ' 个观测点');
  console.log('  ' + ['时刻'.padEnd(18), 'gen', 'sent', 'boxEmpty', 'boxLen', 'method', 'head'].join(' | '));
  console.log('  ' + '-'.repeat(74));
  for (const r of rows) {
    const at = String(r.at || '').padEnd(18);
    const genv = String(r.gen == null ? '' : r.gen);
    const sent = String(r.sent == null ? '' : r.sent);
    const empty = String(r.boxEmpty == null ? '' : r.boxEmpty);
    const len = String(r.boxLen == null ? '' : r.boxLen);
    const method = String(r.method == null ? '' : r.method);
    const head = r.boxHead == null ? '' : JSON.stringify(r.boxHead);
    const extra = [];
    if (r.inputLen != null) extra.push('inputLen=' + r.inputLen);
    if (r.delta != null) extra.push('delta=' + r.delta);
    if (r.cleared != null) extra.push('cleared=' + r.cleared);
    if (r.confirmed != null) extra.push('confirmed=' + r.confirmed);
    console.log('  ' + [at, genv, sent, empty, len, method, head].join(' | ') +
      (extra.length ? '   [' + extra.join(', ') + ']' : ''));
  }
}
console.log('\n' + '='.repeat(78));
console.log('说明：boxLen/head 是输入框内容长度与开头 24 字；残留即发送后 boxLen 仍 >0。');
console.log('关注：after-fill 之后，每轮在 after-click / at-1s / confirm 时的 boxEmpty 是否变化。');
