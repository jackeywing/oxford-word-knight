/**
 * agent.test.js — Spec A / Spec C 回归
 * 用独立临时库跑，不污染开发库。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const TMP = path.join(os.tmpdir(), `owk_agent_${Date.now()}.sqlite3`);
// WAL 必须先 checkpoint，否则 copyFile 漏掉未合并的事务（新导入的词会看不到）
const SRC = path.join(ROOT, 'backend', 'db.sqlite3');
try { new Database(SRC).pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
fs.copyFileSync(SRC, TMP);

const db = new Database(TMP);
const createPractice = require('../practice');
const createAgent = require('../agent');
const practice = createPractice(db);
const agent = createAgent(db, practice);

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

console.log('\n=== 1) 语料库 ===');
const seeded = agent.seedCorpus();
const stats = agent.stats();
ok('语料库已种子化', stats.corpus > 400, `corpus=${stats.corpus}`);
ok('语料与角色绑定（至少 4 个角色有语料）',
  stats.corpusByCharacter.filter((c) => c.ch !== 'narrator').length >= 4,
  JSON.stringify(stats.corpusByCharacter.slice(0, 6)));

console.log('\n=== 2) Spec A：脚手架生成 ===');
const a = agent.scaffold({
  player_id: 'Tom', target_word: 'fright', oxford_stage: 3,
  identified_phoneme_weakness: '/r/', error_context: 'fright -> flight', character: 'floppy',
});
ok('status = success', a.status === 'success', a.error || '');
ok('scaffolding_type 正确', a.scaffolding_type === 'ort_context_hint');
ok('返回 grounded_sentence', typeof a.grounded_sentence === 'string' && a.grounded_sentence.length > 0);
ok('grounded 命中同词（Floppy 语境）', /fright/i.test(a.grounded_sentence || ''), a.grounded_sentence);
ok('语料绑定到角色 floppy', a.grounded_from && a.grounded_from.character === 'floppy', JSON.stringify(a.grounded_from));
const ph = (a.graph_facts && a.graph_facts.phonemes) || [];
ok('音素分解 = /f/ /r/ /aɪ/ /t/',
  JSON.stringify(ph) === JSON.stringify(['/f/', '/r/', '/aɪ/', '/t/']), JSON.stringify(ph));
ok('严格词表守卫已启用', /strict_vocab/.test((a.retrieval || {}).guard || ''), (a.retrieval || {}).guard);
ok('pedagogical_hint 非空', !!a.pedagogical_hint && a.pedagogical_hint.length > 5);

const outOfBank = agent.scaffold({ target_word: 'zzzqqq', oxford_stage: 3 });
ok('字表外目标词被拒', outOfBank.status === 'rejected_by_guard', JSON.stringify(outOfBank));

console.log('\n=== 3) 词表守卫 ===');
ok('合规句子通过', agent.vocabClean('Floppy had a fright in the dark.') === true);
ok('人物名放行', agent.vocabClean('Biff and Wilma help Kipper.') === true);
const bad = agent.vocabClean('Floppy had a fright near the splendid xylophone.');
ok('字表外词被识别', Array.isArray(bad) && bad.includes('splendid') && bad.includes('xylophone'), JSON.stringify(bad));

console.log('\n=== 4) Spec C：证据发现 ===');
db.prepare("DELETE FROM session_events WHERE event='answer_wrong'").run();
const ins = db.prepare(`INSERT INTO session_events (ip, sid, player, event, detail, path, ua)
                        VALUES (?, ?, ?, 'answer_wrong', ?, '/', 'test')`);
const feed = [
  ['1.1.1.1', 's1', 'kidA', { word: 'fright', typed: 'flight' }],
  ['1.1.1.1', 's1', 'kidA', { word: 'fright', typed: 'flight' }],
  ['1.1.1.2', 's2', 'kidB', { word: 'right', typed: 'light' }],
  ['1.1.1.3', 's3', 'kidC', { word: 'right', typed: 'light' }],
  ['1.1.1.4', 's4', 'kidD', { word: 'fright', typed: 'flight' }],
];
for (const [ip, sid, p, d] of feed) ins.run(ip, sid, p, JSON.stringify(d));

// 第一段：小样本（5 条 / 4 个孩子）——必须被闸门挡住
const disc = agent.discoverConfusions({ windowDays: 30, threshold: 0.85 });
ok('识别出错题事件', disc.totalErrors === 5, String(disc.totalErrors));
const rl = (disc.candidates || []).find((c) => c.source === 'r' && c.target === 'l');
ok('发现 r → l 混淆', !!rl, JSON.stringify(disc.candidates));
ok('证据链最多 5 条且含真实输入',
  rl && rl.evidence.length <= 5 && rl.evidence.every((e) => e.user_input === 'flight' || e.user_input === 'light'),
  JSON.stringify(rl && rl.evidence));
ok('小样本不放行（0.85）', disc.passing.length === 0, `passing=${disc.passing.length} conf=${rl && rl.confidence}`);
ok('小样本即使降低门槛也被硬下限拦截',
  agent.discoverConfusions({ windowDays: 30, threshold: 0.1 }).passing.length === 0,
  '硬下限 freq>=6 && users>=3');

// 第二段：补到 8 条 / 4 个孩子 —— 应当通过 0.85
const more = [
  ['1.1.1.1', 's1', 'kidA', { word: 'fright', typed: 'flight' }],
  ['1.1.1.2', 's2', 'kidB', { word: 'fright', typed: 'flight' }],
  ['1.1.1.3', 's3', 'kidC', { word: 'right', typed: 'light' }],
];
for (const [ip, sid, p, d] of more) ins.run(ip, sid, p, JSON.stringify(d));

const disc8 = agent.discoverConfusions({ windowDays: 30, threshold: 0.85 });
const rl8 = (disc8.candidates || []).find((c) => c.source === 'r' && c.target === 'l');
ok('样本足够后放行（0.85）', disc8.passing.length >= 1, `passing=${disc8.passing.length} conf=${rl8 && rl8.confidence}`);
ok('闸门字段可解释', rl8 && rl8.gate && rl8.gate.enough_sample === true, JSON.stringify(rl8 && rl8.gate));

const disc6 = disc8;

console.log('\n=== 5) HITL：提案 → 审批 → 落库 ===');
// 临时库继承开发库数据，先清空边与提案，验证"从零到落库"的完整链路
db.prepare('DELETE FROM phoneme_edge').run();
db.prepare('DELETE FROM proposals').run();
const created = agent.proposeEdges(disc6.passing);
ok('提案已创建', created.length === 1, String(created.length));
const pid = created[0].id;
ok('提案 ID 格式合法', /^PROP_\d{4}_\d{4}_\d{2}$/.test(pid), pid);
ok('初始状态 pending', created[0].status === 'pending');

const dup = agent.proposeEdges(disc6.passing);
ok('重复提案被去重', dup.length === 0, String(dup.length));

const appr = agent.reviewProposal(pid, 'approve');
ok('审批通过', appr.success === true, JSON.stringify(appr));
const edge = db.prepare("SELECT * FROM phoneme_edge WHERE source='r' AND target='l'").get();
ok('边已落入 phoneme_edge', !!edge && edge.status === 'approved', JSON.stringify(edge));
ok('边记录了 proposal_id', edge && edge.proposal_id === pid);

const again = agent.reviewProposal(pid, 'approve');
ok('重复审批被拒', !!again.error, JSON.stringify(again));

console.log('\n=== 6) 语料提案也走 HITL ===');
const before = agent.stats().corpus;
const cp = agent.proposeCorpus({ sentence: 'Biff had a fright in the dark.', word: 'fright', oxfordStage: 3, character: 'biff' });
ok('合法句子成为提案', !!cp.id && cp.status === 'pending', JSON.stringify(cp));
ok('审批前不进语料库', agent.stats().corpus === before, `${before} → ${agent.stats().corpus}`);

const cpBad = agent.proposeCorpus({ sentence: 'Floppy had a fright near the splendid xylophone.', word: 'fright', oxfordStage: 3 });
ok('字表外句子直接拒绝（不产生提案）', !!cpBad.error, JSON.stringify(cpBad));

const cpOk = agent.reviewProposal(cp.id, 'approve');
ok('通过后落库', cpOk.success === true, JSON.stringify(cpOk));
ok('语料库 +1', agent.stats().corpus === before + 1, `${before} → ${agent.stats().corpus}`);

const rej = agent.proposeCorpus({ sentence: 'Chip saw a fright.', word: 'fright', oxfordStage: 2, character: 'chip' });
const rejRes = agent.reviewProposal(rej.id, 'reject');
ok('拒绝可用', rejRes.success === true && rejRes.status === 'rejected', JSON.stringify(rejRes));
ok('拒绝后无副作用', agent.stats().corpus === before + 1);

console.log(`\n=== 汇总 ===\n  passed ${pass} / failed ${fail}`);
try { fs.unlinkSync(TMP); } catch (e) {}
process.exit(fail ? 1 : 0);
