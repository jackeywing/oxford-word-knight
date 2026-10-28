/**
 * build-pages.js — 生成 GitHub Pages 静态版
 *
 * Pages 只有静态文件，没有 Node。所以：
 *   · 词库 → 从 CSV 内嵌为 JSON
 *   · 引擎 → 把 practice.js 的纯逻辑（音节切分 / 音素表 / 人物）内联进页面
 *   · 学情 → 用 localStorage 代替 SQLite
 *
 * 产出：docs/phonics.html（视觉与 frontend/practice.html 完全一致）
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'docs');
const practiceSrc = fs.readFileSync(path.join(ROOT, 'backend/practice.js'), 'utf8');
// 引擎唯一实现：与后端共用 shared/engine.js（shebang 不能进 <script>）
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'engine.js'), 'utf8')
  .replace(/^#![^\n]*\n/, '');
const practice = require('./backend/practice.js');

/* ── 1. 词库：以 CSV 为准（docs 旧版 JSON 有逗号截断问题）── */
function readCsv(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(',').map(s => s.trim());
  const rows = [];
  for (const line of lines) {
    // 简易 CSV 解析（支持引号包裹）
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    const o = {};
    head.forEach((h, i) => { o[h] = (cells[i] || '').trim(); });
    if (o.word) {
      o.oxford_level = /^G[12]$/.test(o.oxford_level || '') ? o.oxford_level : 'G2';
      rows.push(o);
    }
  }
  return rows;
}
/*
 * 词库以**数据库为准**。之前读 words-merged.csv，导致：
 *   - 通过 /lexicon 手动加的高权重生词（lantern / telescope）只进库，永远不上线
 *   - 新导入的词（fright）同样进不了静态版
 * 数据库不存在时才回落到 CSV（CI 无库场景）。
 */
function loadBankFromDb() {
  const Database = require('better-sqlite3');
  const p = path.join(ROOT, 'backend', 'db.sqlite3');
  if (!fs.existsSync(p)) return null;
  try {
    const db = new Database(p, { readonly: true });
    const rows = db.prepare('SELECT word, hint, sentence, oxford_level, stage, pos FROM words ORDER BY id').all();
    db.close();
    if (!rows.length) return null;
    return rows.map((r) => ({
      ...r,
      sentence: r.sentence || '',
      oxford_level: /^G[12]$/.test(r.oxford_level || '') ? r.oxford_level : 'G2',
    }));
  } catch (e) { console.warn('⚠️ 读库失败，回落 CSV:', e.message); return null; }
}

const _dbBank = loadBankFromDb();
const _rawBank = _dbBank || (fs.existsSync(path.join(ROOT, 'words-merged.csv'))
  ? readCsv('words-merged.csv')
  : readCsv('g2-words.csv').concat(readCsv('sample-words.csv')));
if (_dbBank) console.log('词库来源: 数据库 (' + _dbBank.length + ' 词)');
// 两个 CSV 有 6 个词重叠（red/blue/come/make/put/old）——不去重会导致同一轮抽到两次
const BANK = (() => {
  const seen = new Map();
  for (const r of _rawBank) {
    const k = String(r.word).trim().toLowerCase();
    const prev = seen.get(k);
    if (!prev) { seen.set(k, r); continue; }
    if ((r.sentence || '').length > (prev.sentence || '').length) seen.set(k, r);
  }
  const out = [...seen.values()];
  if (out.length !== _rawBank.length) console.log(`词库去重: ${_rawBank.length} → ${out.length}`);
  return out;
})();

/* ── 2. 从 practice.js 抽出可复用的纯逻辑块 ── */
const syllablesBlock = practiceSrc.slice(
  practiceSrc.indexOf('const SYLLABLE_OVERRIDES'),
  practiceSrc.indexOf('/* ───────────────────────── 音素清单')
);
const charactersBlock = practiceSrc.slice(
  practiceSrc.indexOf('const CHARACTERS = {'),
  practiceSrc.indexOf('const VOWELS') >= 0
    ? practiceSrc.indexOf('const VOWELS')
    : practiceSrc.indexOf('const SYLLABLE_OVERRIDES')
);
const charactersFnBlock = practiceSrc.slice(
  practiceSrc.indexOf('/** 句子里出现了哪些牛津树人物'),
  practiceSrc.indexOf("const characterLabel")
);

