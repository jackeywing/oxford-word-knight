/**
 * punctuation.test.js — 标点填空题型回归
 *
 * 这个题型的正确性有两个硬要求：
 *   1. 正确答案必须唯一合理（"." 和 "!" 在很多句子里都说得通，题库里每条都带线索）
 *   2. 选项必须真的包含正确答案，且没有重复项
 */
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..', '..');

// answer() 要写库，所以用临时副本（WAL 必须先 checkpoint，否则新写入看不到）
const os = require('os');
const fs = require('fs');
const SRC = path.join(ROOT, 'backend', 'db.sqlite3');
try { new Database(SRC).pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
const TMP = path.join(os.tmpdir(), `owk_punct_${Date.now()}.sqlite3`);
fs.copyFileSync(SRC, TMP);
const db = new Database(TMP);
const createPractice = require('../practice');
const E = require('../../shared/engine.js');
const practice = createPractice(db);

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + ' ' + extra)); };

console.log('\n=== 1) 题库结构 ===');
const BANK = E.PUNCT_BANK;
ok('题库非空', BANK.length >= 20, '共 ' + BANK.length + ' 条');

const badPlaceholder = BANK.filter((x) => !x.s.includes('{}'));
ok('每条都有 {} 占位符', badPlaceholder.length === 0, JSON.stringify(badPlaceholder.map((x) => x.s)));

const badOptions = BANK.filter((x) => !Array.isArray(x.options) || x.options.length < 2 || !x.options.includes(x.mark));
ok('正确答案都在选项里', badOptions.length === 0, JSON.stringify(badOptions.map((x) => x.s)));

const dupOptions = BANK.filter((x) => new Set(x.options).size !== x.options.length);
ok('选项无重复', dupOptions.length === 0, JSON.stringify(dupOptions.map((x) => x.options)));

const noTip = BANK.filter((x) => !x.tip || x.tip.length < 4);
ok('每条都有讲解', noTip.length === 0, JSON.stringify(noTip.map((x) => x.s)));

console.log('\n=== 2) 题型覆盖 ===');
const marks = new Set(BANK.map((x) => x.mark));
for (const m of ['?', '.', '!', ',', ':', '"', "'"]) {
  ok(`覆盖 ${m}`, marks.has(m));
}
ok('包含句中标点（: ; ,）', [':', ';', ','].every((m) => marks.has(m)), [...marks].join(' '));

console.log('\n=== 3) 出题 ===');
{
  const cards = [];
  for (let i = 0; i < 200; i++) {
    const c = practice.nextTask({ player: 'punct_' + i, level: 'G2', type: 'punctuation', character: 'biff' });
    if (c && !c.error) cards.push(c);
  }
  ok('200 次全部出题成功', cards.length === 200, cards.length + ' 张');
  ok('题卡类型正确', cards.every((c) => c.card_type === 'PUNCTUATION_MARK'));
  ok('题干含下划线空', cards.every((c) => c.sentence.includes('_____')));
  ok('题干不留 {} 占位符', cards.every((c) => !c.sentence.includes('{}')));
  ok('正确答案在选项内', cards.every((c) => c.options.includes(c.correct)));
  ok('讲解非空', cards.every((c) => c.reveal && c.reveal.tip));
  ok('完整句子已回填标点', cards.every((c) => c.reveal.full.includes(c.correct)));
}

console.log('\n=== 4) 答题反馈不含 undefined ===');
{
  let bad = 0, checked = 0;
  for (let i = 0; i < 60; i++) {
    const c = practice.nextTask({ player: 'pf_' + i, level: 'G2', type: 'punctuation', character: 'biff' });
    if (!c || c.error) continue;
    for (const ans of [c.correct, c.options.find((o) => o !== c.correct)]) {
      const r = practice.answer({ player: 'pf_' + i, card: c, response: ans, response_ms: 900 });
      checked++;
      const txt = JSON.stringify(r.feedback || {});
      if (/undefined/.test(txt)) { bad++; if (bad <= 2) console.log('     ', txt.slice(0, 120)); }
    }
  }
  ok(`${checked} 次答题反馈无 undefined`, bad === 0, bad + ' 次');
}

console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
try { fs.unlinkSync(TMP); } catch (e) {}
process.exit(fail ? 1 : 0);
