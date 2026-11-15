/**
 * test/lib/read-leveldb.cjs —— 共享的 Chromium Local Storage / leveldb 只读解析
 *
 * DSH 桌面端把主窗口 window.localStorage 落盘到 <UserData>/Local Storage/leveldb。
 * 插件把「配置」和「闭环追踪」都存成 JSON 值，键分别是各自的 *KEY 常量。
 * 这里零依赖地复刻 verify-runtime.cjs 早期 C 段算法，避免两个探针重复造轮子：
 *   - 枚举 .log / .ldb，按 latin1 + utf16le 双编码查找键
 *   - 命中后在键后窗口内按花括号配平截出 {...} 并 JSON.parse
 *   - 返回该键对应的所有可解析对象（调用方自行挑最新的一条）
 *
 * 只读：全程 readFileSync / readdirSync / existsSync，绝不写任何实机文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function levelDbDir(userData) {
  return path.join(userData, 'Local Storage', 'leveldb');
}

function listLevelDbFiles(userData) {
  const dir = levelDbDir(userData);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter((e) => /\.(log|ldb)$/i.test(e))
    .map((e) => path.join(dir, e));
}

/** 在单个 buffer 的一种编码里，收集 key 之后所有可 parse 的 {...} 对象。 */
function parseObjectsAfterKey(buffer, enc, key) {
  let s;
  try { s = buffer.toString(enc); } catch { return []; }
  const found = [];
  let from = 0, i;
  while ((i = s.indexOf(key, from)) !== -1) {
    from = i + key.length;
    const seg = s.slice(from, from + 1600);
    const st = seg.indexOf('{');
    if (st === -1) continue;
    let depth = 0, end = -1;
    for (let j = st; j < seg.length; j++) {
      if (seg[j] === '{') depth++;
      else if (seg[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    try {
      const o = JSON.parse(seg.slice(st, end + 1));
      if (o && typeof o === 'object') found.push(o);
    } catch { /* 不是完整 JSON，跳过 */ }
  }
  return found;
}

/**
 * 读取某个 localStorage 键在所有 leveldb 文件里的全部可解析对象。
 * 返回 { objects: object[], hits: string[] }；objects 顺序不做时序保证。
 */
function readKeyObjects(userData, key) {
  const objects = [];
  const hits = [];
  for (const file of listLevelDbFiles(userData)) {
    let b;
    try { b = fs.readFileSync(file); } catch { continue; }
    for (const enc of ['latin1', 'utf16le']) {
      const parsed = parseObjectsAfterKey(b, enc, key);
      if (parsed.length) hits.push(path.basename(file) + '(' + enc + ')');
      for (const o of parsed) objects.push(o);
    }
  }
  return { objects, hits };
}

/** 挑 updatedAt 最新的一条；没有时间戳就返回最后一条。 */
function newestByUpdatedAt(objects) {
  let best = null, bestT = -Infinity;
  for (const o of objects) {
    const t = Date.parse(o && o.updatedAt);
    const score = Number.isFinite(t) ? t : (best === null ? 0 : bestT);
    if (score >= bestT) { bestT = score; best = o; }
  }
  return best || (objects.length ? objects[objects.length - 1] : null);
}

module.exports = { levelDbDir, listLevelDbFiles, parseObjectsAfterKey, readKeyObjects, newestByUpdatedAt };
