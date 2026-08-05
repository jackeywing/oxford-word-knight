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

// ── Tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oxford_level TEXT NOT NULL DEFAULT 'G1',
    word TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    sentence TEXT NOT NULL DEFAULT ''
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS game_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_name TEXT NOT NULL,
    level TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    max_combo INTEGER DEFAULT 0,
    words_total INTEGER DEFAULT 0,
    words_correct INTEGER DEFAULT 0,
    words_timeout INTEGER DEFAULT 0,
    words_wrong INTEGER DEFAULT 0,
    details TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

// ── Helpers ──
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
function getThreeDistractors(level, excludeWord) {
  const rows = db.prepare(
    'SELECT word FROM words WHERE oxford_level = ? AND word != ? ORDER BY RANDOM() LIMIT 3'
  ).all(level, excludeWord);
  return rows.map(r => r.word);
}

// ── Cloze: hide letters from the full phrase, preserve spaces as separators ──
function makeCloze(word) {
  const clean = word.replace(/…/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = clean.split(' ');
  const lettersOnly = parts.join('');
  const total = lettersOnly.length;
  if (total <= 2) {
    return { blanked: lettersOnly[0] + '_', hidden: lettersOnly.slice(1), answerLen: total - 1 };
  }
  const hideLen = Math.max(Math.ceil(total * 0.4), 2);
  const start = Math.floor(Math.random() * (total - hideLen + 1));
  const end = start + hideLen;
  let blanked = '', hidden = '', idx = 0;
  for (let k = 0; k < parts.length; k++) {
    if (k > 0) blanked += ' ';
    for (const ch of parts[k]) {
      if (idx >= start && idx < end) { blanked += '_'; hidden += ch; }
      else { blanked += ch; }
      idx++;
    }
  }
  return { blanked: blanked.toLowerCase(), hidden: hidden.toLowerCase(), answerLen: hideLen, phraseLen: total };
}

// ── Replace target word in sentence with cloze blank ──
function sentenceWithCloze(sentence, word, cloze) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'i');
  if (re.test(sentence)) {
    return sentence.replace(re, cloze.blanked);
  }
  if (sentence.includes('____')) {
    return sentence.replace('____', cloze.blanked);
  }
  return sentence + ' (' + cloze.blanked + ')';
}

