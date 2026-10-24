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

const SYLLABLE_OVERRIDES = {
  // 常见不规则词：算法会数错的，显式纠正（值 = 音节切分）
  orange: ['or', 'ange'], every: ['ev', 'ery'],
  everything: ['ev', 'ery', 'thing'], everyone: ['ev', 'ery', 'one'],
  everybody: ['ev', 'ery', 'bod', 'y'], somewhere: ['some', 'where'], interesting: ['in', 'ter', 'est', 'ing'],
  chocolate: ['choc', 'o', 'late'], family: ['fam', 'i', 'ly'], animal: ['an', 'i', 'mal'],
  camera: ['cam', 'er', 'a'], vegetable: ['veg', 'e', 'ta', 'ble'], favourite: ['fa', 'vour', 'ite'],
  favorite: ['fa', 'vor', 'ite'], beautiful: ['beau', 'ti', 'ful'], business: ['busi', 'ness'],
  people: ['peo', 'ple'], water: ['wa', 'ter'], fire: ['fire'], hour: ['hour'], our: ['our'],
  science: ['sci', 'ence'], quiet: ['qui', 'et'], lion: ['li', 'on'], poem: ['po', 'em'],
  area: ['ar', 'e', 'a'], idea: ['i', 'de', 'a'], real: ['re', 'al'], being: ['be', 'ing'],
  comfortable: ['comf', 'ta', 'ble'],
  flower: ['flow', 'er'], power: ['pow', 'er'], tower: ['tow', 'er'], shower: ['show', 'er'],
};

/* ───────────────────────── 牛津树人物 ───────────────────────── */
const CHARACTERS = {
  biff:   { label: 'Biff',   emoji: '👧🏻', pet: false },
  chip:   { label: 'Chip',   emoji: '🧒🏻', pet: false },
  kipper: { label: 'Kipper', emoji: '👦🏻', pet: false },
  wilma:  { label: 'Wilma',  emoji: '👧🏽', pet: false },
  floppy: { label: 'Floppy', emoji: '🐶',  pet: true  },   // 家里的狗，会跟着一起冒险
};
const ALL_NAMES = ['biff', 'chip', 'kipper', 'wilma', 'floppy', 'wilf', 'gran', 'mum', 'dad', 'nadim', 'anneena', 'floppy'];

/** 句子里出现了哪些牛津树人物（小写数组） */
function charactersIn(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const n of ALL_NAMES) if (new RegExp('\\b' + n + '\\b').test(s) && !out.includes(n)) out.push(n);
  return out;
}
const characterLabel = (c) => (CHARACTERS[c] || {}).label || '';

const VOWELS = 'aeiouy';
const isVowel = (c) => VOWELS.includes(c);

/** 把单词切成音节数组。算法与判定同源，保证"显示=判定"。 */
function syllabify(word) {
  const raw = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!raw) return [String(word || '')];
  if (SYLLABLE_OVERRIDES[raw]) return SYLLABLE_OVERRIDES[raw].slice();
  if (raw.length <= 3) return [raw];
  if (raw.length <= 4 && /[^aeiouy]y$/.test(raw)) return [raw];   // happy→2 但 tiny/handy 视作 1 会错，故仅 <=4 且短

  let w = raw;
  // 1) 词尾静音 e：不是元音组合、也不是 C+le 时丢弃
  if (w.endsWith('e') && !/([aeiouy])e$/.test(w)) {
    const beforeE = w[w.length - 2];
    const isConsLe = w.endsWith('le') && beforeE !== 'e' && !isVowel(w[w.length - 3] || '');
    if (!isConsLe) w = w.slice(0, -1);
  }

  // 2) 找元音组
  const groups = [];
  let start = -1;
  for (let i = 0; i < w.length; i++) {
    if (isVowel(w[i])) { if (start < 0) start = i; }
    else if (start >= 0) { groups.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) groups.push([start, w.length - 1]);
  if (groups.length <= 1) return [raw];

  // 3) 在元音组之间下刀
  const cuts = [];
  for (let g = 0; g < groups.length - 1; g++) {
    const endV = groups[g][1];
    const startNext = groups[g + 1][0];
    const cluster = startNext - endV - 1;
    // 辅音丛归属：1→归后(V-CV)  2→对半分(VC-CV)  3+→首辅音归后
    let cut;
    if (cluster === 0) cut = startNext;
    else cut = endV + 1 + Math.floor(cluster / 2);
    cuts.push(cut);
  }

  const parts = [];
  let prev = 0;
  cuts.forEach((c) => { parts.push(raw.slice(prev, c)); prev = c; });
  parts.push(raw.slice(prev));
  return parts.filter(Boolean);
}

