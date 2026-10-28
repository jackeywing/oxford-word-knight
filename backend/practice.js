'use strict';
/**
 * practice.js — 音素 / 音节 / 拼读 / 视觉词 特训引擎
 *
 * 设计说明
 * --------
 * 原设计基于 Neo4j 知识图谱（WordNode→SyllableNode→PhonemeNode）。
 * 本项目是 better-sqlite3，故用等价的关系建模：
 *
 *   phoneme_state(player_id, phoneme, error_weight, correct, wrong)   ← 等价 STRUGGLES_WITH
 *   word_state(player_id, word, error_count, correct, expected, actual) ← 等价 STRUGGLES_WITH_SYLLABLE
 *   practice_events(...)                                              ← 事件流（可复盘/可回放）
 *
 * 闭环：出题按薄弱音素加权 → 答题写回 error_weight → 下一题更偏向薄弱项 → 推荐页展示薄弱集。
 */

const E = require('../shared/engine.js');
const {
  SYLLABLE_OVERRIDES, CHARACTERS, ALL_NAMES, PHONEME_PATTERNS, MINIMAL_PAIRS, SIGHT_WORDS,
  charactersIn, characterLabel, syllabify, syllableCount, phonemesOf, weightedPick, cardWord, norm,
  createEngine,
} = E;

