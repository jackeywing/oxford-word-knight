#!/usr/bin/env node
/**
 * 把 docs/audio/manifest.json（约 1 MB）压成前端真正需要的索引（约 70 KB）。
 *
 * 前端只用 manifest 做两件事：
 *   1. 判断某个词有没有音频 —— 但路径完全可以推导：
 *        words/<word>.mp3  /  words/<word>__<char>.mp3
 *      所以只需要一份"有哪些词"的清单。
 *   2. 句子/短语 → 文件名 —— 文件名是 sha1(句子).slice(0,12)，
 *      前端推不出来，必须保留映射。
 *
 * manifest.json 本身继续保留（生成脚本靠它做增量跳过），只是不再被浏览器拉取。
 *
 * 用法：node backend/build-audio-index.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'audio', 'manifest.json');
const OUT = path.join(ROOT, 'docs', 'audio', 'index.json');

if (!fs.existsSync(SRC)) {
  console.error('找不到 manifest.json，先跑 node backend/gen-audio.js');
  process.exit(1);
}

const m = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const out = {
  v: 1,
  w: Object.keys(m.words || {}).join(' '),
  p: {},
  s: {},
};
for (const [k, e] of Object.entries(m.phrases || {})) {
  if (e && e.file) out.p[k] = e.file;
}
for (const [k, e] of Object.entries(m.sentences || {})) {
  if (e && e.file) out.s[k] = e.file;
}

fs.writeFileSync(OUT, JSON.stringify(out));

const a = fs.statSync(SRC).size;
const b = fs.statSync(OUT).size;
console.log(
  `wrote docs/audio/index.json  ${(b / 1024).toFixed(1)} KB` +
  `  (manifest ${(a / 1024).toFixed(1)} KB → -${(100 - (b / a) * 100).toFixed(1)}%)` +
  `  | 词 ${Object.keys(m.words || {}).length}  短语 ${Object.keys(out.p).length}  例句 ${Object.keys(out.s).length}`
);