const DATA = {
  PHONEME_PATTERNS: practice.PHONEME_PATTERNS,
  MINIMAL_PAIRS: practice.MINIMAL_PAIRS,
  SIGHT_WORDS: practice.SIGHT_WORDS,
};

/* ── 3. 读取 practice.html，复用其样式与骨架 ── */
const tpl = fs.readFileSync(path.join(ROOT, 'frontend/practice.html'), 'utf8');
const css = tpl.slice(tpl.indexOf('<style>'), tpl.indexOf('</style>') + 8);
const bodyStart = tpl.indexOf('<body>');
const scriptStart = tpl.indexOf('<script>');
const markup = tpl.slice(bodyStart, scriptStart).replace(
  /<a class="tab" href="\/">/,
  '<a class="tab" href="./index.html">'
).replace(
  /<a class="tab active" href="\/practice">/,
  '<a class="tab active" href="./phonics.html">'
);

/* ── 4. 客户端引擎 ── */
const ENGINE = [
"/* ================= 静态版引擎 =================\n   算法本体与 backend/practice.js 共用 shared/engine.js；\n   这里只保留「用 localStorage 代替 SQLite」的数据适配层。\n   以前这里有一份手工抄写的引擎副本，改一边另一边不生效。 */",
  ENGINE_SRC,
"const PHONEME_PATTERNS = OWK.PHONEME_PATTERNS;\nconst MINIMAL_PAIRS = OWK.MINIMAL_PAIRS;\nconst SIGHT_WORDS = OWK.SIGHT_WORDS;\nconst CHARACTERS = OWK.CHARACTERS;\nconst norm = OWK.norm;\nconst phonemesOf = OWK.phonemesOf;\nconst syllabify = OWK.syllabify;\nconst syllableCount = OWK.syllableCount;\nconst charactersIn = OWK.charactersIn;\nconst weightedPick = OWK.weightedPick;",
  'const BANK = ' + JSON.stringify(BANK) + ';',
"\nconst STORE_KEY = 'owk_phonics_v1';\nlet DB = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } })();\nconst persist = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) {} };\nconst me = (p) => { DB[p] = DB[p] || { ph: {}, words: {}, n: 0, ok: 0 }; return DB[p]; };",
"\nfunction bankFor(level) { return level ? BANK.filter(r => r.oxford_level === level) : BANK.slice(); }",
"function weakPh(p, min) {\n  const s = me(p).ph;\n  return Object.keys(s).map(k => Object.assign({ phoneme: k }, s[k]))\n    .filter(x => x.error_weight >= (min === undefined ? 0.6 : min))\n    .sort((a, b) => b.error_weight - a.error_weight);\n}",
"function bump(p, ph, gr, delta, okk) {\n  const s = me(p).ph;\n  const e = s[ph] = s[ph] || { phoneme: ph, grapheme: gr || '', error_weight: 0, correct: 0, wrong: 0 };\n  e.error_weight = Math.max(0, +(e.error_weight + delta).toFixed(2));\n  if (gr && !e.grapheme) e.grapheme = gr;\n  okk ? e.correct++ : e.wrong++;\n  persist();\n}",
"\n/* 线上版的人工重点生词：存在 localStorage（与 lexicon.html 同源共享） */\nconst PRIO_KEY = 'owk_user_words';\nfunction priorityWords() {\n  try {\n    return (JSON.parse(localStorage.getItem(PRIO_KEY) || '[]') || [])\n      .map((u) => ({ w: String(u.word || '').trim().toLowerCase(), weight: Number(u.weight) || 3 }))\n      .filter((x) => x.w);\n  } catch (e) { return []; }\n}\n\nfunction prioWeight(word) {\n  const k = String(word || '').trim().toLowerCase();\n  if (!k) return 0;\n  const hit = priorityWords().find((x) => x.w === k);\n  return hit ? hit.weight : 0;\n}",
"const __ENGINE = OWK.createEngine({\n  wordsInBank: (level) => bankFor(level),\n  weakPhonemes: (p) => weakPh(p, 0.6),\n  wordErrors: (p) => { const w = (me(p).words) || {}; const o = {}; for (const k in w) o[k] = { e: (w[k] && w[k].e) || 0 }; return o; },\n  priorityWeight: (word) => prioWeight(String(word || '').toLowerCase()),\n});\nfunction nextTask(p, level, type, character, exclude) { return __ENGINE.nextTask({ player: p, level, type, character, exclude }); }",
"\n/* ---- 判定 + 学情写回 ---- */\nfunction answerCard(p, card, response, ms) {\n  const okk = card.card_type === 'SYLLABLE_COUNTING' ? Number(response) === Number(card.correct) : String(response) === String(card.correct);\n  const hesitant = ms > 5000;\n  const st = me(p);\n  const bumpWord = (w, e) => { const r = st.words[w] = st.words[w] || { e: 0, c: 0 }; e ? r.e++ : r.c++; };\n\n  if (card.card_type === 'SYLLABLE_COUNTING') {\n    bumpWord(card.word, !okk);\n    (card.meta.graphemes || []).forEach(g => { const ph = PHONEME_PATTERNS.find(x => x.grapheme === g); if (ph && !okk) bump(p, ph.phoneme, ph.grapheme, 0.3, false); });\n  } else if (card.card_type === 'PHONEME_DISCRIMINATION') {\n    const pair = card.reveal.phonemes;\n    const idx = card.correct === card.reveal.pair[0] ? 0 : 1;\n    bump(p, pair[idx], (card.meta.graphemes || [])[0] || '', okk ? -0.5 : 1.6, okk);\n    if (!okk) {\n      const oSym = pair[1 - idx];\n      const oG = (PHONEME_PATTERNS.find(x => x.phoneme === oSym) || {}).grapheme || '';\n      bump(p, oSym, oG, 0.6, false);\n    }\n    bumpWord(card.correct, !okk);\n  } else if (card.card_type === 'PHONICS_CONTEXT_MATCH') {\n    const ph = PHONEME_PATTERNS.find(x => x.grapheme === card.reveal.grapheme);\n    if (ph) bump(p, ph.phoneme, ph.grapheme, okk ? (hesitant ? -0.3 : -0.7) : 1.2, okk);\n    bumpWord(card.correct, !okk);\n  } else {\n    bumpWord(card.word, !okk);\n  }\n  st.n++; if (okk) st.ok++; persist();\n\n  let fb;\n  if (okk && ms < 2000) fb = { message: '太棒了！秒答！', type: 'encouragement' };\n  else if (okk) fb = { message: '答对了！做得好！', type: 'encouragement' };\n  else if (card.card_type === 'SYLLABLE_COUNTING') fb = { message: '这个词要这样切：' + card.reveal.display, hint: '拍着手跟着读：' + card.reveal.display };\n  else if (card.card_type === 'PHONEME_DISCRIMINATION') fb = { message: '注意听：' + card.reveal.phonemes[0] + ' 和 ' + card.reveal.phonemes[1] + ' 是不同的音', hint: card.reveal.tip + '！再听一遍' };\n  else if (card.card_type === 'PHONICS_CONTEXT_MATCH') fb = { message: card.reveal.grapheme + ' 通常发 ' + card.reveal.phoneme, hint: '同家族的词还有：' + card.reveal.family.join('、') };\n  else if (card.card_type === 'PUNCTUATION_MARK') fb = { message: (okk ? '答对了！这里用 ' : '这里应该用 ') + card.correct, hint: (card.reveal || {}).tip || '' };\n  else fb = { message: '再记一次：' + card.reveal.word + ' = ' + card.reveal.zh, hint: card.reveal.tip };\n\n  return { is_correct: okk, correct_answer: card.correct, feedback: fb, reveal: card.reveal, hesitant };\n}\n\nfunction profileOf(p) {\n  const st = me(p);\n  const weak = weakPh(p, 0).filter(w => w.error_weight > 0).slice(0, 10);\n  const words = Object.keys(st.words).map(w => ({ word: w, error_count: st.words[w].e, correct: st.words[w].c }))\n    .filter(x => x.error_count > 0).sort((a, b) => b.error_count - a.error_count).slice(0, 12);\n  return { player: p, total: st.n, correct: st.ok, accuracy: st.n ? Math.round(st.ok / st.n * 100) : 0, weak_phonemes: weak, trouble_words: words };\n}\n\nfunction recommendFor(p, level) {\n  const st = me(p);\n  const weak = Object.keys(st.ph).map(k => Object.assign({ phoneme: k }, st.ph[k]))\n    .filter(x => x.error_weight > 0 && x.grapheme).sort((a, b) => b.error_weight - a.error_weight).slice(0, 3);\n  const bank = bankFor(level);\n  const trouble = Object.keys(st.words).filter(w => st.words[w].e > 0)\n    .map(w => ({ word: w, hint: (BANK.find(r => norm(r.word) === norm(w)) || {}).hint || '', grapheme: '', phoneme: '' }));\n  if (!weak.length) return trouble.length\n    ? { reason: '这些词你错过，先回去读一遍', focus: [], words: trouble.slice(0, 8) }\n    : { reason: '还没有明显薄弱点，继续按进度练习就好', focus: [], words: [] };\n  const picked = [], reasons = [];\n  weak.forEach(w => {\n    const hits = bank.filter(r => w.grapheme && norm(r.word).includes(w.grapheme));\n    if (hits.length) {\n      reasons.push('「' + w.grapheme + '」' + w.phoneme + ' 错误权重 ' + w.error_weight);\n      hits.slice(0, 6).forEach(r => { if (!picked.some(x => x.word === r.word)) picked.push({ word: r.word, hint: r.hint, grapheme: w.grapheme, phoneme: w.phoneme }); });\n    }\n  });\n  if (!picked.length && trouble.length) return { reason: '这些词你错过，先回去读一遍', focus: [], words: trouble.slice(0, 8) };\n  return { reason: reasons.length ? '优先补这些音：' + reasons.join('；') : '继续巩固', focus: weak, words: picked.slice(0, 12) };\n}",
].join('\n');


