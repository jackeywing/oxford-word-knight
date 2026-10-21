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
// 优先用 build-lexicon.js 产出的合并词库（含 stage、已去重、已补例句）
const _rawBank = fs.existsSync(path.join(ROOT, 'words-merged.csv'))
  ? readCsv('words-merged.csv')
  : readCsv('g2-words.csv').concat(readCsv('sample-words.csv'));
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
const ENGINE = `
/* ================= 静态版引擎（localStorage 代替 SQLite） ================= */
${syllablesBlock}
${charactersFnBlock}
const PHONEME_PATTERNS = ${JSON.stringify(DATA.PHONEME_PATTERNS)};
const MINIMAL_PAIRS     = ${JSON.stringify(DATA.MINIMAL_PAIRS)};
const SIGHT_WORDS       = ${JSON.stringify(DATA.SIGHT_WORDS)};
const BANK              = ${JSON.stringify(BANK)};

const STORE_KEY = 'owk_phonics_v1';
let DB = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } })();
const persist = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) {} };
const me = (p) => { DB[p] = DB[p] || { ph: {}, words: {}, n: 0, ok: 0 }; return DB[p]; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function bankFor(level) { return level ? BANK.filter(r => r.oxford_level === level) : BANK.slice(); }
function phonemesOf(word) {
  const w = norm(word);
  return PHONEME_PATTERNS.filter(p => w.includes(p.grapheme));
}
function weakPh(p, min) {
  const s = me(p).ph;
  return Object.keys(s).map(k => Object.assign({ phoneme: k }, s[k]))
    .filter(x => x.error_weight >= (min === undefined ? 0.6 : min))
    .sort((a, b) => b.error_weight - a.error_weight);
}
function bump(p, ph, gr, delta, okk) {
  const s = me(p).ph;
  const e = s[ph] = s[ph] || { phoneme: ph, grapheme: gr || '', error_weight: 0, correct: 0, wrong: 0 };
  e.error_weight = Math.max(0, +(e.error_weight + delta).toFixed(2));
  if (gr && !e.grapheme) e.grapheme = gr;
  okk ? e.correct++ : e.wrong++;
  persist();
}

/* ---- 1. 音节计数 ---- */
function genSyllable(p, level, character) {
  const bank = bankFor(level).filter(r => /^[a-z]{3,}$/i.test(String(r.word).trim()));
  if (!bank.length) return null;
  const weak = weakPh(p), weakSet = new Set(weak.map(w => w.grapheme).filter(Boolean));
  const scored = bank.map(r => {
    const ph = phonemesOf(r.word);
    const hit = ph.filter(x => weakSet.has(x.grapheme)).length;
    const syl = syllableCount(r.word);
    return { row: r, syl, ph, score: 1 + syl * 0.8 + hit * 1.5 + Math.random() * 0.8 };
  }).sort((a, b) => b.score - a.score);
  const pick = scored[Math.floor(Math.random() * Math.min(5, scored.length))];
  const n = pick.syl, opts = [];
  if (n > 1) opts.push(n - 1);
  opts.push(n + 1);
  if (n > 2 && Math.random() < 0.5) opts.push(n - 2);
  const options = Array.from(new Set(opts.concat([n]))).sort((a, b) => a - b);
  const parts = syllabify(pick.row.word);
  return {
    card_type: 'SYLLABLE_COUNTING', word: pick.row.word, hint: pick.row.hint,
    speaker: CHARACTERS[character] || null,
    prompt: (characterLabel(character) ? characterLabel(character) + ' 想考考你：' : '') + '这个词有几个音节？拍着手读一读',
    options, correct: n, focus: 'syllable',
    reveal: { syllables: parts, display: parts.join(' · '), tip: n >= 3 ? '长单词可以分段读，先读第一部分再读第二部分。' : '每个元音组通常就是一个音节。' },
    meta: { graphemes: pick.ph.map(x => x.grapheme) },
  };
}

/* ---- 2. 音素辨析 ---- */
function genPhoneme(p, level, character) {
  const weak = weakPh(p), wm = new Map(weak.map(w => [w.phoneme, w.error_weight]));
  const bank = new Set(bankFor(level).map(r => norm(r.word)));
  const scored = MINIMAL_PAIRS.map(pair => {
    const w = Math.max(wm.get(pair.pa) || 0, wm.get(pair.pb) || 0);
    const inBank = (bank.has(norm(pair.a)) ? 1 : 0) + (bank.has(norm(pair.b)) ? 1 : 0);
    return { pair, score: 1 + w * 2 + inBank * 0.6 + Math.random() * 0.7 };
  }).sort((a, b) => b.score - a.score);
  const pr = scored[Math.floor(Math.random() * Math.min(4, scored.length))].pair;
  const isA = Math.random() < 0.5, target = isA ? pr.a : pr.b;
  return {
    card_type: 'PHONEME_DISCRIMINATION', audio_text: target, speaker: CHARACTERS[character] || null,
    prompt: '听一听，选出你听到的词',
    options: [pr.a, pr.b], correct: target, focus: isA ? pr.pa : pr.pb,
    reveal: { pair: [pr.a, pr.b], phonemes: [pr.pa, pr.pb], meanings: [pr.zh_a, pr.zh_b], tip: pr.tip, target },
    meta: { graphemes: PHONEME_PATTERNS.filter(x => x.phoneme === (isA ? pr.pa : pr.pb)).map(x => x.grapheme) },
  };
}

/* ---- 3. 拼读规则 ---- */
function genPhonics(p, level, character) {
  const all = bankFor(level).filter(r => r.sentence);
  if (!all.length) return genSyllable(p, level, character);
  let bank = character
    ? all.filter(r => { const cs = charactersIn(r.sentence); return cs.length === 0 || cs.indexOf(character) >= 0; })
    : all;
  if (bank.length < 4) bank = all;
  const isOwn = (r) => !!character && charactersIn(r.sentence).indexOf(character) >= 0;
  const weak = weakPh(p), wm = new Map(weak.map(w => [w.phoneme, w.error_weight]));
  const cands = [];
  PHONEME_PATTERNS.forEach(pt => {
    if (pt.grapheme.length < 2) return;
    const hits = bank.filter(r => norm(r.word).includes(pt.grapheme));
    if (hits.length >= 2) cands.push({ pt, hits });
  });
  if (!cands.length) return genSyllable(p, level, character);
  const scored = cands.map(c => ({
    ...c,
    score: 1 + (wm.get(c.pt.phoneme) || 0) * 2 + Math.min(c.hits.length, 6) * 0.3
           + c.hits.filter(isOwn).length * 3.0 + Math.random() * 0.8,
  })).sort((a, b) => b.score - a.score);
  const chosen = scored[0];
  const ownHits = chosen.hits.filter(isOwn);
  const preferred = ownHits.length ? ownHits : chosen.hits;
  const single = /^[a-z]+$/i;
  const hitsSingle = preferred.filter(r => single.test(String(r.word).trim()));
  const poolSingle = bank.filter(r => single.test(String(r.word).trim()));
  const usePool = hitsSingle.length >= 2 ? hitsSingle : (preferred.length ? preferred : poolSingle);
  const targetRow = usePool[Math.floor(Math.random() * usePool.length)];
  const target = targetRow.word;
  const sameRule = usePool.filter(r => norm(r.word) !== norm(target)).slice(0, 2);
  const decoys = poolSingle.filter(r => !norm(r.word).includes(chosen.pt.grapheme)).slice(0, 1);
  let options = [target].concat(sameRule.map(r => r.word), decoys.map(r => r.word));
  options = Array.from(new Set(options));
  let guard = 0;
  while (options.length < 3 && guard++ < 40) {
    const extra = bank[Math.floor(Math.random() * bank.length)].word;
    if (options.indexOf(extra) < 0) options.push(extra);
  }
  options.sort(() => Math.random() - 0.5);
  let blanked = String(targetRow.sentence).replace(new RegExp(target.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'i'), '_____');
  if (blanked.indexOf('_____') < 0) blanked = blanked + ' ( _____ )';
  const own = isOwn(targetRow);
  return {
    card_type: 'PHONICS_CONTEXT_MATCH',
    speaker: CHARACTERS[character] || null, speaker_is_own_line: own,
    prompt: (characterLabel(character) && own) ? characterLabel(character) + ' 说的这句话缺了一个词' : '这句话里的空格应该填哪个词？',
    sentence: blanked, hint: targetRow.hint, options, correct: target, focus: chosen.pt.grapheme,
    reveal: { grapheme: chosen.pt.grapheme, phoneme: chosen.pt.phoneme, articulation: chosen.pt.articulation, family: usePool.map(r => r.word).slice(0, 6), tip: '字母组合 ' + chosen.pt.grapheme + ' 通常发 ' + chosen.pt.phoneme },
    meta: { rule: chosen.pt.grapheme },
  };
}

/* ---- 4. 视觉词闪现 ---- */
function genSight(p, level, character) {
  const ws = me(p).words || {};
  const pool = SIGHT_WORDS.map(([w, r, zh]) => ({ word: w, rank: r, zh, err: (ws[w] && ws[w].e) || 0 }))
    .sort((a, b) => (b.err * 10 - a.err * 10) + (a.rank - b.rank) + (Math.random() - 0.5) * 6)
    .slice(0, 12);
  const target = pool[Math.floor(Math.random() * Math.min(5, pool.length))];
  const others = SIGHT_WORDS.filter(([w]) => w !== target.word).sort(() => Math.random() - 0.5).slice(0, 3).map(x => x[2]);
  return {
    card_type: 'SIGHT_WORD_FLASH', word: target.word, speaker: CHARACTERS[character] || null,
    prompt: '闪现！快选它的意思', flash_ms: 800,
    options: [target.zh].concat(others).sort(() => Math.random() - 0.5),
    correct: target.zh, focus: 'sight:' + target.word,
    reveal: { word: target.word, zh: target.zh, rank: target.rank, tip: '高频词靠"整体认读"，不用逐字母拼。' },
    meta: { frequency_rank: target.rank },
  };
}

function nextTask(p, level, type, character) {
  const T = ['syllable', 'phoneme', 'phonics', 'sight'].indexOf(type) >= 0 ? type
    : ['syllable', 'phoneme', 'phonics', 'sight'][Math.floor(Math.random() * 4)];
  const f = { syllable: genSyllable, phoneme: genPhoneme, phonics: genPhonics, sight: genSight }[T];
  return f(p, level, character) || genSyllable(p, level, character);
}

/* ---- 判定 + 学情写回 ---- */
function answerCard(p, card, response, ms) {
  const okk = card.card_type === 'SYLLABLE_COUNTING' ? Number(response) === Number(card.correct) : String(response) === String(card.correct);
  const hesitant = ms > 5000;
  const st = me(p);
  const bumpWord = (w, e) => { const r = st.words[w] = st.words[w] || { e: 0, c: 0 }; e ? r.e++ : r.c++; };

  if (card.card_type === 'SYLLABLE_COUNTING') {
    bumpWord(card.word, !okk);
    (card.meta.graphemes || []).forEach(g => { const ph = PHONEME_PATTERNS.find(x => x.grapheme === g); if (ph && !okk) bump(p, ph.phoneme, ph.grapheme, 0.3, false); });
  } else if (card.card_type === 'PHONEME_DISCRIMINATION') {
    const pair = card.reveal.phonemes;
    const idx = card.correct === card.reveal.pair[0] ? 0 : 1;
    bump(p, pair[idx], (card.meta.graphemes || [])[0] || '', okk ? -0.5 : 1.6, okk);
    if (!okk) {
      const oSym = pair[1 - idx];
      const oG = (PHONEME_PATTERNS.find(x => x.phoneme === oSym) || {}).grapheme || '';
      bump(p, oSym, oG, 0.6, false);
    }
    bumpWord(card.correct, !okk);
  } else if (card.card_type === 'PHONICS_CONTEXT_MATCH') {
    const ph = PHONEME_PATTERNS.find(x => x.grapheme === card.reveal.grapheme);
    if (ph) bump(p, ph.phoneme, ph.grapheme, okk ? (hesitant ? -0.3 : -0.7) : 1.2, okk);
    bumpWord(card.correct, !okk);
  } else {
    bumpWord(card.word, !okk);
  }
  st.n++; if (okk) st.ok++; persist();

  let fb;
  if (okk && ms < 2000) fb = { message: '太棒了！秒答！', type: 'encouragement' };
  else if (okk) fb = { message: '答对了！做得好！', type: 'encouragement' };
  else if (card.card_type === 'SYLLABLE_COUNTING') fb = { message: '这个词要这样切：' + card.reveal.display, hint: '拍着手跟着读：' + card.reveal.display };
  else if (card.card_type === 'PHONEME_DISCRIMINATION') fb = { message: '注意听：' + card.reveal.phonemes[0] + ' 和 ' + card.reveal.phonemes[1] + ' 是不同的音', hint: card.reveal.tip + '！再听一遍' };
  else if (card.card_type === 'PHONICS_CONTEXT_MATCH') fb = { message: card.reveal.grapheme + ' 通常发 ' + card.reveal.phoneme, hint: '同家族的词还有：' + card.reveal.family.join('、') };
  else fb = { message: '再记一次：' + card.reveal.word + ' = ' + card.reveal.zh, hint: card.reveal.tip };

  return { is_correct: okk, correct_answer: card.correct, feedback: fb, reveal: card.reveal, hesitant };
}

function profileOf(p) {
  const st = me(p);
  const weak = weakPh(p, 0).filter(w => w.error_weight > 0).slice(0, 10);
  const words = Object.keys(st.words).map(w => ({ word: w, error_count: st.words[w].e, correct: st.words[w].c }))
    .filter(x => x.error_count > 0).sort((a, b) => b.error_count - a.error_count).slice(0, 12);
  return { player: p, total: st.n, correct: st.ok, accuracy: st.n ? Math.round(st.ok / st.n * 100) : 0, weak_phonemes: weak, trouble_words: words };
}

function recommendFor(p, level) {
  const st = me(p);
  const weak = Object.keys(st.ph).map(k => Object.assign({ phoneme: k }, st.ph[k]))
    .filter(x => x.error_weight > 0 && x.grapheme).sort((a, b) => b.error_weight - a.error_weight).slice(0, 3);
  const bank = bankFor(level);
  const trouble = Object.keys(st.words).filter(w => st.words[w].e > 0)
    .map(w => ({ word: w, hint: (BANK.find(r => norm(r.word) === norm(w)) || {}).hint || '', grapheme: '', phoneme: '' }));
  if (!weak.length) return trouble.length
    ? { reason: '这些词你错过，先回去读一遍', focus: [], words: trouble.slice(0, 8) }
    : { reason: '还没有明显薄弱点，继续按进度练习就好', focus: [], words: [] };
  const picked = [], reasons = [];
  weak.forEach(w => {
    const hits = bank.filter(r => w.grapheme && norm(r.word).includes(w.grapheme));
    if (hits.length) {
      reasons.push('「' + w.grapheme + '」' + w.phoneme + ' 错误权重 ' + w.error_weight);
      hits.slice(0, 6).forEach(r => { if (!picked.some(x => x.word === r.word)) picked.push({ word: r.word, hint: r.hint, grapheme: w.grapheme, phoneme: w.phoneme }); });
    }
  });
  if (!picked.length && trouble.length) return { reason: '这些词你错过，先回去读一遍', focus: [], words: trouble.slice(0, 8) };
  return { reason: reasons.length ? '优先补这些音：' + reasons.join('；') : '继续巩固', focus: weak, words: picked.slice(0, 12) };
}
`;

/* ── 5. 组装 ── */
const uiScript = tpl.slice(scriptStart + '<script>'.length).replace(/<\/script>[\s\S]*$/i, '')
  .replace("const API='/api';", "const API='';").replace(
  /async function fetchCard\(type\)\{[\s\S]*?\n\}/,
  'async function fetchCard(type){ return nextTask(ch, "G2", type, ch); }'
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
console.log('word bank embedded:', BANK.length, 'words');