const syllableCount = (word) => syllabify(word).length;

/* ───────────────────────── 音素清单（可教学的拼写→音） ───────────────────────── */
const PHONEME_PATTERNS = [
  { phoneme: '/aɪ/', grapheme: 'igh', articulation: '嘴张开滑动到 /i/，像 "I"', example: 'night', kind: 'vowel' },
  { phoneme: '/iː/', grapheme: 'ee', articulation: '嘴角向两边拉平，长音', example: 'see', kind: 'vowel' },
  { phoneme: '/iː/', grapheme: 'ea', articulation: '嘴角向两边拉平，长音', example: 'tea', kind: 'vowel' },
  { phoneme: '/uː/', grapheme: 'oo', articulation: '嘴唇收圆前突', example: 'moon', kind: 'vowel' },
  { phoneme: '/eɪ/', grapheme: 'ai', articulation: '从 /e/ 滑到 /ɪ/，双元音', example: 'rain', kind: 'vowel' },
  { phoneme: '/eɪ/', grapheme: 'ay', articulation: '同 ai，词尾常见', example: 'play', kind: 'vowel' },
  { phoneme: '/əʊ/', grapheme: 'oa', articulation: '从 /ə/ 滑到 /ʊ/', example: 'boat', kind: 'vowel' },
  { phoneme: '/aʊ/', grapheme: 'ou', articulation: '从 /a/ 滑到 /ʊ/', example: 'house', kind: 'vowel' },
  { phoneme: '/aʊ/', grapheme: 'ow', articulation: '同 ou', example: 'cow', kind: 'vowel' },
  { phoneme: '/ɔɪ/', grapheme: 'oi', articulation: '从 /ɔ/ 滑到 /ɪ/', example: 'coin', kind: 'vowel' },
  { phoneme: '/ɔɪ/', grapheme: 'oy', articulation: '同 oi，词尾常见', example: 'boy', kind: 'vowel' },
  { phoneme: '/ɑː/', grapheme: 'ar', articulation: '嘴张大，舌后缩', example: 'car', kind: 'vowel' },
  { phoneme: '/ɔː/', grapheme: 'or', articulation: '圆唇，舌后缩', example: 'fork', kind: 'vowel' },
  { phoneme: '/ɜː/', grapheme: 'er', articulation: '中央元音，舌平放', example: 'her', kind: 'vowel' },
  { phoneme: '/ɜː/', grapheme: 'ir', articulation: '同 er', example: 'bird', kind: 'vowel' },
  { phoneme: '/ɜː/', grapheme: 'ur', articulation: '同 er', example: 'turn', kind: 'vowel' },
  { phoneme: '/ʃ/', grapheme: 'sh', articulation: '嘴唇微前突，气流摩擦，不振动声带', example: 'ship', kind: 'consonant' },
  { phoneme: '/tʃ/', grapheme: 'ch', articulation: '先堵住再释放，像打喷嚏前一刻', example: 'chip', kind: 'consonant' },
  { phoneme: '/θ/', grapheme: 'th', articulation: '舌尖轻放上下齿之间，送气', example: 'think', kind: 'consonant' },
  { phoneme: '/ŋ/', grapheme: 'ng', articulation: '舌根抵住软腭，鼻音', example: 'king', kind: 'consonant' },
  { phoneme: '/f/', grapheme: 'ph', articulation: '上齿轻咬下唇送气', example: 'phone', kind: 'consonant' },
  { phoneme: '/dʒ/', grapheme: 'j', articulation: '同 ch 但声带振动', example: 'jump', kind: 'consonant' },
  { phoneme: '/r/', grapheme: 'r', articulation: '舌尖卷起但不碰上颚', example: 'red', kind: 'consonant' },
  { phoneme: '/l/', grapheme: 'l', articulation: '舌尖抵上齿龈，气流从两侧出', example: 'leg', kind: 'consonant' },
  { phoneme: '/v/', grapheme: 'v', articulation: '上齿咬下唇，声带振动', example: 'van', kind: 'consonant' },
  { phoneme: '/w/', grapheme: 'w', articulation: '双唇收圆再放开', example: 'wet', kind: 'consonant' },
];

