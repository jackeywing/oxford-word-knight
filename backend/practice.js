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
  function answer({ player, card, response, response_ms = 0, ip = '' }) {
    const p = player || 'guest';
    const ms = Math.max(0, parseInt(response_ms) || 0);
    const type = card.card_type;
    let ok = false;

    if (type === 'SYLLABLE_COUNTING') ok = Number(response) === Number(card.correct);
    else ok = String(response) === String(card.correct);

    const hesitant = ms > 5000;
    const newRecord = db.prepare(
      `SELECT 1 FROM word_state WHERE player_id = ? AND word = ?`
    ).get(p, card.word || card.audio_text || '');

    // ── 写回图谱 ──
    if (type === 'SYLLABLE_COUNTING') {
      const w = card.word;
      db.prepare(`
        INSERT INTO word_state (player_id, word, error_count, correct, expected, actual, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(player_id, word) DO UPDATE SET
          error_count = error_count + excluded.error_count,
          correct = correct + excluded.correct,
          expected = excluded.expected, actual = excluded.actual,
          last_seen = datetime('now','localtime')
      `).run(p, w, ok ? 0 : 1, ok ? 1 : 0, card.correct, Number(response) || 0);
      // 命中薄弱音素也加一点权重
      (card.meta.graphemes || []).forEach((g) => {
        const ph = PHONEME_PATTERNS.find((x) => x.grapheme === g);
        if (ph && !ok) bumpPhoneme(p, ph.phoneme, ph.grapheme, 0.3, false);
      });
    } else if (type === 'PHONEME_DISCRIMINATION') {
      const pair = card.reveal.phonemes;
      // 答错：正确音素加重；答对：轻微衰减
      bumpPhoneme(p, pair[card.correct === card.reveal.pair[0] ? 0 : 1],
        (card.meta.graphemes || [])[0] || '', ok ? -0.5 : 1.6, ok);
      if (!ok) {
        const otherSym = pair[card.correct === card.reveal.pair[0] ? 1 : 0];
        const otherG = (PHONEME_PATTERNS.find((x) => x.phoneme === otherSym) || {}).grapheme || '';
        bumpPhoneme(p, otherSym, otherG, 0.6, false);
      }
      db.prepare(`
        INSERT INTO word_state (player_id, word, error_count, correct, last_seen)
        VALUES (?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(player_id, word) DO UPDATE SET
          error_count = error_count + excluded.error_count,
          correct = correct + excluded.correct,
          last_seen = datetime('now','localtime')
      `).run(p, card.correct, ok ? 0 : 1, ok ? 1 : 0);
    } else if (type === 'PHONICS_CONTEXT_MATCH') {
      const ph = PHONEME_PATTERNS.find((x) => x.grapheme === card.reveal.grapheme);
      if (ph) bumpPhoneme(p, ph.phoneme, ph.grapheme, ok ? (hesitant ? -0.3 : -0.7) : 1.2, ok);
      db.prepare(`
        INSERT INTO word_state (player_id, word, error_count, correct, last_seen)
        VALUES (?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(player_id, word) DO UPDATE SET
          error_count = error_count + excluded.error_count,
          correct = correct + excluded.correct,
          last_seen = datetime('now','localtime')
      `).run(p, card.correct, ok ? 0 : 1, ok ? 1 : 0);
    } else if (type === 'SIGHT_WORD_FLASH') {
      db.prepare(`
        INSERT INTO word_state (player_id, word, error_count, correct, last_seen)
        VALUES (?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(player_id, word) DO UPDATE SET
          error_count = error_count + excluded.error_count,
          correct = correct + excluded.correct,
          last_seen = datetime('now','localtime')
      `).run(p, card.word, ok ? 0 : 1, ok ? 1 : 0);
    }

    db.prepare(
      `INSERT INTO practice_events (player_id, card_type, word, focus, is_correct, response_ms, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(p, type, card.word || card.audio_text || card.correct || '', card.focus || '', ok ? 1 : 0, ms, String(ip || ''));

    // ── 即时反馈文案（面向 8-9 岁） ──
    let fb;
    if (ok && ms < 2000) fb = { message: '太棒了！秒答！', type: 'encouragement', effect: 'confetti' };
    else if (ok) fb = { message: '答对了！做得好！', type: 'encouragement', effect: 'star' };
    else if (type === 'SYLLABLE_COUNTING')
      fb = { message: `这个词要这样切：${card.reveal.display}`, type: 'hint', hint: `拍着手跟着读：${card.reveal.display}`, effect: 'bounce', next_action: 'retry' };
    else if (type === 'PHONEME_DISCRIMINATION')
      fb = { message: `注意听：${card.reveal.phonemes[0]} 和 ${card.reveal.phonemes[1]} 是不同的音`, type: 'correction', hint: `${card.reveal.tip}！再听一遍`, effect: 'shake', next_action: 'retry' };
    else if (type === 'PHONICS_CONTEXT_MATCH')
      fb = { message: `${card.reveal.grapheme} 通常发 ${card.reveal.phoneme}`, type: 'hint', hint: `同家族的词还有：${card.reveal.family.join('、')}`, effect: 'glow', next_action: 'review_rule' };
    else
      fb = { message: `再记一次：${card.reveal.word} = ${card.reveal.zh}`, type: 'hint', hint: card.reveal.tip, effect: 'bounce', next_action: 'retry' };

    // 标点题：上面几条模板都基于单词/音素，用在这里会出现 undefined
    if (card.card_type === 'PUNCTUATION_MARK') {
      const mk = (card.reveal || {}).mark || card.correct;
      fb = ok
        ? { message: `答对了！这里用 ${mk}`, type: 'encouragement', effect: 'star' }
        : { message: `这里应该用 ${mk}`, type: 'correction', hint: (card.reveal || {}).tip || '', effect: 'shake', next_action: 'retry' };
    }

    return {
      is_correct: ok,
      correct_answer: card.correct,
      feedback: fb,
      reveal: ok ? card.reveal : card.reveal,     // 答对答错都给出讲解（教学优先）
      hesitant,
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
    `).get(p);
    const byType = db.prepare(`
      SELECT card_type, COUNT(*) n, SUM(is_correct) ok
        FROM practice_events WHERE player_id = ? GROUP BY card_type
    `).all(p);
    return {
      player: p,
      total: totals.n || 0,
      correct: totals.ok || 0,
      accuracy: totals.n ? Math.round((totals.ok / totals.n) * 100) : 0,
      avg_ms: totals.avg_ms || 0,
      weak_phonemes: weak,
      trouble_words: words.filter((w) => w.error_count > 0),
      by_type: byType,
    };
  }

  /* ───────────── 靶向推荐（等价"诊断即推书"） ───────────── */
  function troubleWordFallback(p, level) {
    // hints live on `words`, not on `word_state` — join instead of selecting w.hint
    const bad = db.prepare(`
      SELECT s.word, COALESCE(w.hint, '') hint
        FROM word_state s
        LEFT JOIN words w ON LOWER(w.word) = LOWER(s.word)
       WHERE s.player_id = ? AND s.error_count > 0
       ORDER BY s.error_count DESC, s.last_seen DESC LIMIT 8
    `).all(p);
    if (!bad.length) return null;
    return {
      reason: '这些词你错过，先回去读一遍',
      focus: [],
      words: bad.map(r => ({ word: r.word, hint: r.hint || '', grapheme: '', phoneme: '' })),
    };
  }

  function recommend(player, level) {
    const p = player || 'guest';
    const bank = wordsInBank(level);
    // 诊断（focus）与匹配（找词）要分开：
    //   allWeak —— 所有薄弱音素，含没有字母组合的（如 /ʃ/），用于告诉孩子「你弱在哪」
    //   weak    —— 其中带字母组合的，才可能回到词库层面匹配到词
    const allWeak = db.prepare(`
      SELECT phoneme, grapheme, error_weight FROM phoneme_state
       WHERE player_id = ? AND error_weight > 0
       ORDER BY error_weight DESC LIMIT 3
    `).all(p);
    const weak = allWeak.filter((w) => w.grapheme);

    if (!allWeak.length) {
      return troubleWordFallback(p, level)
        || { reason: '还没有明显薄弱点，继续按进度练习就好', focus: [], words: [] };
    }
    const picked = [];
    const reasons = [];
    for (const w of weak) {
      const hits = bank.filter((r) => w.grapheme && norm(r.word).includes(w.grapheme));
      if (hits.length) {
        reasons.push(`「${w.grapheme}」${w.phoneme} 错误权重 ${Math.round(w.error_weight * 100) / 100}`);
        hits.slice(0, 6).forEach((r) => {
          if (!picked.some((x) => x.word === r.word))
            picked.push({ word: r.word, hint: r.hint, grapheme: w.grapheme, phoneme: w.phoneme });
        });
      }
    }
    const focus = allWeak.map((w) => ({
      grapheme: w.grapheme || '', phoneme: w.phoneme, weight: Math.round(w.error_weight * 100) / 100,
    }));

    // 薄弱组合在本级字库里一个词都没有 → 退回"错过的词"，但诊断结论不能丢：
    // 孩子确实有这个薄弱点，focus 必须照常给出，否则 UI 会显示"没有焦点"
    if (!picked.length) {
      const fb = troubleWordFallback(p, level);
      if (fb) return { ...fb, focus };
    }

    return {
      reason: reasons.length ? '优先补这些音：' + reasons.join('；') : '继续巩固',
      focus,
      words: picked.slice(0, 12),
    };
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
