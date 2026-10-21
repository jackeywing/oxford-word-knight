/**
 * build-lexicon.js — 合并「既有词库 + 核心高频词表」并生成例句，导入 SQLite
 *
 * 数据来源（全部为公开的通用高频词表，非牛津树官方 Stage 词表）：
 *   data/core-sight.csv     Dolch 220 / Fry 常用词，按词频分级 stage 1–2
 *   data/core-nouns.csv     Dolch 名词 + 牛津树场景常用名词，stage 2–3
 *   data/core-phonics.csv   拼读家族（ight/ake/ee/oa/ai/ou/ow/sh/ch/th/ar/or）+ 形容词动词
 *   data/core-extra.csv     常用动词/名词/形容词补全
 *   g2-words.csv / sample-words.csv   项目原有词库（带牛津树风格例句）
 *
 * 例句生成原则：
 *   1. 已有真实例句的（原词库）一律保留，不覆盖
 *   2. 名词/动词/形容词/数词 → 用中性模板生成，模板不含任何人名，
 *      因此不会破坏「Biff 名下只有 Biff 的话」这条人物一致性规则
 *   3. 虚词（冠词/介词/连词/代词/副词）→ **不生成例句**，改用中文提示做填空。
 *      原因：The/A 这类空位有多个正确答案，克漏字会误判孩子答错。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.sqlite3');
const DRY = process.argv.includes('--dry');

/* ── CSV ── */
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(',').map((s) => s.trim().toLowerCase());
  return lines.map((line) => {
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
    return o;
  }).filter((o) => o.word);
}

const read = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return [];
  return parseCsv(fs.readFileSync(p, 'utf8'));
};

/* ── 例句模板（中性，不含人名）── */
const TPL = {
  // 名词：全部用「有定冠词」的中性句，避免 my a/an 之类冠词错误
  noun: [
    'Look at the ___!',
    'The ___ is over there.',
    'Where is the ___?',
    'I can see the ___.',
  ],
  // 形容词：不用 very / feels（gentle、excellent 这类不适用）
  adj: [
    'It is ___.',
    'That looks ___.',
    'This one is ___.',
  ],
  num: ['I have ___ apples.', 'She counted to ___.'],
  // 动词与副词**不自动生成**：及物/不及物、可分级/不可分级差别太大，
  // 模板必然写出 "She likes to open." / "Do you worry it?" 这类病句。
  // 这些词改用中文提示填空（____ (跑)），虽然朴素但不会教错。
};