/* ───────────────────────── 最小对立对（Minimal Pairs） ───────────────────────── */
const MINIMAL_PAIRS = [
  { a: 'ship', b: 'sheep', pa: '/ɪ/', pb: '/iː/', zh_a: '船', zh_b: '羊', tip: '短音 vs 长音' },
  { a: 'ship', b: 'chip', pa: '/ʃ/', pb: '/tʃ/', zh_a: '船', zh_b: '薯条', tip: '摩擦音 vs 破擦音' },
  { a: 'think', b: 'sink', pa: '/θ/', pb: '/s/', zh_a: '想', zh_b: '水槽', tip: '咬舌 vs 不咬舌' },
  { a: 'three', b: 'tree', pa: '/θ/', pb: '/t/', zh_a: '三', zh_b: '树', tip: '咬舌 vs 不咬舌' },
  { a: 'rice', b: 'lice', pa: '/r/', pb: '/l/', zh_a: '米饭', zh_b: '虱子', tip: '卷舌 vs 舌尖抵齿龈' },
  { a: 'right', b: 'light', pa: '/r/', pb: '/l/', zh_a: '右边', zh_b: '光', tip: '卷舌 vs 舌尖抵齿龈' },
  { a: 'red', b: 'led', pa: '/r/', pb: '/l/', zh_a: '红色', zh_b: '带领(过去式)', tip: '卷舌 vs 舌尖抵齿龈' },
  { a: 'vet', b: 'wet', pa: '/v/', pb: '/w/', zh_a: '兽医', zh_b: '湿的', tip: '咬唇 vs 圆唇' },
  { a: 'fan', b: 'van', pa: '/f/', pb: '/v/', zh_a: '风扇', zh_b: '货车', tip: '清音 vs 浊音' },
  { a: 'pin', b: 'pen', pa: '/ɪ/', pb: '/e/', zh_a: '别针', zh_b: '钢笔', tip: '短 i vs 短 e' },
  { a: 'bat', b: 'bet', pa: '/æ/', pb: '/e/', zh_a: '球棒', zh_b: '打赌', tip: '嘴张更大 vs 更小' },
  { a: 'coat', b: 'goat', pa: '/k/', pb: '/g/', zh_a: '外套', zh_b: '山羊', tip: '清音 vs 浊音' },
];