// ── Server ──
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }
  const { pathname, query } = url.parse(req.url, true);

  // ── Static files ──
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html'))
    return serveFile(res, 'frontend/index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && pathname === '/frontend/game.css')
    return serveFile(res, 'frontend/game.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard.html' || pathname === '/admin' || pathname === '/admin.html'))
    return serveFile(res, 'frontend/admin.html', 'text/html; charset=utf-8');

  // ── GET /api/challenges?level=G1&count=8 ──
  if (req.method === 'GET' && pathname === '/api/challenges') {
    let { level, count } = query;
    if (!level || !['G1', 'G2'].includes(level)) level = 'G1';
    const limit = Math.min(Math.max(parseInt(count) || 8, 1), 30);
    try {
      const words = db.prepare(
        'SELECT id, word, hint, sentence FROM words WHERE oxford_level = ? ORDER BY RANDOM() LIMIT ?'
      ).all(level, limit);
      if (!words.length)
        return json(res, { error: 'No words found for ' + level, words: [] });
      const challenges = words.map(w => {
        const cloze = makeCloze(w.word);
        const clue = w.sentence
          ? sentenceWithCloze(w.sentence, w.word, cloze)
          : `____ (${w.hint})`;
        return {
          id: w.id,
          word: w.word,
          hint: w.hint,
          sentence: w.sentence || '',
          clue,
          blanked: cloze.blanked,
          hidden: cloze.hidden,
          answerLen: cloze.answerLen
        };
      });
      json(res, challenges);
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/words?level=G1&count=15 ──
  if (req.method === 'GET' && pathname === '/api/words') {
    const { level, count } = query;
    const limit = Math.min(Math.max(parseInt(count) || 10, 1), 50);
    try {
      let rows;
      if (level && ['G1', 'G2'].includes(level))
        rows = db.prepare('SELECT id, word, hint, sentence FROM words WHERE oxford_level = ? ORDER BY RANDOM() LIMIT ?').all(level, limit);
      else
        rows = db.prepare('SELECT id, word, hint, sentence FROM words ORDER BY RANDOM() LIMIT ?').all(limit);
      json(res, rows);
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/stats ──
  if (req.method === 'GET' && pathname === '/api/stats') {
    const stats = db.prepare('SELECT oxford_level, COUNT(*) as count FROM words GROUP BY oxford_level').all();
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
        // Only word is required; hint/sentence are optional
        for (let i = 0; i < records.length; i++) {
          if (!records[i].word?.trim())
            return json(res, { error: `Row ${i + 2}: word missing` }, 400);
        }
        // oxford_level optional → default to 'G1'; allow 'G1' or 'G2'
        const ins = db.prepare(
          'INSERT OR REPLACE INTO words (oxford_level, word, hint, sentence) VALUES (?, ?, ?, ?)'
        );
        const del = db.prepare('DELETE FROM words');
        db.transaction(() => {
          del.run();
          records.forEach(r => {
            let lv = (r.oxford_level || 'G1').trim();
            if (!['G1', 'G2'].includes(lv)) lv = 'G1';
            ins.run(lv, r.word.trim(), (r.hint || '').trim(), (r.sentence || '').trim());
          });
        })();
        const stats = db.prepare('SELECT oxford_level, COUNT(*) as c FROM words GROUP BY oxford_level').all();
        json(res, { success: true, message: `Imported ${records.length} words`, stats });
      } catch (e) { json(res, { error: e.message }, 400); }
    });
    return;
  }

  // ── POST /api/log ── record game result
  if (req.method === 'POST' && pathname === '/api/log') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const log = JSON.parse(body);
        const { character, level, score, maxCombo, wordsTotal, wordsCorrect, wordsTimeout, wordsWrong, details } = log;
        if (!character || !level) return json(res, { error: 'character and level required' }, 400);
        const stmt = db.prepare(
          `INSERT INTO game_logs (character_name, level, score, max_combo, words_total, words_correct, words_timeout, words_wrong, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        stmt.run(
          character, level,
          score || 0, maxCombo || 0,
          wordsTotal || 0, wordsCorrect || 0,
          wordsTimeout || 0, wordsWrong || 0,
          JSON.stringify(details || [])
        );
        json(res, { success: true });
      } catch (e) { json(res, { error: e.message }, 400); }
    });
    return;
  }

  // ── GET /api/dashboard ──
  if (req.method === 'GET' && pathname === '/api/dashboard') {
    try {
      const summary = db.prepare(`
        SELECT 
          character_name, level,
          COUNT(*) as games,
          SUM(score) as totalScore,
          ROUND(AVG(score),1) as avgScore,
          MAX(score) as bestScore,
          MAX(max_combo) as bestCombo,
          SUM(words_correct) as correctWords,
          SUM(words_wrong) as wrongWords,
          SUM(words_timeout) as timeoutWords
        FROM game_logs
        GROUP BY character_name, level
        ORDER BY totalScore DESC
      `).all();
      const recent = db.prepare(
        'SELECT * FROM game_logs ORDER BY created_at DESC LIMIT 50'
      ).all();
      const daily = db.prepare(`
        SELECT date(created_at) as day, character_name, COUNT(*) as games,
               SUM(score) as score, MAX(max_combo) as topCombo
        FROM game_logs
        GROUP BY day, character_name
        ORDER BY day DESC, character_name
        LIMIT 60
      `).all();
      json(res, { summary, recent, daily });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/dashboard/clear ──
  if (req.method === 'GET' && pathname === '/api/dashboard/clear') {
    try {
      db.exec('DELETE FROM game_logs');
      json(res, { success: true });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`✅ Oxford Word Knight — http://localhost:${PORT}`);
});
