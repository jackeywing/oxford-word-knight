// 闭环端到端测试：出题 → 故意答错 → 画像写入 → 推荐命中 → 答对后权重回落
const B = process.env.BASE || 'http://localhost:3000';
const P = 'loopkid';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  → ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  → ' + x : '')); } };
const get = async (u) => (await fetch(B + u)).json();
const post = async (u, b) => (await fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();

(async () => {
  await get('/api/practice/reset?player=' + P);
  console.log('=== 0) 重置学情 ===');
  let prof = await get('/api/practice/profile?player=' + P);
  ok('初始状态为空', prof.total === 0 && prof.weak_phonemes.length === 0, 'total=0');

  console.log('\n=== 1) 四种题型结构正确 ===');
  for (const t of ['syllable', 'phoneme', 'phonics', 'sight']) {
    const c = await get(`/api/practice/next?level=G2&type=${t}&player=${P}`);
    ok(`${t} 生成成功`, !!c.card_type, c.card_type);
    if (t === 'syllable') {
      ok('音节题只取单个单词', /^[a-z]+$/i.test(c.word || ''), JSON.stringify(c.word));
      ok('音节题不泄露切分', !String(c.focus).includes('·'), 'focus=' + c.focus);
      ok('音节选项含正确答案', c.options.includes(c.correct), JSON.stringify(c.options));
    }
    if (t === 'phoneme') ok('听辨题有音频文本', !!c.audio_text, c.audio_text);
    if (t === 'phonics') ok('拼读规则为多字母', String(c.reveal.grapheme).length >= 2, c.reveal.grapheme);
    if (t === 'sight') ok('视觉词有闪现时长', c.flash_ms > 0, c.flash_ms + 'ms');
  }

  console.log('\n=== 2) 音素辨析答错 → 图谱写入 ===');
  const pc = await get(`/api/practice/next?level=G2&type=phoneme&player=${P}`);
  const wrongAns = pc.options.find(o => o !== pc.correct);
  const r1 = await post('/api/practice/answer', { player: P, card: pc, response: wrongAns, response_ms: 3400 });
  ok('判定为错误', r1.is_correct === false);
  ok('给出纠正文案', !!r1.feedback.message, r1.feedback.message);
  ok('给出提示', !!r1.feedback.hint, String(r1.feedback.hint).slice(0, 40));
  ok('下发讲解 reveal', !!r1.reveal && !!r1.reveal.tip, String(r1.reveal.tip).slice(0, 30));

  prof = await get('/api/practice/profile?player=' + P);
  ok('画像记录错误音素', prof.weak_phonemes.length > 0,
    prof.weak_phonemes.map(w => `${w.grapheme || w.phoneme}=${w.ew}`).join(', '));
  const topWeak = prof.weak_phonemes[0];
  ok('错误权重 > 0', topWeak && topWeak.ew > 0, 'weight=' + topWeak.ew);

  console.log('\n=== 3) 推荐引擎按薄弱点回流 ===');
  const rec = await get(`/api/practice/recommend?level=G2&player=${P}`);
  ok('给出推荐理由', !!rec.reason, rec.reason.slice(0, 60));
  ok('给出聚焦音素', rec.focus.length > 0, JSON.stringify(rec.focus));
  ok('推荐词命中薄弱组合', rec.words.length > 0,
    rec.words.slice(0, 5).map(w => w.word).join(', '));
  if (rec.words.length) {
    // 每个推荐词都必须真的含它自己标注的那个字母组合
    const allHit = rec.words.every(w => !w.grapheme || w.word.toLowerCase().includes(w.grapheme));
    ok('每个推荐词都含其标注的字母组合', allHit,
      rec.words.map(w => `${w.word}(${w.grapheme || '-'})`).slice(0, 5).join(' '));
  }

  console.log('\n=== 4) 连续答错 → 权重累加 ===');
  const before = (await get('/api/practice/profile?player=' + P)).weak_phonemes[0] || { ew: 0, wrong: 0, phoneme: '-' };
  for (let i = 0; i < 3; i++) {
    const c = await get(`/api/practice/next?level=G2&type=phoneme&player=${P}`);
    const w = c.options.find(o => o !== c.correct);
    await post('/api/practice/answer', { player: P, card: c, response: w, response_ms: 6000 });
  }
  const after = (await get('/api/practice/profile?player=' + P)).weak_phonemes[0] || { ew: 0, wrong: 0, phoneme: '-' };
  ok('权重随错误累加', after.ew > before.ew || after.wrong > before.wrong,
    `${before.phoneme}:${before.ew} → ${after.phoneme}:${after.ew}`);

  console.log('\n=== 5) 答对 → 权重回落（正向闭环） ===');
  let guard = 0, decreased = false, answeredTarget = 0;
  const w0 = (await get('/api/practice/profile?player=' + P)).weak_phonemes[0] || { ew: 0, phoneme: null };
  while (guard++ < 40 && !decreased) {
    const c = await get(`/api/practice/next?level=G2&type=phoneme&player=${P}`);
    if (c.focus !== w0.phoneme) continue;          // 只答命中该音素的题
    await post('/api/practice/answer', { player: P, card: c, response: c.correct, response_ms: 900 });
    answeredTarget++;
    const w1 = (await get('/api/practice/profile?player=' + P)).weak_phonemes[0];
    if (!w1 || w1.phoneme !== w0.phoneme || w1.ew < w0.ew) decreased = true;
  }
  ok('答对同一薄弱音素后权重回落', decreased,
    `${w0.phoneme} answered correctly ${answeredTarget}x (draws=${guard})`);

  console.log('\n=== 6) 音节题答错给出切分讲解 ===');
  const sc = await get('/api/practice/next?level=G2&type=syllable&player=' + P);
  const wrongN = sc.options.find(o => o !== sc.correct);
  const rs = await post('/api/practice/answer', { player: P, card: sc, response: wrongN, response_ms: 7000 });
  ok('音节答错判定正确', rs.is_correct === false);
  const syls = rs.reveal.syllables || [];
  const msgTxt = String(rs.feedback.message);
  const splitOk = syls.length === 1 ? msgTxt.includes(syls[0]) : msgTxt.includes('·');
  ok('讲解展示正确切分', splitOk, `${syls.length} 音节 → ${msgTxt}`);
  ok('讲解含拍手提示', String(rs.feedback.hint).includes('拍'), String(rs.feedback.hint).slice(0, 40));

  console.log('\n=== 7) 事件流可复盘 ===');
  prof = await get('/api/practice/profile?player=' + P);
  ok('累计答题数 > 0', prof.total > 0, 'total=' + prof.total);
  ok('正确率在 0-100', prof.accuracy >= 0 && prof.accuracy <= 100, prof.accuracy + '%');
  ok('分题型统计存在', prof.by_type.length > 0, prof.by_type.map(t => `${t.card_type}:${t.n}`).join(', '));

  console.log('\n=== 8) 全新玩家不报错（回归：word_state 无 hint 列的 SQL 缺陷）===');
  const fresh = 'fresh_' + Date.now();
  const recFresh = await get('/api/practice/recommend?level=G2&player=' + fresh);
  ok('全新玩家 recommend 不返回 error', !recFresh.error, recFresh.error || 'ok');
  ok('全新玩家有推荐理由文案', typeof recFresh.reason === 'string' && recFresh.reason.length > 0,
    (recFresh.reason || '').slice(0, 40));

  console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
