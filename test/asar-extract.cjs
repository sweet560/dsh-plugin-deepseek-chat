// 只读：提取 asar 中指定字节区间的文本（asar 内容为明文，含打包的 .ts 源码）。
// 用法: node test/asar-extract.cjs <asar> <start> <len>
const fs = require("fs");
const [asar, startS, lenS] = process.argv.slice(2);
const start = Number(startS);
const len = Number(lenS);
const fd = fs.openSync(asar, "r");
const buf = Buffer.alloc(len);
const read = fs.readSync(fd, buf, 0, len, start);
fs.closeSync(fd);
process.stdout.write(buf.slice(0, read).toString("utf8"));
