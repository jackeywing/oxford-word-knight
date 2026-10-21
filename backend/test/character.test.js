// 人物一致性测试：每个角色的题干句子只能「本人出场」或「中立旁白」
const B = process.env.BASE || 'http://localhost:3000';
const NAMES = ['biff', 'chip', 'kipper', 'wilma', 'floppy', 'wilf', 'gran', 'mum', 'dad'];
const CHARS = ['biff', 'chip', 'kipper', 'wilma', 'floppy'];

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n + (x ? '  → ' + x : '')); } else { fail++; console.log('  ❌ ' + n + (x ? '  → ' + x : '')); } };
const get = async (u) => (await fetch(B + u)).json();

const whoIn = (s) => {
  const t = String(s || '').toLowerCase();
  return NAMES.filter(n => new RegExp('\\b' + n + '\\b').test(t));
};

(async () => {
  console.log('=== 人物清单 ===');
  const list = await get('/api/practice/characters');
  ok('含 Floppy 且标记为宠物', list.some(c => c.id === 'floppy' && c.pet === true),
    list.map(c => c.label + (c.pet ? '(pet)' : '')).join(', '));

  console.log('\n=== 每个角色的题干句子归属 ===');
  for (const ch of CHARS) {
    let bad = [], own = 0, neutral = 0, n = 0;
    for (let i = 0; i < 14; i++) {
      const c = await get(`/api/practice/next?level=G2&type=phonics&player=t_${ch}&character=${ch}`);
      if (!c || c.card_type !== 'PHONICS_CONTEXT_MATCH') continue;
      n++;
      const names = whoIn(c.sentence);
      if (names.length === 0) neutral++;
      else if (names.includes(ch)) own++;
      else bad.push(`${ch}: "${c.sentence.slice(0, 46)}" [${names.join('+')}]`);
    }
    ok(`${ch} 的题不含他人台词`, bad.length === 0,
      bad.length ? bad[0] : `${n} 题 · 本人台词 ${own} · 旁白 ${neutral}`);
  }

  console.log('\n=== Floppy 专属台词可用 ===');
  let flop = 0, seen = new Set();
  for (let i = 0; i < 25; i++) {
    const c = await get(`/api/practice/next?level=G2&type=phonics&player=t_f&character=floppy`);
    if (c?.card_type === 'PHONICS_CONTEXT_MATCH' && /floppy/i.test(c.sentence)) { flop++; seen.add(c.sentence.trim()); }
  }
  ok('Floppy 的题里出现过他自己的句子', flop > 0, `${flop} 次 / ${seen.size} 句不同`);

  console.log('\n=== 主游戏同样按人物过滤 ===');
  for (const ch of ['biff', 'floppy']) {
    const arr = await get(`/api/challenges?level=G2&count=8&character=${ch}`);
    const bad = arr.filter(x => { const n = whoIn(x.sentence || ''); return n.length > 0 && !n.includes(ch); });
    ok(`/api/challenges 角色=${ch} 不含他人台词`, bad.length === 0,
      bad.length ? bad[0].sentence.slice(0, 46) : `${arr.length} 题`);
  }

  console.log('\n=== 句子池不塌陷 ===');
  for (const ch of CHARS) {
    const arr = await get(`/api/challenges?level=G2&count=8&character=${ch}`);
    ok(`${ch} 仍能出满 8 题`, arr.length === 8, arr.length + ' 题');
  }

  console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