/* 不规则词 / 复数 / 语义特殊者：手写例句，避免模板出错 */
const OVERRIDE = {
  // 不规则过去式
  came: 'She came to my house yesterday.',
  went: 'We went to the park last week.',
  saw: 'I saw a big bird in the tree.',
  took: 'He took the book home.',
  made: 'She made a cake for me.',
  said: 'He said it was too late.',
  found: 'I found the key under the bed.',
  began: 'The story began with a storm.',
  thought: 'I thought it was a good idea.',
  left: 'He left his bag on the bus.',
  gave: 'She gave me a little present.',
  wrote: 'She wrote a letter to her friend.',
  felt: 'He felt cold in the rain.',
  kept: 'She kept the shell in a box.',
  grew: 'The tree grew very tall.',
  knew: 'I knew the answer.',
  ran: 'The dog ran across the field.',
  ate: 'We ate lunch by the river.',
  // 复数 / 不可数
  children: 'The children played in the garden.',
  feet: 'My feet were wet from the snow.',
  men: 'Two men were waiting by the gate.',
  scissors: 'She cut the paper with scissors.',
  stairs: 'He ran up the stairs.',
  grass: 'The grass was long and green.',
  money: 'He saved his money in a jar.',
  water: 'She drank a glass of water.',
  milk: 'I had milk with my breakfast.',
  bread: 'We bought bread from the shop.',
  sand: 'The sand was warm under my feet.',
  snow: 'The snow covered the whole garden.',
  rain: 'The rain did not stop all day.',
  ice: 'The ice was cold and hard.',
  mud: 'His boots were covered in mud.',
  wood: 'The table is made of wood.',
  treasure: 'They looked for treasure in the cave.',
  // 语义特殊
  birthday: 'My birthday is in the summer.',
  morning: 'We went out early in the morning.',
  afternoon: 'She slept all afternoon.',
  evening: 'The sun went down in the evening.',
  night: 'The stars were bright at night.',
  today: 'We are going to the beach today.',
  tomorrow: 'We will visit them tomorrow.',
  yesterday: 'It rained all day yesterday.',
  tonight: 'We will read a story tonight.',
  hello: 'She said hello to the teacher.',
  goodbye: 'He waved goodbye at the gate.',
  please: 'Please close the door.',
  sorry: 'I am sorry about the mess.',
  yes: 'He said yes to the plan.',
  okay: 'It is okay to make a mistake.',
  hundred: 'There were a hundred people there.',
  // 动词形态
  does: 'She does her homework after dinner.',
  did: 'He did the washing up.',
  been: 'I have been to the beach.',
  being: 'The baby was being very quiet.',
  are: 'They are in the garden.',
  were: 'We were at school all day.',
  was: 'She was very tired.',
  is: 'The cat is on the bed.',
  be: 'It will be cold tonight.',
  has: 'She has a new bike.',
  had: 'We had a big dinner.',
  have: 'I have two sisters.',
  can: 'I can swim very well.',
  could: 'She could not find her shoe.',
  will: 'We will go home soon.',
  would: 'He would like some water.',
  should: 'You should wash your hands.',
  must: 'We must be quiet here.',
  may: 'You may come in now.',
  // 常见副词（模板不适用）
  quickly: 'He ran quickly to the gate.',
  slowly: 'The turtle moved slowly.',
  quietly: 'She closed the door quietly.',
  loudly: 'The dog barked loudly.',
  carefully: 'He carried the glass carefully.',
  suddenly: 'Suddenly the light went out.',
  finally: 'Finally the rain stopped.',
  already: 'She had already eaten.',
  early: 'We got up early.',
  late: 'He was late for school.',
  inside: 'It was warm inside the house.',
  outside: 'The children played outside.',
  upstairs: 'She went upstairs to bed.',
  downstairs: 'He ran downstairs for breakfast.',
  everywhere: 'There was water everywhere.',
  somewhere: 'I left my hat somewhere.',
  badly: 'He hurt his knee badly.',
  certainly: 'I will certainly help you.',
  clearly: 'She spoke clearly and slowly.',
  easily: 'He climbed the tree easily.',
  exactly: 'That is exactly what I said.',
  hardly: 'I could hardly see in the fog.',
  immediately: 'She came immediately when called.',
  instead: 'We had tea instead of coffee.',
  luckily: 'Luckily nobody was hurt.',
  nearly: 'We nearly missed the bus.',
  perhaps: 'Perhaps it will snow tonight.',
  probably: 'It will probably rain later.',
  properly: 'Put the books back properly.',
  rarely: 'He rarely eats sweets.',
  really: 'I really like this story.',
  recently: 'She recently moved house.',
  safely: 'They arrived home safely.',
  seriously: 'He took the warning seriously.',
  simply: 'It is simply too cold.',
  surely: 'Surely you remember me.',
  usually: 'We usually walk to school.',
  never: 'She never eats breakfast.',
  always: 'He always helps his sister.',
  sometimes: 'Sometimes we go to the park.',
  soon: 'She will be back soon.',
  together: 'They walked home together.',
  again: 'Please read it again.',
  now: 'We must go now.',
  then: 'We ate, then we played.',
  away: 'The bird flew away.',
  down: 'He sat down on the chair.',
  up: 'She stood up quickly.',
  off: 'He took off his coat.',
  out: 'They went out to play.',
  back: 'She came back at six.',
  too: 'The soup is too hot.',
  also: 'She also likes to draw.',
  even: 'Even the dog was quiet.',
  just: 'I just finished my homework.',
  very: 'The water is very cold.',
  so: 'It was so dark outside.',
  still: 'She is still in bed.',
  most: 'Most children like this book.',
  more: 'I want more cake.',
  much: 'He did not eat much.',
  well: 'She sings very well.',
  not: 'He did not come today.',
  all: 'All the children were there.',
  first: 'She was the first to arrive.',
  second: 'He came second in the race.',
  // 其余虚词：不生成例句，走中文提示填空
};

