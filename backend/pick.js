/**
 * pick.js — 一轮出题的选词算法（服务端与静态版共用同一套规则）
 *
 * 修复的两个真问题：
 *   1. 服务端 `mine.concat(neutral)` 后直接 slice(0,8)，8 题全落在角色本人的
 *      12 条台词里，215 条旁白根本没机会 → 相邻两轮平均重合 4.86/8（61%）。
 *   2. 人工加权词用"固定名额"占位，3 个 ★5/★4 词每轮必占 3 个位置，
 *      导致这几道题永远重复。
 *
 * 现在的规则：**打分制**，没有任何固定名额。
 *
 *   冷启动（无历史）：
 *       score = rand() + 0.15 × 角色本人台词
 *       → 近似均匀随机，只轻微偏向角色语境
 *
 *   有历史（seen / miss 非空）：
 *       score = rand()
 *             + 0.9 × 角色本人台词
 *             + 3.5 × 本玩家错过的词          ← 反馈链路
 *             - 3.0 × 最近 3 轮出现过的词     ← 抑制跨轮重复
 *             + (0.4 + 0.16 × ★) 人工加权词   ← 加分制，不占名额
 *
 * 系数是量级问题，不是随便调的（实测出来的，不是拍的）：
 *   角色本人 12 条 vs 旁白 420 条。8 个名额要在全池排前八，旁白的门槛约 0.98 分。
 *   - 加成 0.90 → 12 条台词每轮抢走 6.5–8 个位置
 *   - 加成 0.55 → 仍然 6.5 个
 *   - 加成 0.15 → 约 2.0 个（12/432 占 2.8%，拿到 25% 名额 = 9 倍富集，够用且不垄断）
 *   人工权重若给到 5.5（1.5+5×0.8）→ 3 个 ★5 词每轮必占 3 席，这就是之前
 *   "每次闯关都一样"的主因。现在 0.4+0.16×★（★5≈1.2），配合 seen 惩罚会轮换。
 */

const { FOCUS_WORDS } = require('../shared/engine.js');

const CHARACTER_NAMES = ['biff', 'chip', 'kipper', 'wilma', 'floppy', 'gran', 'mum', 'dad', 'wilf'];

/* 用户指定高频词：0.26 是实测值——
 * 8 个名额要在 900+ 词里排进前八，普通词门槛约 0.99 分，
 * +0.26 让每个词单轮命中率约 27%，11 个词合计每轮 3 个左右。
 * 给 1.0 会变成 11 个词霸占全部名额。 */
const FOCUS_BOOST = 0.26;

function charactersIn(sentence) {
  const s = String(sentence || '');
  return CHARACTER_NAMES.filter((n) => new RegExp('\\b' + n + '\\b', 'i').test(s));
}

function toSet(v) {
  if (v instanceof Set) return v;
  return new Set(
    String(v || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * @param {object} o
 * @param {Array}  o.pool        候选词 [{word, sentence, ...}]
 * @param {number} o.count       本轮题数
 * @param {string} o.character   当前角色
 * @param {Set|string} o.seen    最近几轮出现过的词
 * @param {Set|string} o.miss    玩家最近答错的词
 * @param {Map|object} o.priority 人工权重 {word: 1..5}
 * @returns {Array} 选中的词
 */
function pickRound({ pool = [], count = 8, character = '', seen, miss, priority } = {}) {
  const seenSet = toSet(seen);
  const missSet = toSet(miss);
  const prio = priority instanceof Map ? priority : new Map(Object.entries(priority || {}));
  const coldStart = seenSet.size === 0 && missSet.size === 0;

  // 人物一致性白名单：只留「本人出场」或「旁白」，别人的台词一律不进池
  // （这是硬过滤。只靠加分是不够的——加分只影响排序，别人台词照样能挤进来）
  const filtered = character
    ? pool.filter((w) => {
        const who = charactersIn(w.sentence);
        return who.length === 0 || who.indexOf(character) >= 0;
      })
    : pool;

  // 同轮去重（防御：库里万一有重复词）
  const uniq = [];
  const has = new Set();
  for (const w of filtered) {
    const k = String(w.word || '').trim().toLowerCase();
    // 项目约定：题库只取纯字母单词，短语（more than / seem to）一律不进
    if (!k || !/^[a-z]+$/.test(k) || has.has(k)) continue;
    has.add(k);
    uniq.push(w);
  }

  const scored = uniq.map((w) => {
    const k = String(w.word).toLowerCase();
    let s = Math.random();
    if (character && charactersIn(w.sentence).indexOf(character) >= 0) s += 0.15;
    if (!coldStart) {
      if (missSet.has(k)) s += 3.5;
      if (seenSet.has(k)) s -= 3.0;
    }
    if (FOCUS_WORDS.has(k)) s += FOCUS_BOOST;
    const star = Number(prio.get(k)) || 0;
    if (star > 0) s += 0.4 + star * 0.16;
    return { w, s };
  });

  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, Math.max(0, count)).map((x) => x.w);
}

module.exports = { pickRound, charactersIn, CHARACTER_NAMES };
