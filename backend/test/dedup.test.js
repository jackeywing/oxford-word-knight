// 词库与出题重复度验证
// 目标：一轮 N 题内绝不出现同一个词；同时报告跨轮自然重复率（这是正常采样，不是 bug）
const B = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  → ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  → ' + x : '')); } };
const get = async (u) => (await fetch(B + u)).json();

(async () => {
  const lex = await get('/api/lexicon');
  const s = lex.stats;

  console.log('=== 1) 词库自身是否干净 ===');
  ok('库内无重复词', s.duplicates.length === 0, `rows=${s.rows} unique=${s.unique}`);
  ok('总行数 = 唯一词数', s.rows === s.unique, `${s.rows} / ${s.unique}`);
  ok('每行都有例句', s.withSentence === s.rows, `${s.withSentence}/${s.rows}`);
  console.log('     级别:', JSON.stringify(s.byLevel), '| 短语:', s.phrases, '| 平均词长:', s.avgLen);

  console.log('\n=== 2) 单轮内不得重复（10 题 × 200 轮）===');
  let dupRounds = 0, worst = null;
  const poolSize = s.unique;
  for (let r = 0; r < 200; r++) {
    const arr = await get(`/api/challenges?level=G2&count=10`);
    const seen = new Map();
    let bad = null;
    for (const w of arr) {
      const k = String(w.word).trim().toLowerCase();
      if (seen.has(k)) { bad = k; break; }
      seen.set(k, 1);
    }
    if (bad) { dupRounds++; if (!worst) worst = bad; }
  }
  ok('200 轮全部无重复词', dupRounds === 0, dupRounds ? `${dupRounds} 轮有重复，例: ${worst}` : '0 轮重复');

  console.log('\n=== 3) 抽样多样性（跨轮重复是正常的）===');
  const wordHit = new Map();
  const ROUNDS = 60, N = 10;
  for (let r = 0; r < ROUNDS; r++) {
    const arr = await get(`/api/challenges?level=G2&count=${N}`);
    for (const w of arr) {
      const k = String(w.word).trim().toLowerCase();
      wordHit.set(k, (wordHit.get(k) || 0) + 1);
    }
  }
  const totalDraws = ROUNDS * N;
  const distinct = wordHit.size;
  ok('抽样覆盖到足够多的不同词', distinct >= poolSize * 0.6,
    `${distinct} / ${poolSize} 个词出现过（${totalDraws} 次抽样）`);
  const top = [...wordHit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('     出现最多的词:', top.map(([w, n]) => `${w}×${n}`).join(', '));
  const avg = totalDraws / distinct;
  console.log(`     平均每词出现 ${avg.toFixed(1)} 次（均匀随机期望 ≈ ${(totalDraws / poolSize).toFixed(1)}）`);

  console.log('\n=== 4) 短语不应进入特训题库 ===');
  const phraseSet = new Set(lex.words.filter((w) => w.isPhrase).map((w) => String(w.word).toLowerCase()));
  let phraseLeak = 0;
  for (let r = 0; r < 25; r++) {
    for (const t of ['syllable', 'phoneme', 'phonics', 'sight']) {
      const c = await get(`/api/practice/next?level=G2&type=${t}&player=de_${r}`);
      const w = String(c.word || c.correct || '').toLowerCase();
      if (phraseSet.has(w)) phraseLeak++;
    }
  }
  ok('特训题不含短语', phraseLeak === 0, `${phraseLeak} 次泄漏`);

  console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