/* ── 手写例句表（data/sentences.csv），优先级低于原有词库的牛津树原句 ── */
const FILE_SENT = (() => {
  const p = path.join(ROOT, 'data/sentences.csv');
  if (!fs.existsSync(p)) return {};
  const m = {};
  for (const r of parseCsv(fs.readFileSync(p, 'utf8'))) {
    if (r.word && r.sentence) m[r.word.trim().toLowerCase()] = r.sentence.trim();
  }
  return m;
})();

/* ── 虚词：生成的空位有多个正确答案，不做克漏字例句 ── */
const NO_SENTENCE_POS = new Set(['det', 'prep', 'conj', 'pron', 'other']);

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/* sample-words.csv 的句子是「已挖空」格式（"____ at me," said Biff.），
   导入时必须把词填回去，否则克漏字会二次挖空、题目无法作答。
   处于句首/引号开头时首字母大写。 */
function restoreBlank(sentence, word) {
  if (!/_{3,}/.test(sentence)) return sentence;
  return sentence.replace(/_{3,}/g, (_m, offset, full) => {
    const before = full.slice(0, offset);
    const trimmed = before.replace(/[\s"'“”‘’(\[]+$/g, '');
    const atSentenceStart = trimmed === '' || /[.!?]$/.test(trimmed);
    const w = String(word);
    return atSentenceStart ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  });
}

/* 以 s 结尾但实际是单数的名词，允许套模板 */
const SINGULAR_S = new Set(['grass','glass','bus','class','dress','cross','news','chess','gas','kiss','boss','moss','loss','address']);
const nounTemplateOk = (w) => !(w.endsWith('s') && !SINGULAR_S.has(w));

/* 抽象/不可数名词套 "Look at the ___!" 会读起来很怪（the summer / the voice），
   这类词不给模板句，改用中文提示填空 */
const ABSTRACT_NOUN = new Set(('voice noise dream wish secret surprise magic space holiday ' +
  'breakfast dinner morning afternoon evening body hair tear smile party money time weather ' +
  'season spring autumn summer winter birthday weekend colour color idea word sentence ' +
  'number part group side top story life state form example').split(' '));

function makeSentence(word, pos, source) {
  const k = word.toLowerCase();
  if (OVERRIDE[k]) return OVERRIDE[k];
  if (FILE_SENT[k]) return FILE_SENT[k];
  if (NO_SENTENCE_POS.has(pos)) return '';
  // 只给「手工整理的具象名词表」套模板；形容词/动词/抽象名词一律不生成
  if (source !== 'core-nouns' || pos !== 'noun') return '';
  if (ABSTRACT_NOUN.has(k)) return '';
  if (!nounTemplateOk(k)) return '';
  const pool = TPL.noun;
  const s = pool[hash(k) % pool.length].replace('___', k);
  return s.toLowerCase().includes(k) ? s : '';
}

/* ── 主流程 ── */
function main() {
  const legacy = read('g2-words.csv').concat(read('sample-words.csv')).map((r) => ({
    word: r.word.trim(),
    hint: (r.hint || '').trim(),
    sentence: (r.sentence || '').trim(),
    oxford_level: /^G[12]$/.test(r.oxford_level || '') ? r.oxford_level : 'G2',
    stage: 4,                 // 原有词库为内容词，按阅读阶梯近似归到 4
    source: 'legacy',
  }));

  const core = [];
  for (const f of ['data/core-sight.csv', 'data/core-nouns.csv', 'data/core-phonics.csv', 'data/core-extra.csv']) {
    for (const r of read(f)) {
      core.push({
        word: r.word.trim(),
        hint: (r.hint || '').trim(),
        sentence: '',
        oxford_level: ['1', '2'].includes(r.stage) ? 'G1' : 'G2',
        stage: Number(r.stage) || 3,
        pos: (r.pos || '').trim(),
        source: path.basename(f, '.csv'),
      });
    }
  }

  // 合并：原有词库优先（有真实例句），核心表补位
  const byWord = new Map();
  for (const r of legacy.concat(core)) {
    const k = r.word.toLowerCase();
    const prev = byWord.get(k);
    if (!prev) { byWord.set(k, r); continue; }
    // 保留更有价值的：有例句 > 无例句；同源时保留句子更长的
    const better = (r.sentence || '').length > (prev.sentence || '').length ? r : prev;
    const worse = better === r ? prev : r;
    byWord.set(k, {
      ...better,
      hint: better.hint || worse.hint,
      stage: better.stage || worse.stage,
      pos: better.pos || worse.pos,
    });
  }

  // 还原挖空句 + 剔除句子与词不匹配的（克漏字挖不到空 → 退化为中文提示填空）
  let restored = 0, unusable = 0;
  for (const r of byWord.values()) {
    if (r.sentence && /_{3,}/.test(r.sentence)) { r.sentence = restoreBlank(r.sentence, r.word); restored++; }
    if (r.sentence && !r.sentence.toLowerCase().includes(r.word.toLowerCase())) { r.sentence = ''; unusable++; }
  }

  // 补例句
  let generated = 0, skipped = 0;
  for (const r of byWord.values()) {
    if (!r.sentence) {
      const s = makeSentence(r.word, r.pos || 'noun', r.source);
      if (s) { r.sentence = s; generated++; } else skipped++;
    }
  }

  const all = [...byWord.values()];
  const byStage = all.reduce((a, r) => (a[r.stage] = (a[r.stage] || 0) + 1, a), {});
  const noSent = all.filter((r) => !r.sentence).length;

  console.log('=== 词库构建 ===');
  console.log(`  合并后唯一词     : ${all.length}`);
  console.log(`  原有词库         : ${legacy.length} 行（去重后计入）`);
  console.log(`  核心词表         : ${core.length} 行`);
  console.log(`  还原挖空句       : ${restored}`);
  console.log(`  句子不可用(剔除) : ${unusable}`);
  console.log(`  自动生成例句     : ${generated}  内联覆盖: ${Object.keys(OVERRIDE).length}  手写表: ${Object.keys(FILE_SENT).length}`);
  console.log(`  无例句（虚词）   : ${noSent}`);
  console.log(`  stage 分布       : ${Object.entries(byStage).sort().map(([k, v]) => 'S' + k + ':' + v).join('  ')}`);
  console.log(`  含 write/right   : ${all.filter((r) => ['write', 'right', 'read', 'light'].includes(r.word.toLowerCase())).map((r) => r.word).join(', ')}`);

  if (DRY) { console.log('\n(--dry 未写库)'); return; }

  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 加 stage 列（幂等）
  const cols = db.prepare('PRAGMA table_info(words)').all().map((c) => c.name);
  if (!cols.includes('stage')) db.exec('ALTER TABLE words ADD COLUMN stage INTEGER');
  if (!cols.includes('pos')) db.exec('ALTER TABLE words ADD COLUMN pos TEXT DEFAULT ""');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word_unique ON words(LOWER(word))');

  const before = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  const up = db.prepare(`
    INSERT INTO words (oxford_level, word, hint, sentence, stage, pos) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(LOWER(word)) DO UPDATE SET
      hint     = CASE WHEN LENGTH(excluded.hint)     > LENGTH(hint)     THEN excluded.hint     ELSE hint END,
      sentence = CASE WHEN LENGTH(excluded.sentence) > LENGTH(sentence) THEN excluded.sentence ELSE sentence END,
      stage    = COALESCE(stage, excluded.stage),
      pos      = CASE WHEN excluded.pos <> '' THEN excluded.pos ELSE pos END
  `);
  db.transaction((rows) => {
    for (const r of rows) up.run(r.oxford_level, r.word, r.hint || '', r.sentence || '', r.stage || null, r.pos || '');
  })(all);

  // 写一份合并后的 CSV，供 Pages 静态版复用
  const csvPath = path.join(ROOT, 'words-merged.csv');
  const esc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  fs.writeFileSync(csvPath,
    'word,oxford_level,hint,sentence,stage\n' +
    all.map((r) => [r.word, r.oxford_level, r.hint, r.sentence, r.stage].map(esc).join(',')).join('\n'),
    'utf8');

  const after = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  const dup = db.prepare('SELECT LOWER(word) w, COUNT(*) c FROM words GROUP BY LOWER(word) HAVING c > 1').all();
  const lv = db.prepare('SELECT oxford_level, COUNT(*) c FROM words GROUP BY oxford_level').all();
  console.log(`\n  数据库           : ${before} → ${after} 行`);
  console.log(`  重复词           : ${dup.length}${dup.length ? ' ⚠️ ' + JSON.stringify(dup) : ' ✅'}`);
  console.log(`  分级             : ${lv.map((l) => l.oxford_level + ':' + l.c).join('  ')}`);
  console.log(`  合并 CSV         : words-merged.csv`);
  db.close();
}

main();