/* ───────────────────────── 视觉词（Dolch 高频不可拼读词） ───────────────────────── */
const SIGHT_WORDS = [
  ['the', 1, '这个'], ['and', 2, '和'], ['you', 3, '你'], ['that', 4, '那个'], ['was', 5, '是(过去)'],
  ['for', 6, '为了'], ['are', 7, '是'], ['with', 8, '和…一起'], ['they', 9, '他们'], ['have', 10, '有'],
  ['this', 11, '这个'], ['from', 12, '从'], ['one', 13, '一'], ['had', 14, '有(过去)'], ['word', 15, '单词'],
  ['what', 16, '什么'], ['were', 17, '是(过去)'], ['when', 18, '什么时候'], ['your', 19, '你的'], ['said', 20, '说(过去)'],
  ['there', 21, '那里'], ['each', 22, '每个'], ['which', 23, '哪一个'], ['she', 24, '她'], ['how', 25, '怎样'],
  ['their', 26, '他们的'], ['will', 27, '将要'], ['other', 28, '其他的'], ['about', 29, '关于'], ['many', 30, '许多'],
  ['then', 31, '然后'], ['them', 32, '他们(宾)'], ['these', 33, '这些'], ['some', 34, '一些'], ['would', 35, '将会'],
  ['make', 36, '制作'], ['like', 37, '喜欢'], ['him', 38, '他(宾)'], ['into', 39, '进入'], ['time', 40, '时间'],
];

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
    level ? db.prepare('SELECT oxford_level, word, hint, sentence FROM words WHERE oxford_level = ?').all(level)
          : db.prepare('SELECT oxford_level, word, hint, sentence FROM words').all();

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

  /** 该词命中的可教学音素（拼写模式匹配） */
  function phonemesOf(word) {
    const w = norm(word);
    const out = [];
    for (const p of PHONEME_PATTERNS) {
      if (w.includes(p.grapheme)) {
        // 避免重复计入同一音素（如 ee/ea 同时命中）
        if (!out.some((o) => o.phoneme === p.phoneme && o.grapheme === p.grapheme)) out.push(p);
      }
    }
    return out;
  }

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

  /* ───────────── 1. 音节计数 ───────────── */
  function makeSyllableCard(player, level, character) {
    // 只取单个纯字母单词：多词短语（"more than"）会被错误合并切分
    const bank = wordsInBank(level)
      .filter((r) => /^[a-z]{3,}$/i.test(String(r.word).trim()));
    if (!bank.length) return null;
    const weak = weakPhonemes(player);
    const weakSet = new Set(weak.map((w) => w.grapheme).filter(Boolean));

    // 加权：优先长词 + 命中薄弱音素
    const scored = bank.map((r) => {
      const ph = phonemesOf(r.word);
      const hit = ph.filter((p) => weakSet.has(p.grapheme)).length;
      const syl = syllableCount(r.word);
      return { row: r, score: 1 + syl * 0.8 + hit * 1.5 + Math.random() * 0.8, syl, ph };
    }).sort((a, b) => b.score - a.score);

    const pick = weightedPick(scored, (x) => x.score);
    const n = pick.syl;
    const opts = [];
    if (n > 1) opts.push(n - 1);
    opts.push(n + 1);
    if (n > 2 && Math.random() < 0.5) opts.push(n - 2);
    const options = [...new Set([...opts, n])].sort((a, b) => a - b);

    const parts = syllabify(pick.row.word);
    return {
      card_type: 'SYLLABLE_COUNTING',
      word: pick.row.word,
      hint: pick.row.hint,
      speaker: CHARACTERS[character] || null,
      prompt: (characterLabel(character) ? characterLabel(character) + ' 想考考你：' : '') + '这个词有几个音节？拍着手读一读',
      options,
      correct: n,
      focus: 'syllable',        // 不提前下发切分，否则数圆点即可得答案
      // 答题后才下发的讲解（前端不提前拿到）
      reveal: {
        syllables: parts,
        display: parts.join(' · '),
        tip: n >= 3 ? '长单词可以分段读，先读第一部分再读第二部分。' : '每个元音组通常就是一个音节。',
      },
      meta: { oxford_level: pick.row.oxford_level, graphemes: pick.ph.map((p) => p.grapheme) },
    };
  }

  /* ───────────── 2. 音素辨析（最小对立对） ───────────── */
  function makePhonemeCard(player, level) {
    const bank = new Set(wordsInBank(level).map((r) => norm(r.word)));
    const weak = weakPhonemes(player);
    const weakMap = new Map(weak.map((w) => [w.phoneme, w.error_weight]));

    const scored = MINIMAL_PAIRS.map((p) => {
      const weight = Math.max(weakMap.get(p.pa) || 0, weakMap.get(p.pb) || 0);
      const inBank = (bank.has(norm(p.a)) ? 1 : 0) + (bank.has(norm(p.b)) ? 1 : 0);
      return { p, score: 1 + weight * 2 + inBank * 0.6 + Math.random() * 0.7 };
    }).sort((a, b) => b.score - a.score);

    const { p } = weightedPick(scored, (x) => x.score);
    const targetIsA = Math.random() < 0.5;
    const target = targetIsA ? p.a : p.b;
    return {
      card_type: 'PHONEME_DISCRIMINATION',
      audio_text: target,
      prompt: '听一听，选出你听到的词',
      options: [p.a, p.b],
      correct: target,
      focus: targetIsA ? p.pa : p.pb,
      reveal: {
        pair: [p.a, p.b],
        phonemes: [p.pa, p.pb],
        meanings: [p.zh_a, p.zh_b],
        tip: p.tip,
        target,
      },
      meta: { phoneme_a: p.pa, phoneme_b: p.pb, graphemes: PHONEME_PATTERNS.filter((x) => x.phoneme === (targetIsA ? p.pa : p.pb)).map((x) => x.grapheme) },
    };
  }

  /* ───────────── 3. 拼读规则（语境选词） ───────────── */
  function makePhonicsCard(player, level, character) {
    // 只保留「中立叙述」或「本角色出场」的句子，避免 Biff 的题里冒出 Wilma 的台词
    const all = wordsInBank(level).filter((r) => r.sentence);
    if (!all.length) return makeSyllableCard(player, level, character);
    let bank = character
      ? all.filter((r) => {
          const cs = charactersIn(r.sentence);
          return cs.length === 0 || cs.includes(character);
        })
      : all;
    if (bank.length < 4) bank = all;          // 兜底：过滤后太少就读全库
    const isOwnLine = (r) => !!character && charactersIn(r.sentence).includes(character);
    const weak = weakPhonemes(player);
    const weakMap = new Map(weak.map((w) => [w.phoneme, w.error_weight]));

    const candidates = [];
    for (const p of PHONEME_PATTERNS) {
      if (p.grapheme.length < 2) continue;                 // 只教字母组合，不教单字母
      const hits = bank.filter((r) => norm(r.word).includes(p.grapheme));
      if (hits.length >= 2) candidates.push({ p, hits });
    }
    if (!candidates.length) return makeSyllableCard(player, level, character);

    // 选规则时也考虑「本角色有没有台词落在该规则里」，否则 Floppy 这类台词少的角色永远抽不到自己
    const ownCount = (hits) => hits.filter(isOwnLine).length;
    const scored = candidates.map((c) => ({
      ...c,
      score: 1 + (weakMap.get(c.p.phoneme) || 0) * 2 + Math.min(c.hits.length, 6) * 0.3
             + ownCount(c.hits) * 3.0 + Math.random() * 0.8,
    })).sort((a, b) => b.score - a.score);

    const chosen = weightedPick(scored, (x) => x.score);   // 之前永远是 scored[0]，规则退化成固定 1 条
    // 角色亲口说过的句子优先（3 倍权重），中立句子兜底
    const ownHits = chosen.hits.filter(isOwnLine);
    const preferred = ownHits.length ? ownHits : chosen.hits;
    const hitsSingle = preferred.filter(r => /^[a-z]+$/i.test(String(r.word).trim()));
    const poolSingle = bank.filter(r => /^[a-z]+$/i.test(String(r.word).trim()));
    const usePool = hitsSingle.length >= 2 ? hitsSingle : (preferred.length ? preferred : poolSingle);
    const targetRow = usePool[Math.floor(Math.random() * usePool.length)];
    const target = targetRow.word;
    const sameRule = usePool.filter((r) => norm(r.word) !== norm(target)).slice(0, 2);
    const decoys = poolSingle.filter((r) => !norm(r.word).includes(chosen.p.grapheme)).slice(0, 1);

    let options = [target, ...sameRule.map((r) => r.word), ...decoys.map((r) => r.word)];
    options = [...new Set(options)];
    while (options.length < 3 && bank.length > options.length) {
      const extra = bank[Math.floor(Math.random() * bank.length)].word;
      if (!options.includes(extra)) options.push(extra);
    }
    options.sort(() => Math.random() - 0.5);

    const blanked = targetRow.sentence.replace(
      new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      '_____'
    );

    return {
      card_type: 'PHONICS_CONTEXT_MATCH',
      speaker: CHARACTERS[character] || null,
      speaker_is_own_line: isOwnLine(targetRow),
      prompt: (characterLabel(character) && isOwnLine(targetRow))
        ? characterLabel(character) + ' 说的这句话缺了一个词'
        : '这句话里的空格应该填哪个词？',
      sentence: blanked.includes('_____') ? blanked : `${blanked} ( _____ )`,
      hint: targetRow.hint,
      options,
      correct: target,
      focus: chosen.p.grapheme,
      reveal: {
        grapheme: chosen.p.grapheme,
        phoneme: chosen.p.phoneme,
        articulation: chosen.p.articulation,
        family: usePool.map((r) => r.word).slice(0, 6),
        tip: `字母组合 ${chosen.p.grapheme} 通常发 ${chosen.p.phoneme}`,
      },
      meta: { rule: chosen.p.grapheme },
    };
  }

  /* ───────────── 4. 视觉词闪卡 ───────────── */
  function makeSightWordCard(player, level) {
    const seen = db.prepare(
      `SELECT word, error_count FROM word_state WHERE player_id = ?`
    ).all(player);
    const seenMap = new Map(seen.map((s) => [s.word, s.error_count]));
    // 全池加权：错过的词权重高，高频词（rank 小）略高，其余均匀
    const pool = SIGHT_WORDS.map(([word, rank, zh]) => ({ word, rank, zh, err: seenMap.get(word) || 0 }));
    const target = weightedPick(pool, (x) => 1 + x.err * 6 + 6 / Math.max(1, x.rank));

    const others = SIGHT_WORDS.filter(([w]) => w !== target.word)
      .sort(() => Math.random() - 0.5).slice(0, 3).map(([, , zh]) => zh);
    const options = [target.zh, ...others].sort(() => Math.random() - 0.5);

    return {
      card_type: 'SIGHT_WORD_FLASH',
      word: target.word,
      prompt: '闪现！快选它的意思',
      flash_ms: 800,
      options,
      correct: target.zh,
      focus: `sight:${target.word}`,
      reveal: { word: target.word, zh: target.zh, rank: target.rank, tip: '高频词靠"整体认读"，不用逐字母拼。' },
      meta: { frequency_rank: target.rank },
    };
  }

  /* ───────────── 出题入口 ───────────── */
  // 取一张卡"考的是哪个词"：音节/视觉词用 word，音素/拼读用 correct / audio_text
  function cardWord(c) {
    return String((c && (c.word || c.correct || c.audio_text)) || '').trim().toLowerCase();
  }

  /**
   * 全池加权抽样。
   * 之前三处都是 `scored[rand * Math.min(5, len)]` —— 先排序再只在前 4~5 个里抽，
   * 903 词的库实际只有 5 个候选，导致相邻两轮平均重复 2.22/8（28%）。
   * 这里按权重在整个池子里抽，权重仍然体现"薄弱音素优先"，但不再把池子砍成 5 个。
   */
  function weightedPick(arr, weightOf) {
    if (!arr || !arr.length) return null;
    const ws = arr.map((x) => Math.max(1e-6, Number(weightOf(x)) || 0));
    const total = ws.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return arr[Math.floor(Math.random() * arr.length)];
    let r = Math.random() * total;
    for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }

  function nextTask({ player, level = 'G1', type, character, exclude }) {
    const p = player || 'guest';
    const T = type && ['syllable', 'phoneme', 'phonics', 'sight'].includes(type)
      ? type
      : ['syllable', 'phoneme', 'phonics', 'sight'][Math.floor(Math.random() * 4)];

    // 本轮已经考过的词：前端传 exclude 进来，跨题型也要排除。
    // 之前只按「题型|词」去重，同一个词换个题型就绕过去了，导致一轮里出现
    // 同一个词的音素辨析 + 拼读填空。
    const skip = new Set(
      String(exclude || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    );

    const gen = () => {
      let c = null;
      if (T === 'syllable') c = makeSyllableCard(p, level, character);
      else if (T === 'phoneme') c = makePhonemeCard(p, level);
      else if (T === 'phonics') c = makePhonicsCard(p, level, character);
      else c = makeSightWordCard(p, level);
      if (!c) c = makeSyllableCard(p, level, character) || makePhonemeCard(p, level);
      return c;
    };

    let card = gen();
    if (card && skip.size) {
      for (let i = 0; i < 14 && skip.has(cardWord(card)); i++) {
        const next = gen();
        if (!next) break;
        card = next;
      }
    }
    if (!card) return { error: 'NO_TASK', message: '字库为空，请先导入 CSV 字库' };

    return {
      id: `${T}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      player: p,
      level,
      ...card,
    };
  }

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
