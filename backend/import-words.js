/**
 * import-words.js — 把 CSV 词库导入 SQLite，按单词去重
 *
 * 为什么要专门做这件事：
 *   g2-words.csv 与 sample-words.csv 有 6 个词重叠（blue/come/make/old/put/red），
 *   直接合并会让同一轮答题抽到两次同一个词。
 *
 * 用法：
 *   node backend/import-words.js                # 导入 g2 + sample，去重
 *   node backend/import-words.js --dry          # 只看差异不写库
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.sqlite3');
const DRY = process.argv.includes('--dry');

/* ── CSV 解析（支持引号内逗号）── */
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(',').map((s) => s.trim().toLowerCase());
  return lines.map((line) => {
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    const o = {};
    head.forEach((h, i) => { o[h] = (cells[i] || '').trim(); });
    return o;
  }).filter((o) => o.word);
}

function loadFile(name) {
  const p = path.join(ROOT, name);
  if (!fs.existsSync(p)) return [];
  return parseCsv(fs.readFileSync(p, 'utf8')).map((r) => ({
    word: r.word.trim(),
    hint: (r.hint || '').trim(),
    sentence: (r.sentence || '').trim(),
    oxford_level: /^G[12]$/.test(r.oxford_level || '') ? r.oxford_level : 'G2',
    source: name,
  }));
}

/* ── 合并去重：同一个词只保留一条 ──
   保留规则：优先保留「句子更长（含人物/完整标点）」的那条，其次保留先出现的。 */
function dedupe(rows) {
  const byKey = new Map();
  const dropped = [];
  for (const r of rows) {
    const k = r.word.toLowerCase();
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, r); continue; }
    const better = (r.sentence || '').length > (prev.sentence || '').length ? r : prev;
    const worse = better === r ? prev : r;
    byKey.set(k, better);
    dropped.push({ word: k, kept: better.source, removed: worse.source });
  }
  return { kept: [...byKey.values()], dropped };
}

function main() {
  const src = loadFile('g2-words.csv').concat(loadFile('sample-words.csv'));
  const { kept: keptAll, dropped } = dedupe(src);
  // 项目约定：题库只取纯字母单词。之前只统计短语却没剔除，导致
  // "more than / seem to / too … to" 这类短语进了库，还被抽成考题。
  const kept = keptAll.filter((r) => /^[A-Za-z]+$/.test(String(r.word).trim()));
  const excludedPhrases = keptAll.filter((r) => !/^[A-Za-z]+$/.test(String(r.word).trim()));

  const byLevel = kept.reduce((a, r) => (a[r.oxford_level] = (a[r.oxford_level] || 0) + 1, a), {});
  const phrases = kept.filter((r) => /\s/.test(r.word));

  console.log('=== 词库导入 ===');
  console.log(`  源文件行数     : ${src.length}`);
  console.log(`  去重后唯一词   : ${kept.length}`);
  console.log(`  被合并的重复词 : ${dropped.length}` +
    (dropped.length ? ' → ' + dropped.map((d) => d.word).join(', ') : ''));
  console.log(`  级别分布       : ${Object.entries(byLevel).map(([k, v]) => k + ':' + v).join('  ')}`);
  console.log(`  剔除的非单词   : ${excludedPhrases.length}${excludedPhrases.length ? ' → ' + excludedPhrases.map((p) => p.word).join(', ') : ''}`);

  if (DRY) { console.log('\n(--dry 模式，未写入数据库)'); return; }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      oxford_level TEXT NOT NULL DEFAULT 'G1',
      word TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      sentence TEXT NOT NULL DEFAULT ''
    );
  `);

  // 唯一索引：从 schema 层面杜绝重复词再次混进来
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word_unique ON words(LOWER(word))');

  const before = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  const upsert = db.prepare(`
    INSERT INTO words (oxford_level, word, hint, sentence) VALUES (?, ?, ?, ?)
    ON CONFLICT(LOWER(word)) DO UPDATE SET
      hint = CASE WHEN LENGTH(excluded.hint) > LENGTH(hint) THEN excluded.hint ELSE hint END,
      sentence = CASE WHEN LENGTH(excluded.sentence) > LENGTH(sentence) THEN excluded.sentence ELSE sentence END
  `);
  const tx = db.transaction((rows) => { for (const r of rows) upsert.run(r.oxford_level, r.word, r.hint, r.sentence); });
  tx(kept);

  const after = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  const dup = db.prepare(
    'SELECT LOWER(word) w, COUNT(*) c FROM words GROUP BY LOWER(word) HAVING c > 1'
  ).all();
  const levels = db.prepare('SELECT oxford_level, COUNT(*) c FROM words GROUP BY oxford_level').all();

  console.log(`\n  数据库          : ${DB_PATH}`);
  console.log(`  导入前 → 导入后 : ${before} → ${after} 行`);
  console.log(`  剩余重复词      : ${dup.length}${dup.length ? ' ⚠️ ' + JSON.stringify(dup) : ' ✅'}`);
  console.log(`  库内级别         : ${levels.map((l) => l.oxford_level + ':' + l.c).join('  ')}`);
  db.close();
}

main();
