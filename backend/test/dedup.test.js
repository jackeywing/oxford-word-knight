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
  ok('过半词条有例句', s.withSentence >= s.rows * 0.5, `${s.withSentence}/${s.rows} (${Math.round(s.withSentence / s.rows * 100)}%)`);
  ok('词库规模 ≥ 800 词', s.unique >= 800, `${s.unique} 词`);
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
  // 人工高权重生词本来就该每轮出现，统计多样性时先把它们排除
  const uw = (await get('/api/user-words')).words || [];
  const uwSet = new Set(uw.map((w) => String(w.word).toLowerCase()));
  const normal = [...wordHit.entries()].filter(([w]) => !uwSet.has(w));
  const totalNormal = normal.reduce((a, [, n]) => a + n, 0);
  const distinctNormal = normal.length;

  ok('高权重生词每轮必现', uw.every((w) => (wordHit.get(String(w.word).toLowerCase()) || 0) >= ROUNDS * 0.8),
    uw.map((w) => w.word + '×' + (wordHit.get(String(w.word).toLowerCase()) || 0)).join(', ') || '（未录入生词）');
  // 阈值从 180 降到 165：FOCUS_WORDS 那 11 个高频词（在 pick.js 里 +0.26）
  // 会占掉一部分名额，普通词的覆盖面自然下降。实测 175–199，165 留足余量。
  ok('其余词抽样足够分散', distinctNormal >= 165,
    `${distinctNormal} 个普通词出现过（${totalNormal} 次抽样）`);

  const top = normal.sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('     普通词出现最多:', top.map(([w, n]) => `${w}×${n}`).join(', '));
  const maxHit = top.length ? top[0][1] : 0;
  ok('没有普通词被过度偏置', maxHit <= ROUNDS * N * 0.25, `最高 ${maxHit} 次`);

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

  console.log('\n=== 5) 特训一轮内不得跨题型重复 ===');
  const PLAN = ['syllable', 'phoneme', 'phonics', 'sight', 'syllable', 'phoneme', 'phonics', 'sight'];
  let dupRoundsP = 0, sampleDupP = null;
  for (let r = 0; r < 25; r++) {
    const used = [];
    const cards = [];
    for (const t of PLAN) {
      const c = await get(`/api/practice/next?level=G2&type=${t}&player=dd_${r}&character=biff&exclude=${encodeURIComponent(used.join(','))}`);
      if (c.error) break;
      const w = String(c.word || c.correct || c.audio_text || '').toLowerCase();
      cards.push(c.card_type + ':' + w);
      if (w && used.indexOf(w) < 0) used.push(w);
    }
    const ws = cards.map((x) => x.split(':')[1]);
    const seenW = new Set();
    const dup = [];
    for (const w of ws) { if (!w) continue; if (seenW.has(w)) dup.push(w); seenW.add(w); }
    if (dup.length) { dupRoundsP++; if (!sampleDupP) sampleDupP = cards.join(' | '); }
  }
  ok('25 轮特训无跨题型重复词', dupRoundsP === 0,
    dupRoundsP ? `${dupRoundsP} 轮重复，例: ${sampleDupP}` : '0 轮重复');

  // 不带 exclude 时应能复现问题（守住 exclude 这条链路真的在起作用）
  let rawDup = 0;
  for (let r = 0; r < 12; r++) {
    const ws = [];
    for (const t of PLAN) {
      const c = await get(`/api/practice/next?level=G2&type=${t}&player=raw_${r}&character=biff`);
      if (!c.error) ws.push(String(c.word || c.correct || c.audio_text || '').toLowerCase());
    }
    const seenW = new Set();
    for (const w of ws) { if (!w) continue; if (seenW.has(w)) { rawDup++; break; } seenW.add(w); }
  }
  console.log(`     （对照：不传 exclude 时 12 轮中有 ${rawDup} 轮重复 —— 说明去重确实靠 exclude）`);

  console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
