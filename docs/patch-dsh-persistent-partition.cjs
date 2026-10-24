#!/usr/bin/env node
// patch-dsh-persistent-partition.cjs
//
// Make the DSH Desktop sidebar-browser guest partition persistent so a
// chat.deepseek.com login survives an app restart.
//
// The desktop shell creates one in-memory partition per workspace:
//     partition = `dsh-sidebar-browser-${randomUUID()}`;
// Electron only persists cookies/localStorage for partitions whose name starts
// with "persist:", so every restart lost the login. This script rewrites that
// statement to a fixed persist: partition with the exact same byte length, so
// ASAR file offsets stay valid.
//
// Builds that ship per-file ASAR `integrity` metadata (0.2.1-rc.3+) also need
// lib/main.js's SHA256 updated; this script recomputes and syncs it, then
// verifies every file/block hash in the archive before and after writing.
//
// Usage:
//   node patch-dsh-persistent-partition.cjs "<path to resources/app.asar>" [--dry-run]
//
// Exit codes: 0 patched or already patched, 1 refused/failed, 2 usage.

const fs = require('node:fs');
const crypto = require('node:crypto');

const ORIGINAL = "partition = `dsh-sidebar-browser-${randomUUID()}`;";
const PATCHED = "partition = `persist:dsh-sidebar-browser-chat-v1`;";

const target = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!target || !fs.existsSync(target)) {
  console.error('usage: node patch-dsh-persistent-partition.cjs <path to app.asar> [--dry-run]');
  process.exit(2);
}
if (ORIGINAL.length !== PATCHED.length) {
  console.error('refusing: replacement statement length differs');
  process.exit(1);
}

function readHeader(buffer) {
  const jsonLen = buffer.readUInt32LE(12);
  const pickleSize = buffer.readUInt32LE(4);
  const headerBuf = buffer.subarray(16, 16 + jsonLen);
  return { jsonLen, pickleSize, headerBuf, json: JSON.parse(headerBuf.toString('utf8')) };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function mainFileEntry(json) {
  const entry = json && json.files && json.files.lib && json.files.lib.files && json.files.lib.files['main.js'];
  if (!entry || !entry.integrity) return undefined;
  return entry;
}

function verifyAllIntegrity(buffer, header) {
  const dataStart = 8 + header.pickleSize;
  let checked = 0;
  let failed = 0;
  const failures = [];
  const walk = (node, base) => {
    for (const [name, entry] of Object.entries((node && node.files) || {})) {
      const full = base ? `${base}/${name}` : name;
      if (entry.files) { walk(entry, full); continue; }
      const integrity = entry.integrity;
      if (!integrity || !Array.isArray(integrity.blocks) || integrity.blocks.length === 0) continue;
      const size = Number(entry.size);
      const offset = Number(entry.offset);
      if (!Number.isFinite(size) || !Number.isFinite(offset)) continue;
      const abs = dataStart + offset;
      const blockSize = integrity.blockSize || size;
      let ok = true;
      for (let i = 0; i < integrity.blocks.length; i += 1) {
        const len = Math.min(blockSize, size - i * blockSize);
        if (len <= 0) break;
        if (sha256(buffer.subarray(abs + i * blockSize, abs + i * blockSize + len)) !== integrity.blocks[i]) {
          ok = false;
          break;
        }
      }
      checked += 1;
      if (!ok) { failed += 1; if (failures.length < 5) failures.push(full); }
    }
  };
  walk(header.json, '');
  return { checked, failed, failures };
}

const buffer = fs.readFileSync(target);
const text = buffer.toString('latin1');
const header = readHeader(buffer);

if (text.includes(PATCHED)) {
  const result = verifyAllIntegrity(buffer, header);
  console.log(`already patched: ${target}`);
  console.log(`integrity: ${result.checked} file(s) verified, ${result.failed} failed`);
  process.exit(result.failed === 0 ? 0 : 1);
}

const first = text.indexOf(ORIGINAL);
if (first === -1) {
  console.error('target statement not found; this DSH build differs - inspect lib/main.js first');
  process.exit(1);
}
if (text.indexOf(ORIGINAL, first + 1) !== -1) {
  console.error('target statement appears more than once; refusing to patch');
  process.exit(1);
}

let out = text.slice(0, first) + PATCHED + text.slice(first + ORIGINAL.length);
if (Buffer.byteLength(out, 'latin1') !== buffer.length) {
  console.error('patched size differs from original; refusing to write');
  process.exit(1);
}

// Keep per-file ASAR integrity metadata consistent with the patched bytes.
const entry = mainFileEntry(header.json);
if (entry) {
  const dataStart = 8 + header.pickleSize;
  const mainStart = dataStart + Number(entry.offset);
  const mainSize = Number(entry.size);
  const mainBytes = Buffer.from(out.slice(mainStart, mainStart + mainSize), 'latin1');
  const nextHash = sha256(mainBytes);
  const oldHashes = new Set([entry.integrity.hash, ...(entry.integrity.blocks || [])].filter(Boolean));
  if (nextHash === entry.integrity.hash || !oldHashes.has(entry.integrity.hash)) {
    console.error('refusing: lib/main.js integrity metadata is not usable for this build');
    process.exit(1);
  }
  // Multi-block layouts need per-block hashes; refuse rather than guess.
  const nextValue = entry.integrity.blocks && entry.integrity.blocks.length > 1 ? null : nextHash;
  if (nextValue === null) {
    console.error('refusing: multi-block integrity layout for lib/main.js is unsupported');
    process.exit(1);
  }
  // Replace only inside the header JSON region.
  const headerText = out.slice(16, 16 + header.jsonLen);
  let updatedHeader = headerText;
  for (const oldHash of oldHashes) {
    updatedHeader = updatedHeader.split(oldHash).join(nextHash);
  }
  if (updatedHeader.length !== headerText.length) {
    console.error('refusing: header JSON length would change');
    process.exit(1);
  }
  out = out.slice(0, 16) + updatedHeader + out.slice(16 + header.jsonLen);
}

const patched = Buffer.from(out, 'latin1');
const patchedHeader = readHeader(patched);
const result = verifyAllIntegrity(patched, patchedHeader);
if (result.failed !== 0) {
  console.error(`refusing: ${result.failed} integrity check(s) failed for the patched archive`, result.failures);
  process.exit(1);
}

if (dryRun) {
  console.log('dry-run: patch would be applied');
  console.log(`integrity: ${result.checked} file(s) verified, 0 failed`);
  process.exit(0);
}

const backup = `${target}.bak-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`;
fs.copyFileSync(target, backup);
fs.writeFileSync(target, patched);
console.log(`patched: ${target}`);
console.log(`backup : ${backup}`);
console.log(`integrity: ${result.checked} file(s) verified, 0 failed`);
