const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.sqlite3');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oxford_level TEXT NOT NULL CHECK(oxford_level IN ('G1','G2')),
    word TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    sentence TEXT NOT NULL DEFAULT ''
  )
`);

// ── helpers ──
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  setCORS(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveFile(res, relPath, contentType) {
  try {
    const full = path.join(__dirname, '..', relPath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(full, 'utf-8'));
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ── Route helpers ──
function getThreeDistractors(level, excludeWord) {
  const rows = db.prepare(
    'SELECT word FROM words WHERE oxford_level = ? AND word != ? ORDER BY RANDOM() LIMIT 3'
  ).all(level, excludeWord);
  return rows.map(r => r.word);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }
  const { pathname, query } = url.parse(req.url, true);

  // ── Static ──
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html'))
    return serveFile(res, 'frontend/index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && pathname === '/frontend/game.css')
    return serveFile(res, 'frontend/game.css', 'text/css; charset=utf-8');

  // ── GET /api/challenges?level=G1&count=10
  // 返回带句子 + 干扰项的挑战数据
  if (req.method === 'GET' && pathname === '/api/challenges') {
    const { level, count } = query;
    if (!level || !['G1', 'G2'].includes(level))
      return json(res, { error: 'level must be G1 or G2' }, 400);
    const limit = Math.min(Math.max(parseInt(count) || 8, 1), 30);
    try {
      const words = db.prepare(
        'SELECT id, word, hint, sentence FROM words WHERE oxford_level = ? ORDER BY RANDOM() LIMIT ?'
      ).all(level, limit);

      const challenges = words.map(w => {
        const distractors = getThreeDistractors(level, w.word);
        const options = [w.word, ...distractors].sort(() => Math.random() - 0.5);
        // 把句子中的 target word 替换为 ____
        const sentenceBlank = w.sentence
          ? w.sentence.replace(new RegExp(w.word, 'i'), '____')
          : `____ (${w.hint})`;
        return {
          id: w.id,
          word: w.word,
          hint: w.hint,
          sentence: w.sentence || '',
          sentenceBlank,
          options
        };
      });
      json(res, challenges);
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/words?level=G1&count=15 (legacy) ──
  if (req.method === 'GET' && pathname === '/api/words') {
    const { level, count } = query;
    if (!level || !['G1', 'G2'].includes(level))
      return json(res, { error: 'level must be G1 or G2' }, 400);
    const limit = Math.min(Math.max(parseInt(count) || 10, 1), 50);
    try {
      const rows = db.prepare(
        'SELECT id, word, hint, sentence FROM words WHERE oxford_level = ? ORDER BY RANDOM() LIMIT ?'
      ).all(level, limit);
      json(res, rows);
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/stats ──
  if (req.method === 'GET' && pathname === '/api/stats') {
    const stats = db.prepare(
      'SELECT oxford_level, COUNT(*) as count FROM words GROUP BY oxford_level'
    ).all();
    json(res, stats);
    return;
  }

  // ── POST /api/import ──
  if (req.method === 'POST' && pathname === '/api/import') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const records = parse(body, { columns: true, skip_empty_lines: true, trim: true });
        if (!records.length) return json(res, { error: 'CSV empty' }, 400);

        const required = ['oxford_level', 'word', 'hint'];
        const cols = Object.keys(records[0]);
        const missing = required.filter(c => !cols.includes(c));
        if (missing.length) return json(res, { error: `Missing columns: ${missing.join(',')}` }, 400);

        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (!['G1', 'G2'].includes(r.oxford_level))
            return json(res, { error: `Row ${i + 2}: level must be G1/G2, got "${r.oxford_level}"` }, 400);
          if (!r.word?.trim()) return json(res, { error: `Row ${i + 2}: word missing` }, 400);
        }

        const ins = db.prepare('INSERT OR REPLACE INTO words (oxford_level, word, hint, sentence) VALUES (?, ?, ?, ?)');
        const del = db.prepare('DELETE FROM words');
        db.transaction(() => {
          del.run();
          records.forEach(r => ins.run(
            r.oxford_level.trim(),
            r.word.trim(),
            (r.hint || '').trim(),
            (r.sentence || '').trim()
          ));
        })();

        const stats = db.prepare('SELECT oxford_level, COUNT(*) as c FROM words GROUP BY oxford_level').all();
        json(res, { success: true, message: `Imported ${records.length} words`, stats });
      } catch (e) { json(res, { error: e.message }, 400); }
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`✅ Oxford Word Knight — http://localhost:${PORT}`);
});
