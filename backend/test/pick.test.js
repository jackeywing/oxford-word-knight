/**
 * pick.test.js — 出题选词算法回归
 *
 * 锁住四件事：
 *   1. 冷启动近似均匀随机（没有任何词垄断）
 *   2. 有 seen 时跨轮几乎不重复
 *   3. 错题会被拉回来（反馈链路）
 *   4. 人工权重是"加分"不是"固定名额"
 */
const path = require('path');
const { pickRound, charactersIn } = require('../pick');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + ' ' + extra)); };

// 构造池：420 个普通词 + 12 条角色台词
// 词必须是纯字母（pick.js 有守卫，数字会被剔除）
const alpha = (n) => {
  let s = '';
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};
const POOL = [];
for (let i = 0; i < 420; i++) POOL.push({ word: 'aa' + alpha(i), sentence: 'A plain sentence number ' + i + '.' });
for (let i = 0; i < 12; i++) POOL.push({ word: 'zz' + alpha(i), sentence: 'Biff said hello number ' + i + '.' });
// 别人的台词：必须被硬过滤掉，绝不能出现在 character=biff 的题里
for (let i = 0; i < 12; i++) POOL.push({ word: 'yy' + alpha(i), sentence: 'Wilma ran away number ' + i + '.' });
const N = 8;
const run = (o) => pickRound({ pool: POOL, count: N, character: 'biff', ...o });

console.log('\n=== 1) 基本契约 ===');
{
  const r = run({});
  ok('返回 8 个', r.length === N, String(r.length));
  ok('同轮无重复', new Set(r.map((x) => x.word)).size === r.length);
}

console.log('\n=== 2) 冷启动：近似均匀随机 ===');
{
  const counts = new Map();
  const ROUNDS = 300;
  for (let k = 0; k < ROUNDS; k++) for (const w of run({})) counts.set(w.word, (counts.get(w.word) || 0) + 1);
  const max = Math.max(...counts.values());
  const maxRatio = max / (ROUNDS * N);
  ok('没有任何词垄断（单轮出现率 < 12%）', maxRatio < 0.12, `最高 ${(maxRatio * 100).toFixed(1)}%`);

  const own = [...counts.keys()].filter((k) => k.startsWith('zz'));
  const ownTotal = own.reduce((s, k) => s + counts.get(k), 0);
  const ownPerRound = ownTotal / ROUNDS;
  ok('角色台词每轮 1–3 条（不致垄断、也不缺席）', ownPerRound >= 1 && ownPerRound <= 3, ownPerRound.toFixed(2));
}

console.log('\n=== 3) 有 seen：跨轮几乎不重复 ===');
{
  let seen = [];
  const rounds = [];
  for (let k = 0; k < 20; k++) {
    const r = run({ seen: seen.join(',') });
    rounds.push(r.map((x) => x.word));
    seen = seen.concat(rounds[rounds.length - 1]).slice(-N * 3);
  }
  let overlap = 0;
  for (let i = 1; i < rounds.length; i++) {
    const prev = new Set(rounds[i - 1]);
    overlap += rounds[i].filter((w) => prev.has(w)).length;
  }
  const avg = overlap / (rounds.length - 1);
  ok('相邻两轮重合 < 0.5/8', avg < 0.5, avg.toFixed(2));
}

console.log('\n=== 4) 错题反馈：被拉回来 ===');
{
  const miss = [POOL[7].word, POOL[13].word, POOL[99].word];
  let hit = 0;
  const ROUNDS = 100;
  for (let k = 0; k < ROUNDS; k++) {
    const got = new Set(run({ miss: miss.join(',') }).map((x) => x.word));
    hit += miss.filter((m) => got.has(m)).length;
  }
  const rate = hit / (ROUNDS * miss.length);
  ok('错题词单轮命中率 > 80%', rate > 0.8, (rate * 100).toFixed(0) + '%');
  ok('远高于随机基线（8/432 ≈ 1.9%）', rate > 0.019 * 5, (rate * 100).toFixed(0) + '%');
}

console.log('\n=== 5) 人工权重是加分，不是固定名额 ===');
{
  const priority = { [POOL[1].word]: 5, [POOL[2].word]: 5, [POOL[3].word]: 4 };
  const counts = new Map();
  const ROUNDS = 200;
  for (let k = 0; k < ROUNDS; k++) for (const w of run({ priority })) counts.set(w.word, (counts.get(w.word) || 0) + 1);

  const p1 = (counts.get(POOL[1].word) || 0) / ROUNDS;
  // 没有历史时 ★5 必然进前八（加成 1.2 > 旁白门槛 0.98）——这正是"人工权重"的本意。
  // 真正要防的是"每轮都是同样三个词"，靠 seen 惩罚轮换，见下面一条断言。
  ok('★5 词无历史时必现（人工权重生效）', p1 > 0.9, (p1 * 100).toFixed(0) + '%');

  // 结合 seen：加权词也不该每轮霸占
  let seen = [];
  let prioHits = 0;
  for (let k = 0; k < 50; k++) {
    const r = run({ priority, seen: seen.join(',') });
    prioHits += r.filter((x) => [POOL[1].word, POOL[2].word, POOL[3].word].includes(x.word)).length;
    seen = seen.concat(r.map((x) => x.word)).slice(-N * 3);
  }
  ok('配合 seen 后每轮加权词 ≤ 2.2 个（会轮换）', prioHits / 50 <= 2.2, (prioHits / 50).toFixed(2));
}

console.log('\n=== 6) 人物一致性：别人的台词不得出现 ===');
{
  let leak = 0;
  for (let k = 0; k < 200; k++) {
    for (const w of run({ seen: Array.from({ length: 0 }).join(',') })) {
      if (w.word.startsWith('yy')) leak++;
    }
  }
  ok('200 轮中他人台词泄漏 0 次', leak === 0, String(leak));
}

console.log('\n=== 7) 角色识别 ===');
{
  ok('charactersIn 正确', JSON.stringify(charactersIn('Floppy ran to Biff.')) === JSON.stringify(['biff', 'floppy']));
  ok('旁白为空', charactersIn('The sun is hot.').length === 0);
}

console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
process.exit(fail ? 1 : 0);