/* ── 5. 组装 ── */
const uiScript = tpl.slice(scriptStart + '<script>'.length).replace(/<\/script>[\s\S]*$/i, '')
  .replace("const API='/api';", "const API='';").replace(
  /async function fetchCard\(type\)\{[\s\S]*?\n\}/,
  'async function fetchCard(type){ const _ex=roundWords.concat(pSeen()).filter((v,i,a)=>a.indexOf(v)===i); const _c=nextTask(ch, "G2", type, ch, _ex.join(",")); if(_c && !_c.error) pPushSeen(_c.word||_c.correct||_c.audio_text||""); return _c; }'
).replace(
  /const res=await fetch\(`\$\{API\}\/practice\/answer`,[\s\S]*?\{error:'network'\}\)\);/,
  'const res = answerCard(ch, card, val, ms);'
).replace(
  /const prof=await fetch\(`\$\{API\}\/practice\/profile\?player=\$\{ch\}`\)\.then\(r=>r\.json\(\)\)\.catch\(\(\)=>null\);/g,
  'const prof = profileOf(ch);'
).replace(
  /const rec=await fetch\(`\$\{API\}\/practice\/recommend\?level=G2&player=\$\{ch\}`\)\.then\(r=>r\.json\(\)\)\.catch\(\(\)=>null\);/g,
  'const rec = recommendFor(ch, "G2");'
).replace(
  /fetch\(`\$\{API\}\/log`,[\s\S]*?\}\)\.catch\(\(\)=>\{\}\);/,
  '/* static build: no server log */'
);

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🎧 Word-Knight | Phonics</title>
${css}
</head>
${markup}
<script>
${ENGINE}
${uiScript}
</script>
</body>
</html>`;

// 语法自检：把 <script> 内容丢给 node 检查，避免再出现重复声明这类整块失效
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) throw new Error('no script block generated');
try { new Function(scriptMatch[1]); }
catch (e) { throw new Error('generated script has syntax error: ' + e.message); }
console.log('syntax check: OK');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'phonics.html'), html, 'utf8');
console.log('wrote docs/phonics.html', (html.length / 1024).toFixed(1) + ' KB');

// 防回归：静态页必须用共享引擎，不能再出现手工抄写的生成器
{
  const out = fs.readFileSync(path.join(OUT, 'phonics.html'), 'utf8');
  for (const k of ['OWK.createEngine', 'shared/engine.js'])
    if (!out.includes(k)) throw new Error('静态构建缺少共享引擎标记: ' + k);
  for (const k of ['function genSyllable', 'const chosen = scored[0]', 'Math.min(5, scored.length)'])
    if (out.includes(k)) throw new Error('静态构建仍含手工引擎副本: ' + k);
  console.log('静态引擎: 共享 shared/engine.js ✓（无手工副本）');
}
console.log('word bank embedded:', BANK.length, 'words');

/* ═══════════════════════════════════════════════════════════
   静态版词库浏览页 docs/lexicon.html
   数据在构建期内嵌（与 /api/lexicon 同口径）；
   人工生词改存 localStorage（静态站没有后端，无法共享）
   ═══════════════════════════════════════════════════════════ */
{
  // 构建期如果有数据库，就把图谱权重一并算进来；没有库则全部走理论权重
  let weightOf = null;
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(ROOT, 'backend/db.sqlite3');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      weightOf = require('./backend/lexicon-weight.js').buildWeightLookup(db);
      console.log('图谱权重: 已从数据库读取边');
    }
  } catch (e) { console.warn('图谱权重: 读取数据库失败，全部使用理论权重 —', e.message); }
  // 没有数据库时也要有个 lookup（边为空 → 全部走理论权重），只建一次
  if (!weightOf) {
    weightOf = require('./backend/lexicon-weight.js')
      .buildWeightLookup({ prepare: () => ({ all: () => [] }) });
  }

  const LEX_ROWS = BANK.map((r, i) => {
    const w = String(r.word).trim();
    const syllables = practice.syllableCount(w);
    const letters = w.length;
    const graphemes = (() => { const t = w.toLowerCase().replace(/[^a-z]/g, ''); return practice.PHONEME_PATTERNS.filter((p) => t.includes(p.grapheme)).map((p) => p.grapheme); })();
    const stage = Number(r.stage) || null;
    const weight = weightOf(w, { syllables, letters, graphemes, stage });
    return {
      id: i + 1,
      word: w,
      hint: r.hint || '',
      sentence: r.sentence || '',
      oxford_level: r.oxford_level || 'G2',
      stage,
      syllables,
      letters,
      isPhrase: /\s/.test(w),
      phonemes: graphemes,
      characters: practice.charactersIn(r.sentence),
      weight,
      manualWeight: 0,
    };
  });

  const cnt = (arr, fn) => arr.reduce((a, x) => { const k = fn(x); a[k] = (a[k] || 0) + 1; return a; }, {});
  const wordCount = new Map();
  for (const r of LEX_ROWS) {
    const k = r.word.toLowerCase();
    wordCount.set(k, (wordCount.get(k) || 0) + 1);
  }
  const sylBuckets = { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };
  for (const r of LEX_ROWS) { const n = Math.min(r.syllables, 5); sylBuckets[n] = (sylBuckets[n] || 0) + 1; }

  const LEX_STATS = {
    rows: LEX_ROWS.length,
    unique: wordCount.size,
    duplicates: [...wordCount.entries()].filter(([, n]) => n > 1).map(([word, count]) => ({ word, count })),
    phrases: LEX_ROWS.filter((r) => r.isPhrase).length,
    byLevel: cnt(LEX_ROWS, (r) => r.oxford_level),
    byStage: cnt(LEX_ROWS, (r) => (r.stage ? 'S' + r.stage : '未分级')),
    avgLen: Math.round((LEX_ROWS.reduce((a, r) => a + r.letters, 0) / LEX_ROWS.length) * 10) / 10,
    syllables: sylBuckets,
    letters: cnt(LEX_ROWS, (r) => String(r.word)[0].toLowerCase()),
    withSentence: LEX_ROWS.filter((r) => r.sentence).length,
    withCharacter: LEX_ROWS.filter((r) => r.characters.length > 0).length,
    weight: (() => {
      const by = (b) => LEX_ROWS.filter((r) => r.weight.basis === b);
      const direct = by('direct'), prop = by('propagated'), est = by('estimated');
      return {
        directCount: direct.length,
        propagatedCount: prop.length,
        estimatedCount: est.length,
        maxMeasured: direct.length ? Math.max(...direct.map((r) => r.weight.measured)) : 0,
        avgEstimated: Math.round((est.reduce((a, r) => a + r.weight.estimated, 0) / Math.max(1, est.length)) * 100) / 100,
        top: LEX_ROWS.slice().sort((a, b) => b.weight.value - a.weight.value).slice(0, 15)
          .map((r) => ({ word: r.word, value: r.weight.value, basis: r.weight.basis, players: r.weight.parts.players })),
      };
    })(),
  };

  let lexTpl = fs.readFileSync(path.join(ROOT, 'frontend/lexicon.html'), 'utf8');
  lexTpl = lexTpl
    .replace(/<title>[^<]*<\/title>/, '<title>🗂️ Word-Knight 词库浏览</title>')
    .replace(/href="\/"/g, 'href="./index.html"')
    .replace(/href="\/practice"/g, 'href="./phonics.html"')
    // 静态站没有数据看板，别留一个指向首页的假链接
    .replace(/\s*<a href="\/dashboard">🛠️ 数据看板<\/a>/g, '')
    .replace(/href="\/lexicon"/g, 'href="./lexicon.html"')
    // 数据内嵌
    .replace("try{\n    const r = await fetch('/api/lexicon');\n    DATA = await r.json();",
             'try{\n    DATA = LEXICON;')
    // 静态版：逐词改权重写 localStorage（同源，游戏页会读它）
    .replace(/async function setManualWeight\(word, val\)\{[\s\S]*?\n\}\n/,
      "async function setManualWeight(word, val){\n"
      + "  const v = Number(val) || 0;\n"
      + "  if(v > 0) uwAdd({ word, weight: v }); else uwDel(word);\n"
      + "  const hit = (DATA.words||[]).find(w => String(w.word).toLowerCase() === String(word).toLowerCase());\n"
      + "  if(hit) hit.manualWeight = v > 0 ? v : 0;\n"
      + "  if(v > 0) UWMAP.set(String(word).toLowerCase(), v); else UWMAP.delete(String(word).toLowerCase());\n"
      + "  await loadUserWords(); applyFilter();\n"
      + "  const m=document.getElementById('uwMsg');\n"
      + "  m.textContent = v > 0\n"
      + "    ? '✅ 「'+word+'」手动权重 = '+v+'★（已存本浏览器，刷新本页/游戏页立即生效）'\n"
      + "    : '✓ 已取消「'+word+'」的手动权重';\n"
      + "  m.className = 'note ' + (v > 0 ? 'green' : 'dim');\n"
      + "}\n")
    // 人工生词 → localStorage
    .replace("const r = await fetch('/api/user-words'); const d = await r.json();",
             'const d = { words: uwLoad() };')
    .replace(/const r = await fetch\('\/api\/user-words', \{[\s\S]*?\n    \}\);\n    const d = await r\.json\(\);/,
             'const d = uwAdd({ word, hint: document.getElementById("uwHint").value.trim(), sentence: document.getElementById("uwSent").value.trim(), weight: Number(document.getElementById("uwW").value) || 3 });')
    .replace(/await fetch\('\/api\/user-words\/delete', \{[\s\S]*?\n  \}\);/,
             'uwDel(word);')
    // 静态站没有后端：文案必须如实说明"只存在本浏览器"
    // 顶部横幅：静态版不影响任何出题
    .replace(/<div class="banner" id="scopeBanner">[\s\S]*?<\/div>/,
      '<div class="banner">✅ <b>线上版：权重存在你当前这个浏览器里（localStorage）</b>，'
      + '和游戏页同源，<b>改完立刻影响本浏览器上的出题</b>（最多占每轮 40%）。'
      + '<br>⚠️ 换设备 / 换浏览器 / 清缓存后失效；要全局生效请用本地后台 '
      + '<code>localhost:3000/lexicon</code> 或重新构建推送。</div>')
    // 手动权重列保持可编辑（写 localStorage）
    .replace('录入后该词会同步进主词库，并在每轮答题中优先出现（最多占 40%）。',
             '⚠️ 静态版没有后端：这里录入的生词<b>只保存在当前浏览器</b>，用于自己核对清单，不会进入线上题库。要真正影响出题，请用本地 http://localhost:3000/lexicon 。')
    .replace("msg.textContent = '✅ 已加入「' + word + '」，每轮答题会优先出现';",
             "msg.textContent = '✅ 已记录「' + word + '」（仅本浏览器可见，不影响线上题库）';");

  // 注入数据
  const inject = `const LEXICON = ${JSON.stringify({ stats: LEX_STATS, words: LEX_ROWS })};\n`
    + `/* 静态版：人工生词存浏览器本地 */\n`
    + `function uwLoad(){ try{ return JSON.parse(localStorage.getItem('owk_user_words')||'[]'); }catch(e){ return []; } }\n`
    + `function uwSave(a){ try{ localStorage.setItem('owk_user_words', JSON.stringify(a)); }catch(e){} }\n`
    + `function uwAdd(o){ const a=uwLoad(); const k=String(o.word).trim().toLowerCase();\n`
    + `  if(!k) return { error:'word 不能为空' };\n`
    + `  const i=a.findIndex(x=>String(x.word).toLowerCase()===k);\n`
    + `  const rec={ word:o.word, hint:o.hint||'', sentence:o.sentence||'', weight:o.weight||3, note:'' };\n`
    + `  if(i>=0) a[i]=rec; else a.push(rec); uwSave(a); return { success:true, word:rec }; }\n`
    + `function uwDel(w){ const a=uwLoad().filter(x=>String(x.word).toLowerCase()!==String(w).toLowerCase()); uwSave(a); }\n`;

  lexTpl = lexTpl.replace('<script>', '<script>\n' + inject);

  const lexScript = lexTpl.slice(lexTpl.indexOf('<script>') + 8, lexTpl.lastIndexOf('</script>'));
  try { new Function(lexScript); } catch (e) { throw new Error('lexicon script syntax error: ' + e.message); }
  if (lexTpl.includes("/api/")) console.warn('⚠️ lexicon 仍残留 /api/ 调用:', (lexTpl.match(/\/api\/[a-z-]+/g) || []).join(', '));

  fs.writeFileSync(path.join(OUT, 'lexicon.html'), lexTpl, 'utf8');
  console.log('wrote docs/lexicon.html', (lexTpl.length / 1024).toFixed(1) + ' KB', '|', LEX_STATS.rows, 'words');
}


/* ═══════════════════════════════════════════════════════════
   静态版管理后台 docs/dashboard.html
   Pages 没有后端，所以构建时临时拉起 backend（:3999）抓一份真实数据，
   把 4 个接口的响应内嵌进页面 —— 保证与本地口径完全一致，只是「快照」。
   ═══════════════════════════════════════════════════════════ */
{
  const { spawn, execSync } = require('child_process');
  const PORT = 3999;
  let snap = { dashboard: null, access: null, sessions: null, stats: null };

  try {
    const child = spawn('node', ['backend/server.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', detached: false,
    });
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try { execSync(`curl -s -o /dev/null --max-time 2 http://localhost:${PORT}/api/stats`); ready = true; break; }
        catch (e) { execSync('sleep 0.25'); }
      }
      if (!ready) throw new Error('临时后端未就绪');
      const grab = (p) => JSON.parse(execSync(`curl -s --max-time 20 "http://localhost:${PORT}${p}"`, { maxBuffer: 1 << 28 }).toString() || 'null');
      snap.dashboard = grab('/api/dashboard');
      snap.access = grab('/api/access-log?limit=200');
      snap.sessions = grab('/api/session-events?limit=200');
      snap.stats = grab('/api/stats');
      console.log('后台快照: 已抓取 4 个接口');
    } finally {
      try { child.kill('SIGKILL'); } catch (e) {}
    }
  } catch (e) {
    console.warn('后台快照: 抓取失败，将嵌入空数据 —', e.message);
  }

  let tpl = fs.readFileSync(path.join(ROOT, 'frontend/admin.html'), 'utf8');

  tpl = tpl
    .replace(/<title>[^<]*<\/title>/, '<title>🛠️ Word-Knight 管理后台（线上快照）</title>')
    // 顶部加"快照"说明
    .replace('<h1>🛠️ Word-Knight 管理后台</h1>',
      '<h1>🛠️ Word-Knight 管理后台</h1>\n'
      + '<div style="border:3px solid #EF6C00;background:#3E2A10;padding:10px;margin-bottom:10px;font-size:0.38em;line-height:1.9;color:#FFE0B2;">'
      + '📸 <b>这是上线时抓取的静态快照</b>：数据冻结在构建时刻，不能实时刷新，也不能上传/清空。'
      + '实时后台请用本地 <code>http://localhost:3000/dashboard</code>。'
      + (snap.dashboard ? '' : ' ⚠️ 本次构建未取到数据。')
      + '</div>')
    // 接口 → 内嵌数据
    .replace("const r = await fetch(API+'/api/dashboard'), d = await r.json();", 'const d = DASHBOARD_SNAPSHOT;')
    .replace("const d = await (await fetch(API + '/api/access-log?limit=200')).json();", 'const d = ACCESS_SNAPSHOT;')
    .replace("const d = await (await fetch(API + '/api/session-events?limit=200')).json();", 'const d = SESSIONS_SNAPSHOT;')
    .replace("try { const r = await fetch(API+'/api/stats'), d = await r.json();",
             'try { const d = STATS_SNAPSHOT;')
    .replace(/await fetch\(API\+'\/api\/dashboard\/clear'\);/, "/* 静态快照：不可清空 */")
    // CSV 导入在静态版不可用：整段替换成提示
    .replace("try { const res=await fetch(API+'/api/import',{method:'POST',body:r.result}), d=await res.json();\n        m.textContent=d.success?'✅ '+d.message:'❌ '+d.error; m.className='msg '+(d.success?'ok':'err'); if(d.success)st(); }\n      catch { m.textContent='❌ 失败'; m.className='msg err'; }",
             "m.textContent='📸 静态快照不支持导入，请用本地后台'; m.className='msg err';");

  // 注入数据
  tpl = tpl.replace('<script>',
    '<script>\n'
    + `const DASHBOARD_SNAPSHOT = ${JSON.stringify(snap.dashboard)};\n`
    + `const ACCESS_SNAPSHOT = ${JSON.stringify(snap.access)};\n`
    + `const SESSIONS_SNAPSHOT = ${JSON.stringify(snap.sessions)};\n`
    + `const STATS_SNAPSHOT = ${JSON.stringify(snap.stats)};\n`);

  const snapScript = tpl.slice(tpl.indexOf('<script>') + 8, tpl.lastIndexOf('</script>'));
  try { new Function(snapScript); } catch (e) { throw new Error('dashboard 快照脚本语法错误: ' + e.message); }
  // 注意：内嵌数据里有 path:"/api/..." 这类字符串，不能拿 /api/ 判断；
  // 只检查是否还有真正的 fetch(API + ...) 调用
  const leftover = tpl.match(/fetch\(\s*API\s*\+/g) || [];
  if (leftover.length) console.warn('⚠️ dashboard 快照仍有', leftover.length, '处 fetch(API…) 调用');

  fs.writeFileSync(path.join(OUT, 'dashboard.html'), tpl, 'utf8');
  console.log('wrote docs/dashboard.html', (tpl.length / 1024).toFixed(1) + ' KB');
}

