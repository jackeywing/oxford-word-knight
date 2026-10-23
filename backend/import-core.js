#!/usr/bin/env node
/**
 * import-core.js — 把 data/core-*.csv + data/sentences.csv 导入主词表
 *
 * 之前扩到 910+ 词用的是一次性脚本，仓库里没有留存，导致「重跑导入」无法复现。
 * 这个脚本补上可复现的入口，并且是幂等的：
 *   - 按 LOWER(word) 去重，已存在则补空字段（hint/sentence/stage/pos 缺什么补什么）
 *   - 只收纯字母单词，短语一律丢弃（项目约定：题库不得出现 "more than" 这类短语）
 *   - 超出现有 G1/G2 语境的词按 stage 反推 oxford_level（stage<=2 → G1，否则 G2）
 *
 * 用法：node backend/import-core.js [--dry]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'backend', 'db.sqlite3');
const DRY = process.argv.includes('--dry');
const db = new Database(DB_PATH);

const FILES = ['core-sight.csv', 'core-nouns.csv', 'core-phonics.csv', 'core-extra.csv'];

function readCsv(file) {
  const p = path.join(ROOT, 'data', file);
  if (!fs.existsSync(p)) return [];
  return parse(fs.readFileSync(p, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
}

const isWord = (w) => /^[a-z]+$/i.test(String(w || '').trim());

const rows = [];
for (const f of FILES) {
  for (const r of readCsv(f)) {
    const word = String(r.word || '').trim();
    if (!isWord(word)) continue;
    rows.push({
      word: word.toLowerCase(),
      hint: String(r.hint || '').trim(),
      stage: Number(r.stage) || 3,
      pos: String(r.pos || '').trim(),
      src: f,
    });
  }
}

const sentences = new Map();
for (const r of readCsv('sentences.csv')) {
  const w = String(r.word || '').trim().toLowerCase();
  const s = String(r.sentence || '').trim();
  if (isWord(w) && s) sentences.set(w, s);
}

const find = db.prepare('SELECT * FROM words WHERE LOWER(word) = ?');
const insert = db.prepare(`
  INSERT INTO words (oxford_level, word, hint, sentence, stage, pos)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const update = db.prepare(`
  UPDATE words SET hint = COALESCE(NULLIF(?,''), hint),
                   sentence = COALESCE(NULLIF(?,''), sentence),
                   stage = COALESCE(?, stage),
                   pos = COALESCE(NULLIF(?,''), pos)
   WHERE id = ?
`);

let added = 0, patched = 0, skipped = 0;
const seen = new Set();

db.transaction(() => {
  for (const r of rows) {
    if (seen.has(r.word)) { skipped++; continue; }
    seen.add(r.word);
    const ex = find.get(r.word);
    const sentence = sentences.get(r.word) || '';
    if (!ex) {
      if (!DRY) insert.run(r.stage <= 2 ? 'G1' : 'G2', r.word, r.hint, sentence, r.stage, r.pos);
      added++;
    } else {
      const needHint = !ex.hint && r.hint;
      const needSent = !ex.sentence && sentence;
      const needPos = !ex.pos && r.pos;
      if (needHint || needSent || needPos) {
        if (!DRY) update.run(needHint ? r.hint : '', needSent ? sentence : '', null, needPos ? r.pos : '', ex.id);
        patched++;
      }
    }
  }
})();

const total = db.prepare('SELECT COUNT(*) c FROM words').get().c;
const dup = db.prepare('SELECT LOWER(word) w, COUNT(*) n FROM words GROUP BY w HAVING n > 1').all();
const withSent = db.prepare("SELECT COUNT(*) c FROM words WHERE sentence <> ''").get().c;

console.log(`导入源文件     : ${FILES.join(', ')} + sentences.csv`);
console.log(`候选词条       : ${seen.size}（跳过重复行 ${skipped}）`);
console.log(`新增 / 补全    : ${added} / ${patched}${DRY ? '  [dry-run]' : ''}`);
console.log(`词库总量       : ${total}`);
console.log(`重复词         : ${dup.length} ${dup.length ? '→ ' + dup.map((d) => d.w).join(', ') : '✅'}`);
console.log(`含例句         : ${withSent}（${(withSent / total * 100).toFixed(0)}%）`);
console.log(`fright 在库    : ${!!find.get('fright')}`);
