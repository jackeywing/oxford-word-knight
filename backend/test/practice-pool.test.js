/**
 * practice-pool.test.js — 特训页选题多样性回归
 *
 * 背景：三个生成器都用了"先排序再只在前 K 个里抽"的写法
 *   makeSyllableCard : scored[rand * min(5, len)]   → 5 个候选
 *   makePhonemeCard  : scored[rand * min(4, len)]   → 4 个候选
 *   makePhonicsCard  : const chosen = scored[0]     → 1 个候选（最狠）
 *   makeSightWordCard: slice(0,12) 再 rand*min(5)   → 5 个候选
 * 903 词的库实际只有 4~5 个候选，导致相邻两轮平均重复 2.22/8（28%）。
 */
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..', '..');

const db = new Database(path.join(ROOT, 'backend', 'db.sqlite3'), { readonly: true });
const createPractice = require('../practice');
const practice = createPractice(db);

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + ' ' + extra)); };

const PLAN = ['syllable', 'phoneme', 'phonics', 'sight', 'syllable', 'phoneme', 'phonics', 'sight'];
const wordOf = (c) => String((c && (c.word || c.correct || c.audio_text)) || '').toLowerCase();

function runRounds(n, { crossRound }) {
  const rounds = [];
  let seen = [];
  for (let r = 0; r < n; r++) {
    const used = [], ws = [];
    for (const t of PLAN) {
      const ex = crossRound ? used.concat(seen) : used;
      const c = practice.nextTask({ player: 'pool_' + r, level: 'G2', type: t, character: 'biff', exclude: ex.join(',') });
      if (!c || c.error) continue;
      const w = wordOf(c);
      used.push(w); ws.push(w);
    }
    rounds.push(ws);
    seen = crossRound ? seen.concat(ws).slice(-24) : [];
  }
  return rounds;
}

console.log('\n=== 1) 同轮内不得重复 ===');
{
  const rounds = runRounds(100, { crossRound: false });
  const bad = rounds.filter((r) => r.filter((x, i) => r.indexOf(x) !== i).length);
  ok('100 轮中同轮重复 0 轮', bad.length === 0, bad.length + ' 轮');
}

console.log('\n=== 2) 相邻两轮不得重复 ===');
{
  const rounds = runRounds(60, { crossRound: true });
  let ov = 0;
  for (let i = 1; i < rounds.length; i++) {
    const prev = new Set(rounds[i - 1]);
    ov += rounds[i].filter((w) => prev.has(w)).length;
  }
  const avg = ov / (rounds.length - 1);
  ok('相邻轮平均重合 0/8', avg === 0, avg.toFixed(2) + '/8');
}

console.log('\n=== 3) 每个题型的候选池足够宽 ===');
{
  const rounds = runRounds(60, { crossRound: true });
  const byType = { syllable: [], phoneme: [], phonics: [], sight: [] };
  let k = 0;
  for (const r of rounds) { for (let j = 0; j < PLAN.length; j++) byType[PLAN[j]].push(r[j]); }
  // 60 轮 × 每型 2 题 = 120 次抽样的不同词数
  // phoneme 的结构上限是 24：MINIMAL_PAIRS 只有 12 组，每组 2 个词。
  // 这个上限不是 bug，是小对立组本身的数量；跨轮记忆保证它不会连续重复。
  const FLOOR = { syllable: 25, phoneme: 20, phonics: 25, sight: 25 };
  for (const [t, arr] of Object.entries(byType)) {
    const uniq = new Set(arr.filter(Boolean)).size;
    ok(`${t}：120 次抽样 ≥ ${FLOOR[t]} 个不同词`, uniq >= FLOOR[t], '不同词 ' + uniq);
  }
}

console.log('\n=== 4) 拼读题不再固定同一规则 ===');
{
  const rules = new Set();
  for (let i = 0; i < 400; i++) {
    const c = practice.nextTask({ player: 'rule_probe', level: 'G2', type: 'phonics', character: 'biff' });
    if (c && c.meta && c.meta.rule) rules.add(c.meta.rule);
  }
  ok('400 次抽到 ≥ 6 种不同拼读规则', rules.size >= 6, '规则 ' + rules.size + ' 种: ' + [...rules].join(','));
}

console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
process.exit(fail ? 1 : 0);