/* ═══════════════════════════════════════════════════════════
   同步 docs/index.html 的内嵌词库（它是手工维护的静态副本）
   —— 人工加的高权重生词只进数据库，不自动同步就会永远不上线。
   ═══════════════════════════════════════════════════════════ */
function syncStaticGameWords() {
  const p = path.join(__dirname, 'docs', 'index.html');
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, 'utf8');

  // 用括号配对定位数组边界（正则的非贪婪匹配会在内层 `];` 处提前截断）
  const marker = src.indexOf('const WORDS');
  if (marker < 0) return console.warn('⚠️ docs/index.html 未找到 WORDS');
  const open = src.indexOf('[', marker);
  let depth = 0, close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return console.warn('⚠️ WORDS 数组未闭合');

  let arr;
  try { arr = JSON.parse(src.slice(open, close + 1)); }
  catch (e) { return console.warn('⚠️ WORDS 解析失败，跳过同步:', e.message); }

  let dbWords = [];
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(__dirname, 'backend', 'db.sqlite3'), { readonly: true });
    dbWords = db.prepare('SELECT word, hint, sentence, oxford_level FROM words ORDER BY id').all();
    db.close();
  } catch (e) { return console.warn('⚠️ 读库失败，跳过静态词库同步'); }

  // 以数据库为准；保留静态数组里数据库没有的词（防止手工补充被冲掉）
  const seen = new Set();
  const merged = [];
  for (const r of dbWords) {
    const k = String(r.word || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push({ word: r.word, hint: r.hint || '', sentence: r.sentence || '', oxford_level: r.oxford_level || 'G1' });
  }
  for (const r of arr) {
    const k = String(r.word || '').toLowerCase();
    // 只保留纯字母词：否则数据库里删掉的短语会被静态数组"复活"
    if (!k || !/^[a-z]+$/.test(k) || seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }

  if (merged.length === arr.length && merged.every((m, i) => m.word === arr[i].word)) {
    return console.log('静态主页词库: 已同步 (' + arr.length + ' 词)');
  }
  fs.writeFileSync(p, src.slice(0, open) + JSON.stringify(merged) + src.slice(close + 1));
  console.log(`静态主页词库: ${arr.length} → ${merged.length} 词`);
}
syncStaticGameWords();
