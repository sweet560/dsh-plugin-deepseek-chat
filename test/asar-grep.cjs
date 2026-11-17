// 只读：在整个 asar 二进制里按字节搜索 ASCII 关键字并打印上下文（asar 内容区是明文 JS）。
// 用法: node test/asar-grep.cjs <asar路径> <关键字1> <关键字2> ...
const fs = require("fs");

const [asar, ...keys] = process.argv.slice(2);
const buf = fs.readFileSync(asar);
console.log(`# asar bytes=${buf.length}`);
for (const key of keys) {
  const needle = Buffer.from(key, "utf8");
  let from = 0;
  let count = 0;
  const ctx = 260;
  while (count < 8) {
    const idx = buf.indexOf(needle, from);
    if (idx < 0) break;
    const start = Math.max(0, idx - ctx);
    const end = Math.min(buf.length, idx + needle.length + ctx);
    const snippet = buf.slice(start, end).toString("utf8");
    console.log(`\n=== ${key} @ byte ${idx} ===`);
    console.log(JSON.stringify(snippet));
    from = idx + needle.length;
    count++;
  }
  if (count === 0) console.log(`\n=== ${key}: NOT FOUND ===`);
  console.log(`# ${key}: ${count} hit(s)`);
}