module.exports = function createPractice(db) {
  /* ───────────── schema ───────────── */
  db.exec(`
    CREATE TABLE IF NOT EXISTS phoneme_state (
      player_id TEXT NOT NULL,
      phoneme   TEXT NOT NULL,
      grapheme  TEXT NOT NULL DEFAULT '',
      error_weight REAL NOT NULL DEFAULT 0,
      correct   INTEGER NOT NULL DEFAULT 0,
      wrong     INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (player_id, phoneme)
    );
    CREATE TABLE IF NOT EXISTS word_state (
      player_id TEXT NOT NULL,
      word      TEXT NOT NULL,
      error_count INTEGER NOT NULL DEFAULT 0,
      correct     INTEGER NOT NULL DEFAULT 0,
      expected    INTEGER,
      actual      INTEGER,
      last_seen TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (player_id, word)
    );
    CREATE TABLE IF NOT EXISTS practice_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      card_type TEXT NOT NULL,
      word      TEXT NOT NULL DEFAULT '',
      focus     TEXT NOT NULL DEFAULT '',
      is_correct INTEGER NOT NULL,
      response_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_player ON practice_events(player_id, created_at);
  `);
  // 老库补 ip 列（幂等）
  try {
    const cols = db.prepare('PRAGMA table_info(practice_events)').all().map((c) => c.name);
    if (!cols.includes('ip')) db.exec("ALTER TABLE practice_events ADD COLUMN ip TEXT DEFAULT ''");
  } catch (e) {}

  /* ───────────── helpers ───────────── */

  const wordsInBank = (level) =>
    level ? db.prepare('SELECT oxford_level, word, hint, sentence, pos FROM words WHERE oxford_level = ?').all(level)
          : db.prepare('SELECT oxford_level, word, hint, sentence, pos FROM words').all();

  /** 玩家薄弱音素（error_weight 高者优先） */
  function weakPhonemes(player, minWeight = 0.6) {
    return db.prepare(
      `SELECT phoneme, grapheme, error_weight, correct, wrong
         FROM phoneme_state WHERE player_id = ? AND error_weight >= ?
         ORDER BY error_weight DESC LIMIT 12`
    ).all(player, minWeight);
  }

  function bumpPhoneme(player, phoneme, grapheme, delta, correct) {
    db.prepare(`
      INSERT INTO phoneme_state (player_id, phoneme, grapheme, error_weight, correct, wrong, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(player_id, phoneme) DO UPDATE SET
        error_weight = MAX(0, error_weight + excluded.error_weight),
        correct = correct + excluded.correct,
        wrong   = wrong + excluded.wrong,
        last_seen = datetime('now','localtime')
    `).run(player, phoneme, grapheme || '', delta, correct ? 1 : 0, correct ? 0 : 1);
  }

  /* ───────────── 出题引擎（唯一实现在 shared/engine.js）─────────────
   * 服务端只提供三个数据源，算法本身不在这里。
   * 静态版 build-pages.js 内联同一个文件，用 localStorage 充当这三个数据源。
   */
  const engine = createEngine({
    wordsInBank,
    weakPhonemes,
    wordErrors: (player) => {
      const rows = db.prepare('SELECT word, error_count FROM word_state WHERE player_id = ?').all(player);
      const m = {};
      for (const r of rows) m[String(r.word).toLowerCase()] = { e: r.error_count };
      return m;
    },
    // 人工权重：跨级别 JOIN，给 G1 的词加权后在 G2 也生效
    priorityWeight: (word) => {
      try {
        const r = db.prepare('SELECT weight FROM user_words WHERE LOWER(word) = ?')
          .get(String(word || '').toLowerCase());
        return r ? Number(r.weight) || 0 : 0;
      } catch (e) { return 0; }
    },
  });

  const nextTask = (opts) => engine.nextTask(opts);

  /* ───────────── 答题处理 + 图谱更新（闭环核心） ───────────── */
  /* ───────────── 答题处理（闭环核心） ─────────────
   * 判定、反馈文案、学情增量都由 shared/engine.js 提供（前后端共用同一份）。
   * 这里只负责把增量写进 SQLite。
   */
  function upsertWordState(p, w) {
    db.prepare(`
      INSERT INTO word_state (player_id, word, error_count, correct, expected, actual, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(player_id, word) DO UPDATE SET
        error_count = error_count + excluded.error_count,
        correct     = correct + excluded.correct,
        expected    = COALESCE(excluded.expected, expected),
        actual      = COALESCE(excluded.actual, actual),
        last_seen   = datetime('now','localtime')
    `).run(p, w.word, w.error ? 1 : 0, w.correct ? 1 : 0,
           w.expected === undefined ? null : w.expected,
           w.actual === undefined ? null : w.actual);
  }

  function answer({ player, card, response, response_ms = 0, ip = '' }) {
    const p = player || 'guest';
    const ms = Math.max(0, parseInt(response_ms) || 0);
    const type = card.card_type;

    const ok = E.gradeAnswer(card, response);
    const deltas = E.learningDeltas(card, ok, ms, response);

    for (const w of deltas.words) upsertWordState(p, w);
    for (const ph of deltas.phonemes) bumpPhoneme(p, ph.phoneme, ph.grapheme, ph.delta, ph.correct);

    db.prepare(
      `INSERT INTO practice_events (player_id, card_type, word, focus, is_correct, response_ms, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(p, type, card.word || card.audio_text || card.correct || '', card.focus || '', ok ? 1 : 0, ms, String(ip || ''));

    const fb = E.buildFeedback(card, ok, ms);
    return {
      is_correct: ok,
      correct_answer: card.correct,
      feedback: fb,
      reveal: card.reveal,                     // 答对答错都给讲解（教学优先）
      hesitant: deltas.hesitant,
      next_task_hint: ok ? 'continue' : (fb.next_action || 'retry'),
    };
  }

  /* ───────────── 学情画像（闭环可视） ───────────── */
  function profile(player) {
    const p = player || 'guest';
    const weak = db.prepare(`
      SELECT phoneme, grapheme, ROUND(error_weight,2) ew, correct, wrong
        FROM phoneme_state WHERE player_id = ? ORDER BY error_weight DESC LIMIT 10
    `).all(p);
    const words = db.prepare(`
      SELECT word, error_count, correct, expected, actual
        FROM word_state WHERE player_id = ? ORDER BY error_count DESC, last_seen DESC LIMIT 12
    `).all(p);
    const totals = db.prepare(`
      SELECT COUNT(*) n, SUM(is_correct) ok, ROUND(AVG(response_ms)) avg_ms
        FROM practice_events WHERE player_id = ?
    `).get(p) || {};
    const byType = db.prepare(`
      SELECT card_type, COUNT(*) n, SUM(is_correct) ok
        FROM practice_events WHERE player_id = ? GROUP BY card_type
    `).all(p);
    return E.buildProfile({ player: p, weakPhonemes: weak, words, totals, byType });
  }

  /* ───────────── 靶向推荐（等价"诊断即推书"） ───────────── */
  /** 错过的词（含中文提示），推荐兜底用 */
  function troubleWords(p) {
    // hints live on `words`, not on `word_state` — join instead of selecting w.hint
    const rows = db.prepare(`
      SELECT s.word, COALESCE(w.hint, '') hint
        FROM word_state s
        LEFT JOIN words w ON LOWER(w.word) = LOWER(s.word)
       WHERE s.player_id = ? AND s.error_count > 0
       ORDER BY s.error_count DESC, s.last_seen DESC LIMIT 8
    `).all(p);
    return rows.map((r) => ({ word: r.word, hint: r.hint || '', grapheme: '', phoneme: '' }));
  }

  function recommend(player, level) {
    const p = player || 'guest';
    const allWeak = db.prepare(`
      SELECT phoneme, grapheme, error_weight FROM phoneme_state
       WHERE player_id = ? AND error_weight > 0
       ORDER BY error_weight DESC LIMIT 3
    `).all(p);
    return E.buildRecommendation({
      allWeak,
      bank: wordsInBank(level),
      fallbackWords: troubleWords(p),
    });
  }

  return { nextTask, answer, profile, recommend, syllabify, syllableCount, phonemesOf,
           PHONEME_PATTERNS, MINIMAL_PAIRS, SIGHT_WORDS, CHARACTERS, charactersIn };
};

module.exports.syllabify = syllabify;
module.exports.syllableCount = syllableCount;
module.exports.PHONEME_PATTERNS = PHONEME_PATTERNS;
module.exports.CHARACTERS = CHARACTERS;
module.exports.charactersIn = charactersIn;
module.exports.CHARACTERS = CHARACTERS;
module.exports.MINIMAL_PAIRS = MINIMAL_PAIRS;
module.exports.SIGHT_WORDS = SIGHT_WORDS;
