/**
 * test/lib/read-leveldb.cjs —— 共享的 Chromium Local Storage / leveldb 只读解析
 *
 * DSH 桌面端把主窗口 window.localStorage 落盘到 <UserData>/Local Storage/leveldb。
 * 插件把「配置」和「闭环追踪」都存成 JSON 值，键分别是各自的 *KEY 常量。
 * 这里零依赖地解析这些值，避免两个探针重复造轮子：
 *   - 枚举 .log / .ldb，按字节找 ASCII 键
 *   - 键后的 JSON 值可能是纯 ASCII（latin1）或含中文（UTF-16LE），两种编码都试
 *   - 命中后在键后窗口内按花括号配平截出 {...} 并 JSON.parse（正确处理字符串内的花括号/转义）
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

/** 从一段字符串里截出第一个完整、可 JSON.parse 的 {...} 对象；字符串级扫描，能处理值内部的花括号与转义引号。 */
function firstJsonObject(s) {
  const st = s.indexOf('{');
  if (st === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = st; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const o = JSON.parse(s.slice(st, i + 1));
          return (o && typeof o === 'object') ? o : null;
        } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 在单个 buffer 里收集 key 之后所有可 parse 的 {...} 对象。
 * leveldb 的 key 是 ASCII，用 latin1 找字节位置；值可能是 latin1 或 UTF-16LE
 * （含中文的 JSON 由 Chromium 存成 UTF-16LE），两种编码分别解码后都尝试解析。
 * 保留 enc 形参以兼容既有调用方，实际解析不再依赖单一编码。
 */
function parseObjectsAfterKey(buffer, enc, key) {
  const keyBuf = Buffer.from(String(key), 'latin1');
  const found = [];
  let from = 0, i;
  while ((i = buffer.indexOf(keyBuf, from)) !== -1) {
    from = i + keyBuf.length;
    const window = buffer.slice(from, Math.min(from + 20000, buffer.length));
    for (const e of ['latin1', 'utf16le']) {
      const o = firstJsonObject(window.toString(e));
      if (o) found.push(o);
    }
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
    const parsed = parseObjectsAfterKey(b, 'both', key);
    if (parsed.length) hits.push(path.basename(file) + '(latin1|utf16le)');
    for (const o of parsed) objects.push(o);
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
