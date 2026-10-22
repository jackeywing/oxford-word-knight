const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');
const createPractice = require('./practice');
const { buildWeightLookup } = require('./lexicon-weight.js');

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

// ── 音素 / 音节特训引擎 ──
const practice = createPractice(db);

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
      const ch = query.character;
      let words = db.prepare(
        'SELECT id, word, hint, sentence FROM words WHERE oxford_level = ? ORDER BY RANDOM()'
      ).all(level);
      if (ch) {
        // 只保留「本角色出场」或「中立叙述」的句子，角色台词排前面
        const mine = words.filter(w => practice.charactersIn(w.sentence).includes(ch));
        const neutral = words.filter(w => practice.charactersIn(w.sentence).length === 0);
        const filtered = mine.concat(neutral);
        if (filtered.length >= limit) words = filtered;
      }
      // 防御：即使库里混入重复词，同一轮也不允许出现两次
      const seenWord = new Set();
      words = words.filter((w) => {
        const k = String(w.word).trim().toLowerCase();
        if (seenWord.has(k)) return false;
        seenWord.add(k);
        return true;
      });
      // 人工高权重生词优先占位：最多占本轮 40%，权重高的排前面。
      // 注意：手动加权的词**不受当前 level 限制**——否则给 G1 的词加了权重，
      // 玩 G2 时永远抽不到（之前 rabbit 就是这样消失的）。
      try {
        const pri = db.prepare(`
          SELECT w.id, w.word, w.hint, w.sentence, u.weight
            FROM user_words u
            JOIN words w ON LOWER(w.word) = LOWER(u.word)
           ORDER BY u.weight DESC, RANDOM()
        `).all();
        if (pri.length) {
          const quota = Math.max(1, Math.ceil(limit * 0.4));
          const picked = pri.slice(0, quota);
          const priIds = new Set(picked.map((p) => p.id));
          words = picked.concat(words.filter((w) => !priIds.has(w.id)));
        }
      } catch (e) { /* user_words 表可能尚未建立 */ }

      words = words.slice(0, limit);
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
  // ── 人工高权重生词表（家长/老师手动录入，权重越高越优先出题）──
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL,
        hint TEXT DEFAULT '',
        sentence TEXT DEFAULT '',
        weight REAL NOT NULL DEFAULT 3,
        note TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_words_unique ON user_words(LOWER(word));
    `);
    // 人工生词必须保证在主词库里，否则重建词库后抽不到
    db.exec(`
      INSERT INTO words (oxford_level, word, hint, sentence, stage, pos)
      SELECT 'G2', u.word, u.hint, u.sentence, NULL, ''
        FROM user_words u
       WHERE LOWER(u.word) NOT IN (SELECT LOWER(word) FROM words)
    `);
  } catch (e) { /* 表已存在 */ }

  // ── GET /api/user-words ── 人工高权重生词
  if (req.method === 'GET' && pathname === '/api/user-words') {
    try {
      const rows = db.prepare(
        'SELECT id, word, hint, sentence, weight, note, created_at FROM user_words ORDER BY weight DESC, LOWER(word)'
      ).all();
      json(res, { words: rows });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── POST /api/user-words ── 新增/更新（body: {word, hint?, sentence?, weight?, note?}）
  if (req.method === 'POST' && pathname === '/api/user-words') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}');
        const word = String(b.word || '').trim();
        if (!word) return json(res, { error: 'word 不能为空' }, 400);
        if (!/^[A-Za-z][A-Za-z' -]*$/.test(word)) return json(res, { error: '只接受英文字母单词' }, 400);
        const hint = String(b.hint || '').trim();
        const sentence = String(b.sentence || '').trim();
        const note = String(b.note || '').trim();
        const raw = Number(b.weight);
        // 权重 0（或空）表示"取消手动加权"，直接从表里移除
        if (b.weight !== undefined && b.weight !== '' && (!raw || raw <= 0)) {
          db.prepare('DELETE FROM user_words WHERE LOWER(word) = LOWER(?)').run(word);
          return json(res, { success: true, removed: true });
        }
        const weight = Math.max(1, Math.min(5, raw || 3));

        db.prepare(`
          INSERT INTO user_words (word, hint, sentence, weight, note) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(LOWER(word)) DO UPDATE SET
            hint     = CASE WHEN excluded.hint <> ''     THEN excluded.hint     ELSE hint END,
            sentence = CASE WHEN excluded.sentence <> '' THEN excluded.sentence ELSE sentence END,
            note     = CASE WHEN excluded.note <> ''     THEN excluded.note     ELSE note END,
            weight   = excluded.weight
        `).run(word, hint, sentence, weight, note);

        // 同步进主词库，保证能被抽到（已存在则只补空缺）
        db.prepare(`
          INSERT INTO words (oxford_level, word, hint, sentence, stage, pos) VALUES ('G2', ?, ?, ?, NULL, '')
          ON CONFLICT(LOWER(word)) DO UPDATE SET
            hint     = CASE WHEN hint = ''     THEN excluded.hint     ELSE hint END,
            sentence = CASE WHEN sentence = '' THEN excluded.sentence ELSE sentence END
        `).run(word, hint, sentence);

        const saved = db.prepare('SELECT * FROM user_words WHERE LOWER(word) = LOWER(?)').get(word);
        json(res, { success: true, word: saved });
      } catch (e) { json(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── POST /api/user-words/delete ── body: {word}
  if (req.method === 'POST' && pathname === '/api/user-words/delete') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}');
        const word = String(b.word || '').trim();
        if (!word) return json(res, { error: 'word 不能为空' }, 400);
        db.prepare('DELETE FROM user_words WHERE LOWER(word) = LOWER(?)').run(word);
        json(res, { success: true });
      } catch (e) { json(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── GET /api/lexicon ── 词库全量 + 统计（后台浏览用）
  if (req.method === 'GET' && pathname === '/api/lexicon') {
    try {
      const rows = db.prepare(
        'SELECT id, word, hint, sentence, oxford_level, stage, pos FROM words ORDER BY oxford_level, LOWER(word)'
      ).all();
      const byWord = new Map();
      for (const r of rows) {
        const k = String(r.word).trim().toLowerCase();
        byWord.set(k, (byWord.get(k) || 0) + 1);
      }
      const duplicates = [...byWord.entries()]
        .filter(([, n]) => n > 1)
        .map(([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

      const isPhrase = (w) => /\s/.test(String(w).trim());
      const sylBuckets = { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };
      const byLevel = {};
      const letters = {};
      let lenSum = 0;
      for (const r of rows) {
        const n = practice.syllableCount(r.word);
        sylBuckets[Math.min(n, 5)] = (sylBuckets[Math.min(n, 5)] || 0) + 1;
        if (n >= 5) sylBuckets['5+'] = (sylBuckets['5+'] || 0) + 1;
        byLevel[r.oxford_level] = (byLevel[r.oxford_level] || 0) + 1;
        const c = String(r.word).trim().toLowerCase()[0] || '#';
        letters[c] = (letters[c] || 0) + 1;
        lenSum += String(r.word).trim().length;
      }

      const stats = {
        rows: rows.length,
        unique: byWord.size,
        duplicates,
        phrases: rows.filter((r) => isPhrase(r.word)).length,
        byLevel,
        avgLen: rows.length ? Math.round((lenSum / rows.length) * 10) / 10 : 0,
        syllables: sylBuckets,
        letters,
        withSentence: rows.filter((r) => String(r.sentence).trim()).length,
        withCharacter: rows.filter((r) => practice.charactersIn(r.sentence).length > 0).length,
        byStage: rows.reduce((a, r) => { const k = r.stage ? 'S' + r.stage : '未分级'; a[k] = (a[k] || 0) + 1; return a; }, {}),
      };

      const weightOf = buildWeightLookup(db);
      const manualMap = new Map(
        db.prepare('SELECT LOWER(word) w, weight FROM user_words').all().map((u) => [u.w, u.weight])
      );

      const words = rows.map((r) => {
        const syllables = practice.syllableCount(r.word);
        const letters = String(r.word).trim().length;
        const graphemes = practice.phonemesOf(r.word).map((p) => p.grapheme);
        return {
          ...r,
          syllables,
          letters,
          isPhrase: isPhrase(r.word),
          phonemes: graphemes,
          characters: practice.charactersIn(r.sentence),
          weight: weightOf(r.word, { syllables, letters, graphemes, stage: r.stage }),
          manualWeight: manualMap.get(String(r.word).trim().toLowerCase()) || 0,
        };
      });

      const byBasis = (b) => words.filter((w) => w.weight.basis === b);
      const direct = byBasis('direct'), prop = byBasis('propagated'), est = byBasis('estimated');
      stats.weight = {
        directCount: direct.length,
        propagatedCount: prop.length,
        estimatedCount: est.length,
        maxMeasured: direct.length ? Math.max(...direct.map((w) => w.weight.measured)) : 0,
        avgEstimated: Math.round(
          (est.reduce((a, w) => a + w.weight.estimated, 0) / Math.max(1, est.length)) * 100
        ) / 100,
        top: words.slice().sort((a, b) => b.weight.value - a.weight.value).slice(0, 15)
          .map((w) => ({ word: w.word, value: w.weight.value, basis: w.weight.basis, players: w.weight.parts.players })),
      };

      json(res, { stats, words });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

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
      /* ── 音素 / 音节特训统计（practice_events / phoneme_state / word_state）── */
      const pTotals = db.prepare(`
        SELECT COUNT(*) n,
               COALESCE(SUM(is_correct), 0) ok,
               COALESCE(ROUND(AVG(response_ms)), 0) avgMs
          FROM practice_events
      `).get();
      const pByType = db.prepare(`
        SELECT card_type,
               COUNT(*) n,
               SUM(is_correct) ok,
               ROUND(AVG(response_ms)) avgMs
          FROM practice_events
         GROUP BY card_type
         ORDER BY n DESC
      `).all();
      const pByPlayer = db.prepare(`
        SELECT player_id,
               COUNT(*) n,
               SUM(is_correct) ok,
               ROUND(AVG(response_ms)) avgMs,
               MAX(created_at) lastAt
          FROM practice_events
         GROUP BY player_id
         ORDER BY n DESC
      `).all();
      const pDaily = db.prepare(`
        SELECT date(created_at) day, COUNT(*) n, SUM(is_correct) ok
          FROM practice_events
         GROUP BY day
         ORDER BY day DESC
         LIMIT 30
      `).all();
      const pRecent = db.prepare(
        'SELECT * FROM practice_events ORDER BY id DESC LIMIT 80'
      ).all();
      const pWeak = db.prepare(`
        SELECT player_id, phoneme, grapheme,
               ROUND(error_weight, 2) errorWeight, correct, wrong
          FROM phoneme_state
         WHERE error_weight > 0
         ORDER BY error_weight DESC
         LIMIT 20
      `).all();
      const pWords = db.prepare(`
        SELECT player_id, word, error_count errorCount, correct
          FROM word_state
         WHERE error_count > 0
         ORDER BY error_count DESC, last_seen DESC, word
         LIMIT 20
      `).all();
      const pct = (ok, n) => (n ? Math.round((ok / n) * 100) : 0);
      const practiceStats = {
        total: pTotals.n || 0,
        correct: pTotals.ok || 0,
        accuracy: pct(pTotals.ok || 0, pTotals.n || 0),
        avgMs: pTotals.avgMs || 0,
        players: pByPlayer.length,
        byType: pByType.map((r) => ({ ...r, accuracy: pct(r.ok || 0, r.n) })),
        byPlayer: pByPlayer.map((r) => ({ ...r, accuracy: pct(r.ok || 0, r.n) })),
        daily: pDaily.map((r) => ({ ...r, accuracy: pct(r.ok || 0, r.n) })),
        recent: pRecent,
        weakPhonemes: pWeak,
        troubleWords: pWords,
      };
      json(res, { summary, recent, daily, practice: practiceStats });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/dashboard/clear ──
  if (req.method === 'GET' && pathname === '/api/dashboard/clear') {
    try {
      db.exec('DELETE FROM game_logs');
      db.exec('DELETE FROM practice_events');
      db.exec('DELETE FROM phoneme_state');
      db.exec('DELETE FROM word_state');
      json(res, { success: true });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /practice ── 音素 / 音节特训页面
  if (req.method === 'GET' && (pathname === '/lexicon' || pathname === '/lexicon.html'))
    return serveFile(res, 'frontend/lexicon.html', 'text/html; charset=utf-8');

  if (req.method === 'GET' && (pathname === '/practice' || pathname === '/practice.html'))
    return serveFile(res, 'frontend/practice.html', 'text/html; charset=utf-8');

  // ── GET /api/practice/next?level=G1&type=syllable|phoneme|phonics|sight&player=biff ──
  if (req.method === 'GET' && pathname === '/api/practice/next') {
    try {
      const card = practice.nextTask({
        player: query.player || 'guest',
        level: ['G1', 'G2'].includes(query.level) ? query.level : 'G1',
        type: query.type,
        character: query.character || '',
      });
      json(res, card);
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── POST /api/practice/answer  { player, card, response, response_ms } ──
  if (req.method === 'POST' && pathname === '/api/practice/answer') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { player, card, response, response_ms } = JSON.parse(body);
        if (!card || card.correct === undefined)
          return json(res, { error: 'card required' }, 400);
        const result = practice.answer({ player, card, response, response_ms });
        json(res, result);
      } catch (e) { json(res, { error: e.message }, 400); }
    });
    return;
  }

  // ── GET /api/practice/characters ── 牛津树人物清单（含 Floppy）
  if (req.method === 'GET' && pathname === '/api/practice/characters') {
    json(res, Object.entries(practice.CHARACTERS).map(([id, c]) => ({ id, ...c })));
    return;
  }

  // ── GET /api/practice/profile?player=biff ──
  if (req.method === 'GET' && pathname === '/api/practice/profile') {
    try { json(res, practice.profile(query.player || 'guest')); }
    catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/practice/recommend?level=G1&player=biff ──
  if (req.method === 'GET' && pathname === '/api/practice/recommend') {
    try {
      json(res, practice.recommend(
        query.player || 'guest',
        ['G1', 'G2'].includes(query.level) ? query.level : 'G1'
      ));
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── GET /api/practice/reset?player=biff ── 清空该玩家的学情
  if (req.method === 'GET' && pathname === '/api/practice/reset') {
    try {
      const p = query.player || 'guest';
      db.prepare('DELETE FROM phoneme_state WHERE player_id = ?').run(p);
      db.prepare('DELETE FROM word_state WHERE player_id = ?').run(p);
      db.prepare('DELETE FROM practice_events WHERE player_id = ?').run(p);
      json(res, { success: true, player: p });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`✅ Oxford Word Knight — http://localhost:${PORT}`);
});
