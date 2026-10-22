/**
 * lexicon-weight.js — 词库「图谱权重」计算
 *
 * 依据 GRAPH_EDGE_RULES 中**当前有数据支撑**的关系边：
 *
 *   Player -[struggles_with]-> Phoneme   properties.error_weight   （已落库：phoneme_state）
 *   Player -[struggles_with]-> PhonicsRule properties.fail_count   （由音素边按 grapheme 聚合）
 *   Player -[NEEDS_PRACTICE]-> Word      properties.error_count    （已落库：word_state）
 *   User   -[MANUAL_PRIORITY]-> Word     properties.weight         （已落库：user_words，单独展示）
 *
 * 节点路径 Word -COMPOSED_OF-> Syllable -COMPOSED_OF-> Phoneme，
 * 所以「词权重」= 该词包含的音素边权重之和 + 词级错题边 × 系数（全部玩家加总）。
 *
 * 没有任何历史边的词，用**理论权重**兜底（词长 + 音节数 + 音素组合数 + stage），并标注「估算」。
 * 理论权重不是图上的实测边，只用于排序参考，接口里用 isEstimated 明确区分。
 */

/* 理论权重的系数（集中在这里，便于调参） */
const EST = {
  base: 1.0,
  perLetter: 0.25,     // 每超出一个字母 +0.25（3 字母为基准）
  perSyllable: 0.8,    // 每多一个音节 +0.8
  perGrapheme: 0.4,    // 每含一个多字母组合 +0.4（ee / igh / ou …）
  perStageGap: 0.3,    // stage 越低（越基础）越简单：+ (4 - stage) * 0.3
};

/** 词级错题边换算成权重的系数：错 1 次 ≈ 0.6 个音素边 */
const WORD_EDGE_FACTOR = 2.0;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 计算理论权重（无历史时兜底）
 * @param {{word:string, syllables:number, letters:number, graphemes:string[], stage?:number|null}} w
 */
function estimateWeight(w) {
  const letters = Number(w.letters) || String(w.word).length;
  const syl = Number(w.syllables) || 1;
  const g = (w.graphemes || []).length;
  const stage = Number(w.stage) || 3;
  const v = EST.base
    + Math.max(0, letters - 3) * EST.perLetter
    + Math.max(0, syl - 1) * EST.perSyllable
    + g * EST.perGrapheme
    + Math.max(0, 4 - stage) * EST.perStageGap;
  return round2(v);
}

/**
 * 从数据库读取全部玩家的边，按词聚合
 * @param {import('better-sqlite3').Database} db
 * @returns {(word:string)=>object}  返回一个按词查权重的函数
 */
function buildWeightLookup(db) {
  let phEdges = [], wEdges = [];
  try { phEdges = db.prepare('SELECT player_id, phoneme, grapheme, error_weight FROM phoneme_state WHERE error_weight > 0').all(); } catch (e) {}
  try { wEdges = db.prepare('SELECT player_id, word, error_count FROM word_state WHERE error_count > 0').all(); } catch (e) {}

  // PhonemeNode 边 → 按 grapheme 汇总（Word 通过 grapheme 连到 PhonemeNode）
  const byGrapheme = new Map();   // grapheme -> { weight, players:Set, phonemes:Set }
  for (const e of phEdges) {
    const g = String(e.grapheme || '').trim();
    if (!g) continue;
    const cur = byGrapheme.get(g) || { weight: 0, players: new Set(), phonemes: new Set() };
    cur.weight += Number(e.error_weight) || 0;
    cur.players.add(e.player_id);
    cur.phonemes.add(e.phoneme);
    byGrapheme.set(g, cur);
  }

  // NEEDS_PRACTICE 词级边 → 按词汇总
  const byWord = new Map();       // word(lower) -> { count, players:Set }
  for (const e of wEdges) {
    const k = String(e.word || '').trim().toLowerCase();
    if (!k) continue;
    const cur = byWord.get(k) || { count: 0, players: new Set() };
    cur.count += Number(e.error_count) || 0;
    cur.players.add(e.player_id);
    byWord.set(k, cur);
  }

  return function weightOf(word, meta) {
    const k = String(word).trim().toLowerCase();
    const graphemes = Array.from(new Set(meta && meta.graphemes ? meta.graphemes : []));
    const ph = graphemes.reduce((a, g) => a + ((byGrapheme.get(g) || {}).weight || 0), 0);
    const we = (byWord.get(k) || {}).count || 0;
    const measured = round2(ph + we * WORD_EDGE_FACTOR);
    const estimated = estimateWeight({ ...meta, word });

    const players = new Set();
    graphemes.forEach((g) => { const e = byGrapheme.get(g); if (e) e.players.forEach((p) => players.add(p)); });
    const weRec = byWord.get(k); if (weRec) weRec.players.forEach((p) => players.add(p));

    // 三态依据：
    //   direct     —— 这个词本身被考过（NEEDS_PRACTICE 边存在）
    //   propagated —— 词本身没考过，但含玩家薄弱音素（经 COMPOSED_OF → struggles_with 传播）
    //   estimated  —— 完全没有数据，用理论权重兜底
    const attempted = byWord.has(k);
    const basis = attempted ? 'direct' : (ph > 0 ? 'propagated' : 'estimated');
    const value = basis === 'estimated' ? estimated : measured;

    return {
      measured,
      estimated,
      value: round2(value),
      basis,
      isEstimated: basis === 'estimated',
      parts: {
        phonemeEdges: round2(ph),       // struggles_with → Phoneme 合计（传播来源）
        wordEdges: we,                  // NEEDS_PRACTICE → Word 次数合计（直连证据）
        wordEdgeWeight: round2(we * WORD_EDGE_FACTOR),
        graphemes: graphemes.filter((g) => byGrapheme.has(g)),
        players: [...players],
      },
    };
  };
}

module.exports = { buildWeightLookup, estimateWeight, EST, WORD_EDGE_FACTOR };
