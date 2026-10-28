#!/usr/bin/env node
/**
 * shared/engine.js — 特训引擎的唯一实现
 *
 * 为什么有这个文件：
 *   之前 backend/practice.js 有一份引擎，build-pages.js 里又手工抄了一份，
 *   改了一边另一边不生效（"本地改了、线上没变"就是这么来的）。
 *   现在引擎只有这一份，两边都从这里取：
 *     - Node:    require('../shared/engine.js')
 *     - 浏览器:  build-pages.js 把这个文件原样内联进 <script>，得到 window.OWK
 *
 * 设计约束：
 *   - 本文件**不允许** require / import 任何东西，也不许碰数据库或 localStorage。
 *     所有外部数据通过 createEngine(env) 注入，这样同一份代码能在服务端和静态页跑。
 *   - env 需要提供三个方法：
 *       wordsInBank(level)   -> [{ word, hint, sentence, oxford_level }]
 *       weakPhonemes(player) -> [{ phoneme, grapheme, error_weight }]
 *       wordErrors(player)   -> { [word]: { e: 错误次数 } } 或 Map
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OWK = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ───────────────────────── 常量 ───────────────────────── */

  const SYLLABLE_OVERRIDES = {
    // 常见不规则词：算法会数错的，显式纠正（值 = 音节切分）
    orange: ['or', 'ange'], every: ['ev', 'ery'],
    everything: ['ev', 'ery', 'thing'], everyone: ['ev', 'ery', 'one'],
    everybody: ['ev', 'ery', 'bod', 'y'], somewhere: ['some', 'where'], interesting: ['in', 'ter', 'est', 'ing'],
    chocolate: ['choc', 'o', 'late'], family: ['fam', 'i', 'ly'], animal: ['an', 'i', 'mal'],
    camera: ['cam', 'er', 'a'], vegetable: ['veg', 'e', 'ta', 'ble'], favourite: ['fa', 'vour', 'ite'],
    favorite: ['fa', 'vor', 'ite'], beautiful: ['beau', 'ti', 'ful'], business: ['busi', 'ness'],
    people: ['peo', 'ple'], water: ['wa', 'ter'], fire: ['fire'], hour: ['hour'], our: ['our'],
    science: ['sci', 'ence'], quiet: ['qui', 'et'], lion: ['li', 'on'], poem: ['po', 'em'],
    area: ['ar', 'e', 'a'], idea: ['i', 'de', 'a'], real: ['re', 'al'], being: ['be', 'ing'],
    comfortable: ['comf', 'ta', 'ble'],
    flower: ['flow', 'er'], power: ['pow', 'er'], tower: ['tow', 'er'], shower: ['show', 'er'],
  };

  const CHARACTERS = {
    biff:   { label: 'Biff',   emoji: '👧🏻', pet: false },
    chip:   { label: 'Chip',   emoji: '🧒🏻', pet: false },
    kipper: { label: 'Kipper', emoji: '👦🏻', pet: false },
    wilma:  { label: 'Wilma',  emoji: '👧🏽', pet: false },
    floppy: { label: 'Floppy', emoji: '🐶',  pet: true },
  };
  const ALL_NAMES = ['biff', 'chip', 'kipper', 'wilma', 'floppy', 'wilf', 'gran', 'mum', 'dad', 'nadim', 'anneena'];

  const VOWELS = 'aeiouy';
  const isVowel = (c) => VOWELS.includes(c);

  /* ───────────────────────── 拼读规则表 ───────────────────────── */

  const PHONEME_PATTERNS = [
    { phoneme: '/aɪ/', grapheme: 'igh', articulation: '嘴张开滑动到 /i/，像 "I"', example: 'night', kind: 'vowel' },
    { phoneme: '/iː/', grapheme: 'ee', articulation: '嘴角向两边拉平，长音', example: 'see', kind: 'vowel' },
    { phoneme: '/iː/', grapheme: 'ea', articulation: '嘴角向两边拉平，长音', example: 'tea', kind: 'vowel' },
    { phoneme: '/uː/', grapheme: 'oo', articulation: '嘴唇收圆前突', example: 'moon', kind: 'vowel' },
    { phoneme: '/eɪ/', grapheme: 'ai', articulation: '从 /e/ 滑到 /ɪ/，双元音', example: 'rain', kind: 'vowel' },
    { phoneme: '/eɪ/', grapheme: 'ay', articulation: '同 ai，词尾常见', example: 'play', kind: 'vowel' },
    { phoneme: '/əʊ/', grapheme: 'oa', articulation: '从 /ə/ 滑到 /ʊ/', example: 'boat', kind: 'vowel' },
    { phoneme: '/aʊ/', grapheme: 'ou', articulation: '从 /a/ 滑到 /ʊ/', example: 'house', kind: 'vowel' },
    { phoneme: '/aʊ/', grapheme: 'ow', articulation: '同 ou', example: 'cow', kind: 'vowel' },
    { phoneme: '/ɔɪ/', grapheme: 'oi', articulation: '从 /ɔ/ 滑到 /ɪ/', example: 'coin', kind: 'vowel' },
    { phoneme: '/ɔɪ/', grapheme: 'oy', articulation: '同 oi，词尾常见', example: 'boy', kind: 'vowel' },
    { phoneme: '/ɑː/', grapheme: 'ar', articulation: '嘴张大，舌后缩', example: 'car', kind: 'vowel' },
    { phoneme: '/ɔː/', grapheme: 'or', articulation: '圆唇，舌后缩', example: 'fork', kind: 'vowel' },
    { phoneme: '/ɜː/', grapheme: 'er', articulation: '中央元音，舌平放', example: 'her', kind: 'vowel' },
    { phoneme: '/ɜː/', grapheme: 'ir', articulation: '同 er', example: 'bird', kind: 'vowel' },
    { phoneme: '/ɜː/', grapheme: 'ur', articulation: '同 er', example: 'turn', kind: 'vowel' },
    { phoneme: '/ʃ/', grapheme: 'sh', articulation: '嘴唇微前突，气流摩擦，不振动声带', example: 'ship', kind: 'consonant' },
    { phoneme: '/tʃ/', grapheme: 'ch', articulation: '先堵住再释放，像打喷嚏前一刻', example: 'chip', kind: 'consonant' },
    { phoneme: '/θ/', grapheme: 'th', articulation: '舌尖轻放上下齿之间，送气', example: 'think', kind: 'consonant' },
    { phoneme: '/ŋ/', grapheme: 'ng', articulation: '舌根抵住软腭，鼻音', example: 'king', kind: 'consonant' },
    { phoneme: '/f/', grapheme: 'ph', articulation: '上齿轻咬下唇送气', example: 'phone', kind: 'consonant' },
    { phoneme: '/dʒ/', grapheme: 'j', articulation: '同 ch 但声带振动', example: 'jump', kind: 'consonant' },
    { phoneme: '/r/', grapheme: 'r', articulation: '舌尖卷起但不碰上颚', example: 'red', kind: 'consonant' },
    { phoneme: '/l/', grapheme: 'l', articulation: '舌尖抵上齿龈，气流从两侧出', example: 'leg', kind: 'consonant' },
    { phoneme: '/v/', grapheme: 'v', articulation: '上齿咬下唇，声带振动', example: 'van', kind: 'consonant' },
    { phoneme: '/w/', grapheme: 'w', articulation: '双唇收圆再放开', example: 'wet', kind: 'consonant' },
  ];

  const MINIMAL_PAIRS = [
    { a: 'ship', b: 'sheep', pa: '/ɪ/', pb: '/iː/', zh_a: '船', zh_b: '羊', tip: '短音 vs 长音' },
    { a: 'ship', b: 'chip', pa: '/ʃ/', pb: '/tʃ/', zh_a: '船', zh_b: '薯条', tip: '摩擦音 vs 破擦音' },
    { a: 'think', b: 'sink', pa: '/θ/', pb: '/s/', zh_a: '想', zh_b: '水槽', tip: '咬舌 vs 不咬舌' },
    { a: 'three', b: 'tree', pa: '/θ/', pb: '/t/', zh_a: '三', zh_b: '树', tip: '咬舌 vs 不咬舌' },
    { a: 'rice', b: 'lice', pa: '/r/', pb: '/l/', zh_a: '米饭', zh_b: '虱子', tip: '卷舌 vs 舌尖抵齿龈' },
    { a: 'right', b: 'light', pa: '/r/', pb: '/l/', zh_a: '右边', zh_b: '光', tip: '卷舌 vs 舌尖抵齿龈' },
    { a: 'red', b: 'led', pa: '/r/', pb: '/l/', zh_a: '红色', zh_b: '带领(过去式)', tip: '卷舌 vs 舌尖抵齿龈' },
    { a: 'vet', b: 'wet', pa: '/v/', pb: '/w/', zh_a: '兽医', zh_b: '湿的', tip: '咬唇 vs 圆唇' },
    { a: 'fan', b: 'van', pa: '/f/', pb: '/v/', zh_a: '风扇', zh_b: '货车', tip: '清音 vs 浊音' },
    { a: 'pin', b: 'pen', pa: '/ɪ/', pb: '/e/', zh_a: '别针', zh_b: '钢笔', tip: '短 i vs 短 e' },
    { a: 'bat', b: 'bet', pa: '/æ/', pb: '/e/', zh_a: '球棒', zh_b: '打赌', tip: '嘴张更大 vs 更小' },
    { a: 'coat', b: 'goat', pa: '/k/', pb: '/g/', zh_a: '外套', zh_b: '山羊', tip: '清音 vs 浊音' },
    // /aɪ/ 专项：IGH 最容易和 /eɪ/、/e/ 混
    { a: 'white', b: 'wait',  pa: '/aɪ/', pb: '/eɪ/', zh_a: '白色', zh_b: '等待', tip: '/aɪ/ 滑到 /ɪ/，/eɪ/ 滑到 /ɪ/ 但起点不同，wh-i-te 不要读成 wait' },
    { a: 'light', b: 'late',  pa: '/aɪ/', pb: '/eɪ/', zh_a: '光', zh_b: '晚的', tip: 'igh 读 /aɪ/，a_e 读 /eɪ/' },
    { a: 'sight', b: 'seat',  pa: '/aɪ/', pb: '/iː/', zh_a: '视力', zh_b: '座位', tip: 'igh 是双元音 /aɪ/，ea 是长音 /iː/' },
    { a: 'high',  b: 'hay',   pa: '/aɪ/', pb: '/eɪ/', zh_a: '高的', zh_b: '干草', tip: 'gh 不发音，high 只读 /haɪ/' },
    { a: 'night', b: 'net',   pa: '/aɪ/', pb: '/e/',  zh_a: '夜晚', zh_b: '网', tip: 'igh 拉长成双元音，e 是短音' },
  ];

  /* ─────────── /aɪ/ 重点音 ───────────
   * 用户要求把 IGH 这个音在自然拼读题里加权。
   * /aɪ/ 在英语里由四条拼写路径实现，只盯 igh 会漏掉 write / bike 这类：
   *   igh  → night / light / high
   *   i_e  → write / white / kite
   *   y 结尾 → my / fly / sky
   *   i 开音节 → hi
   * 注意 eight / weigh 虽然含 igh 但读 /eɪ/，必须排除。
   */
  const AI_END_Y = ['my', 'by', 'fly', 'sky', 'try', 'cry', 'dry', 'why', 'shy', 'spy', 'hi'];
  const AI_EXCLUDE = /^(eight|eighth|weight|weigh|neighbour|neighbor|height)$/;
  function isAISound(word) {
    const w = norm(word);
    if (!w || AI_EXCLUDE.test(w)) return false;
    if (w.includes('igh')) return true;
    if (/^[a-z]*i[a-z]e$/.test(w)) return true;      // i_e
    if (AI_END_Y.includes(w)) return true;
    return false;
  }
  /* ─────────── 用户指定的高频词 ───────────
   * 这 11 个词在闯关和特训里都要提高出现率。
   * 主游戏（backend/pick.js）与特训（本文件）共用同一份名单，避免两边不一致。
   * 系数各自不同是因为两边的分数量纲不同，不是笔误。
   */
  const FOCUS_WORDS = new Set([
    'show', 'last', 'even', 'left', 'pass', 'eye', 'should', 'shall', 'would', 'wrong', 'try',
  ]);

  /** 音素加权表：数值 = 相对权重倍数，1 = 不加权 */
  const PHONEME_BOOST = { '/aɪ/': 3.4 };   // 规则得分额外 +（3.4-1）×4.2 ≈ +10

  /** 可能混淆的拼写组合（用于干扰项，逼孩子真的分辨音而不是猜形） */
  const CONFUSABLE_GRAPHEMES = {
    igh: ['ai', 'ay', 'ee', 'ea', 'oo'],
    'i_e': ['igh', 'ai', 'ay', 'ee', 'ea'],
  };


  /* ─────────── 标点填空（句末 + 句中） ───────────
   * 设计原则：每个空的正确答案必须**唯一**。
   * 英语里 "." 和 "!" 经常都说得通，所以每条都带明确线索：
   *   疑问 → asked / what / where / why
   *   感叹 → What a… / How… / shouted
   *   冒号 → 后面紧跟列举
   *   引号 → 有 said / asked + 引述内容
   * 干扰项只放"看起来可能对、实际不合适"的标点。
   */
  const PUNCT_BANK = [
    // 句末：问号
    { s: '"Where is my key{}" asked Biff.',       mark: '?', options: ['?', '.', '!'],   tip: '疑问句用问号' },
    { s: '"What is in the box{}" asked Chip.',    mark: '?', options: ['?', '.', ','],   tip: '直接提问用问号' },
    { s: '"Can you help me{}" said Kipper.',      mark: '?', options: ['?', '!', '.'],   tip: 'Can 开头的疑问句' },
    { s: '"Why did the dog run away{}" asked Wilma.', mark: '?', options: ['?', '.', ':'], tip: 'Why 提问用问号' },
    { s: '"Who is at the door{}" asked Mum.',     mark: '?', options: ['?', '.', '!'],   tip: 'Who 提问用问号' },
    // 句末：感叹号
    { s: '"What a big dog{}" said Chip.',         mark: '!', options: ['!', '.', '?'],   tip: 'What a… 是感叹句' },
    { s: '"How fast you run{}" said Biff.',       mark: '!', options: ['!', '.', ','],   tip: 'How… 是感叹句' },
    { s: '"Look out{}" shouted Wilma.',           mark: '!', options: ['!', '.', '?'],   tip: 'shouted + 提醒，用感叹号' },
    { s: '"Stop{}" shouted the guard.',           mark: '!', options: ['!', '.', ','],   tip: '命令 + shouted' },
    // 句末：句号
    { s: 'These are my books{}',                  mark: '.', options: ['.', '?', '!'],   tip: '陈述一件事用句号' },
    { s: 'The key was under the mat{}',           mark: '.', options: ['.', '?', ':'],   tip: '陈述句用句号' },
    { s: 'Floppy slept by the fire all night{}',  mark: '.', options: ['.', '!', '?'],   tip: '陈述句用句号' },
    // 句中：逗号
    { s: 'Biff bought a map{} a rope and a torch.', mark: ',', options: [',', '.', ':'], tip: '列举中间用逗号' },
    { s: 'First we ran{} then we hid.',            mark: ',', options: [',', '.', ';'],  tip: '两个短句之间用逗号' },
    { s: 'Chip{} Kipper and Wilma went outside.',  mark: ',', options: [',', '.', ':'],  tip: '并列人名用逗号隔开' },
    // 句中：冒号（引出列举）
    { s: 'She had three things{} a map, a rope and a torch.', mark: ':', options: [':', ',', '.'], tip: '冒号后面引出列举' },
    { s: 'We need two things{} water and food.',   mark: ':', options: [':', ',', ';'],  tip: '冒号引出要说明的内容' },
    // 引号
    { s: 'Biff said, {}Come here!{}',              mark: '"', options: ['"', "'", '('],   tip: '人物说的话要用双引号' },
    { s: '{}Look at that{} said Chip.',            mark: '"', options: ['"', "'", ')'],   tip: '引述原话用双引号' },
    // 撇号
    { s: 'Biff{}s bag is on the table.',           mark: "'", options: ["'", '"', ','],   tip: '表示"某人的"要用撇号' },
    { s: 'Kipper can{}t find his sock.',           mark: "'", options: ["'", '"', '-'],   tip: 'can not 缩写成 can\'t，用撇号' },
    { s: 'It{}s time to go home.',                 mark: "'", options: ["'", '"', '.'],   tip: 'it is 缩写成 it\'s' },
    // 分号（较难，少量）
    { s: 'It was cold{} we went inside.',          mark: ';', options: [';', ',', ':'],   tip: '两个完整句子相连用分号' },
    { s: 'Biff ran fast{} she still missed the bus.', mark: ';', options: [';', '.', ','], tip: '分号连接两个完整句子' },
  ];

  const SIGHT_WORDS = [
    ['the', 1, '这个'], ['and', 2, '和'], ['you', 3, '你'], ['that', 4, '那个'], ['was', 5, '是(过去)'],
    ['for', 6, '为了'], ['are', 7, '是'], ['with', 8, '和…一起'], ['they', 9, '他们'], ['have', 10, '有'],
    ['this', 11, '这个'], ['from', 12, '从'], ['one', 13, '一'], ['had', 14, '有(过去)'], ['word', 15, '单词'],
    ['what', 16, '什么'], ['were', 17, '是(过去)'], ['when', 18, '什么时候'], ['your', 19, '你的'], ['said', 20, '说(过去)'],
    ['there', 21, '那里'], ['each', 22, '每个'], ['which', 23, '哪一个'], ['she', 24, '她'], ['how', 25, '怎样'],
    ['their', 26, '他们的'], ['will', 27, '将要'], ['other', 28, '其他的'], ['about', 29, '关于'], ['many', 30, '许多'],
    ['then', 31, '然后'], ['them', 32, '他们(宾)'], ['these', 33, '这些'], ['some', 34, '一些'], ['would', 35, '将会'],
    ['make', 36, '制作'], ['like', 37, '喜欢'], ['him', 38, '他(宾)'], ['into', 39, '进入'], ['time', 40, '时间'],
  ];

  /* ───────────────────────── 纯函数 ───────────────────────── */

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

  /** 句子里出现了哪些牛津树人物（小写数组） */
  function charactersIn(text) {
    const s = String(text || '').toLowerCase();
    const out = [];
    for (const n of ALL_NAMES) if (new RegExp('\\b' + n + '\\b').test(s) && !out.includes(n)) out.push(n);
    return out;
  }
  const characterLabel = (c) => (CHARACTERS[c] || {}).label || '';

  /** 把单词切成音节数组。算法与判定同源，保证"显示=判定"。 */
  function syllabify(word) {
    const raw = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!raw) return [String(word || '')];
    if (SYLLABLE_OVERRIDES[raw]) return SYLLABLE_OVERRIDES[raw].slice();
    if (raw.length <= 3) return [raw];
    if (raw.length <= 4 && /[^aeiouy]y$/.test(raw)) return [raw];

    let w = raw;
    if (w.endsWith('e') && !/([aeiouy])e$/.test(w)) {
      const beforeE = w[w.length - 2];
      const isConsLe = w.endsWith('le') && beforeE !== 'e' && !isVowel(w[w.length - 3] || '');
      if (!isConsLe) w = w.slice(0, -1);
    }

    const groups = [];
    let start = -1;
    for (let i = 0; i < w.length; i++) {
      if (isVowel(w[i])) { if (start < 0) start = i; }
      else if (start >= 0) { groups.push([start, i - 1]); start = -1; }
    }
    if (start >= 0) groups.push([start, w.length - 1]);
    if (groups.length <= 1) return [raw];

    const cuts = [];
    for (let g = 0; g < groups.length - 1; g++) {
      const endV = groups[g][1];
      const startNext = groups[g + 1][0];
      const cluster = startNext - endV - 1;
      cuts.push(cluster === 0 ? startNext : endV + 1 + Math.floor(cluster / 2));
    }

    const parts = [];
    let prev = 0;
    cuts.forEach((c) => { parts.push(raw.slice(prev, c)); prev = c; });
    parts.push(raw.slice(prev));
    return parts.filter(Boolean);
  }
  const syllableCount = (word) => syllabify(word).length;

  /** 该词命中的可教学音素（拼写模式匹配） */
  function phonemesOf(word) {
    const w = norm(word);
    const out = [];
    for (const p of PHONEME_PATTERNS) {
      if (w.includes(p.grapheme)) {
        if (!out.some((o) => o.phoneme === p.phoneme && o.grapheme === p.grapheme)) out.push(p);
      }
    }
    return out;
  }

  /**
   * 全池加权抽样。
   * 不能写成"先排序再只在前 K 个里抽"——那样 903 词的库实际只剩 4~5 个候选，
   * 是相邻两轮大量重复的根因。
   */
  function weightedPick(arr, weightOf) {
    if (!arr || !arr.length) return null;
    const ws = arr.map((x) => Math.max(1e-6, Number(weightOf(x)) || 0));
    const total = ws.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return arr[Math.floor(Math.random() * arr.length)];
    let r = Math.random() * total;
    for (let i = 0; i < arr.length; i++) { r -= ws[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }

  /** 取一张卡"考的是哪个词"：音节/视觉词用 word，音素/拼读用 correct / audio_text */
  function cardWord(c) {
    return String((c && (c.word || c.correct || c.audio_text)) || '').trim().toLowerCase();
  }

  /* ───────────────────────── 引擎 ───────────────────────── */

  /**
   * @param {object} env
   * @param {(level:string)=>Array} env.wordsInBank
   * @param {(player:string)=>Array} env.weakPhonemes
   * @param {(player:string)=>object} env.wordErrors  word -> { e }
   */
  function createEngine(env) {
    const E = env || {};
    const wordsInBank = E.wordsInBank || (() => []);
    const weakPhonemes = E.weakPhonemes || (() => []);
    const wordErrors = E.wordErrors || (() => ({}));
    const priorityWeight = E.priorityWeight || (() => 0);   // 人工权重 ★1–5，0 = 无

    function errOf(player, word) {
      const m = wordErrors(player) || {};
      const v = m instanceof Map ? m.get(word) : m[word];
      if (v == null) return 0;
      return Number(v.e != null ? v.e : v) || 0;
    }

    /* 1. 音节计数 */
    function makeSyllableCard(player, level, character) {
      /*
       * /aɪ/ 专项要跨级别：
       * write / high / light / right 这些都在 G1，只取当前级别的话，
       * 无论权重加多高都不会出现。所以把全库的 /aɪ/ 词并进候选池。
       */
      const base = wordsInBank(level).filter((r) => /^[a-z]{3,}$/i.test(String(r.word).trim()));
      /* /aɪ/ 词和用户指定高频词大多在 G1，必须跨级并入，否则加权无效 */
      const aiExtra = wordsInBank('')
        .filter((r) => /^[a-z]{3,}$/i.test(String(r.word).trim()))
        .filter((r) => isAISound(r.word) || FOCUS_WORDS.has(String(r.word).toLowerCase()));
      const seenW = new Set(base.map((r) => String(r.word).toLowerCase()));
      const bank = base.concat(aiExtra.filter((r) => !seenW.has(String(r.word).toLowerCase())));
      if (!bank.length) return null;
      const weak = weakPhonemes(player) || [];
      const weakSet = new Set(weak.map((w) => w.grapheme).filter(Boolean));

      const scored = bank.map((r) => {
        const ph = phonemesOf(r.word);
        const hit = ph.filter((p) => weakSet.has(p.grapheme)).length;
        const syl = syllableCount(r.word);
        const aiBoost = isAISound(r.word) ? 6.0 : 0;      // /aɪ/ 专项加权
        const focusBoost = FOCUS_WORDS.has(String(r.word).toLowerCase()) ? 6.0 : 0;
        return { row: r, score: 1 + syl * 0.8 + hit * 1.5 + aiBoost + focusBoost + priorityWeight(r.word) * 1.6 + Math.random() * 0.8, syl, ph };
      });

      const pick = weightedPick(scored, (x) => x.score);
      const n = pick.syl;
      const opts = [];
      if (n > 1) opts.push(n - 1);
      opts.push(n + 1);
      if (n > 2 && Math.random() < 0.5) opts.push(n - 2);
      const options = [...new Set([...opts, n])].sort((a, b) => a - b);

      const parts = syllabify(pick.row.word);
      return {
        card_type: 'SYLLABLE_COUNTING',
        word: pick.row.word,
        hint: pick.row.hint,
        speaker: CHARACTERS[character] || null,
        prompt: (characterLabel(character) ? characterLabel(character) + ' 想考考你：' : '') + '这个词有几个音节？拍着手读一读',
        options,
        correct: n,
        focus: 'syllable',
        reveal: {
          syllables: parts,
          display: parts.join(' · '),
          tip: n >= 3 ? '长单词可以分段读，先读第一部分再读第二部分。' : '每个元音组通常就是一个音节。',
        },
        meta: { oxford_level: pick.row.oxford_level, graphemes: pick.ph.map((p) => p.grapheme) },
      };
    }

    /* 2. 音素辨析（最小对立对） */
    function makePhonemeCard(player, level) {
      const bank = new Set(wordsInBank(level).map((r) => norm(r.word)));
      const weak = weakPhonemes(player) || [];
      const weakMap = new Map(weak.map((w) => [w.phoneme, w.error_weight]));

      const scored = MINIMAL_PAIRS.map((p) => {
        const weight = Math.max(weakMap.get(p.pa) || 0, weakMap.get(p.pb) || 0);
        const inBank = (bank.has(norm(p.a)) ? 1 : 0) + (bank.has(norm(p.b)) ? 1 : 0);
        // /aɪ/ 对立对加权
        const aiPair = (p.pa === '/aɪ/' || p.pb === '/aɪ/') ? 2.4 : 0;
        return { p, score: 1 + weight * 2 + inBank * 0.6 + aiPair + Math.random() * 0.7 };
      });

      const { p } = weightedPick(scored, (x) => x.score);
      const targetIsA = Math.random() < 0.5;
      const target = targetIsA ? p.a : p.b;
      return {
        card_type: 'PHONEME_DISCRIMINATION',
        audio_text: target,
        prompt: '听一听，选出你听到的词',
        options: [p.a, p.b],
        correct: target,
        focus: targetIsA ? p.pa : p.pb,
        reveal: {
          pair: [p.a, p.b],
          phonemes: [p.pa, p.pb],
          meanings: [p.zh_a, p.zh_b],
          tip: p.tip,
          target,
        },
        meta: {
          phoneme_a: p.pa, phoneme_b: p.pb,
          graphemes: PHONEME_PATTERNS.filter((x) => x.phoneme === (targetIsA ? p.pa : p.pb)).map((x) => x.grapheme),
        },
      };
    }

    /* 3. 拼读规则（语境选词） */
    function makePhonicsCard(player, level, character) {
      const all = wordsInBank(level).filter((r) => r.sentence);
      if (!all.length) return makeSyllableCard(player, level, character);
      let bank = character
        ? all.filter((r) => {
            const cs = charactersIn(r.sentence);
            return cs.length === 0 || cs.includes(character);
          })
        : all;
      if (bank.length < 4) bank = all;
      const isOwnLine = (r) => !!character && charactersIn(r.sentence).includes(character);
      const weak = weakPhonemes(player) || [];
      const weakMap = new Map(weak.map((w) => [w.phoneme, w.error_weight]));

      const candidates = [];
      for (const p of PHONEME_PATTERNS) {
        if (p.grapheme.length < 2) continue;
        const hits = bank.filter((r) => norm(r.word).includes(p.grapheme));
        if (hits.length >= 2) candidates.push({ p, hits });
      }
      if (!candidates.length) return makeSyllableCard(player, level, character);

      const ownCount = (hits) => hits.filter(isOwnLine).length;
      const scored = candidates.map((c) => ({
        ...c,
        score: 1 + (weakMap.get(c.p.phoneme) || 0) * 2 + Math.min(c.hits.length, 6) * 0.3
               + ownCount(c.hits) * 3.0
               + ((PHONEME_BOOST[c.p.phoneme] || 1) - 1) * 4.2   // /aɪ/ 规则加权
               + Math.random() * 0.8,
      }));

      /*
       * IGH 专项：光靠得分加权会被 26 条规则稀释（实测只到 13%）。
       * 改成按概率直接指定规则——目标是把 igh 稳定拉到 ~40%，
       * 同时留 60% 给其他规则，不至于变成单一题型。
       */
      const ighRule = candidates.find((c) => c.p.grapheme === 'igh');
      const FORCE_IGH_RATE = 0.30;
      const chosen = (ighRule && Math.random() < FORCE_IGH_RATE)
        ? ighRule
        : weightedPick(scored, (x) => x.score);

      /*
       * IGH 专项要跨级别取词：G2 里带例句的 igh 词只有 night / frighten / lightning，
       * right、high、light、bright、tonight 全在 G1。不跨级的话专项题永远是那两三个词。
       * 其他规则仍只在当前级别内取，避免打乱分级难度。
       */
      let hits = chosen.hits;
      if (chosen.p.grapheme === 'igh') {
        const full = wordsInBank('').filter((r) => r.sentence)
          .filter((r) => {
            const cs = charactersIn(r.sentence);
            return cs.length === 0 || cs.includes(character);
          });
        const wide = full.filter((r) => norm(r.word).includes('igh'));
        if (wide.length >= 2) hits = wide;
      }

      const ownHits = hits.filter(isOwnLine);
      const preferred = ownHits.length ? ownHits : hits;
      const hitsSingle = preferred.filter((r) => /^[a-z]+$/i.test(String(r.word).trim()));
      const poolSingle = bank.filter((r) => /^[a-z]+$/i.test(String(r.word).trim()));
      const usePool = hitsSingle.length >= 2 ? hitsSingle : (preferred.length ? preferred : poolSingle);
      const targetRow = weightedPick(usePool, (r) => 1 + priorityWeight(r.word) * 1.6
        + (FOCUS_WORDS.has(String(r.word).toLowerCase()) ? 6.0 : 0));
      const target = targetRow.word;
      const sameRule = usePool.filter((r) => norm(r.word) !== norm(target)).slice(0, 2);

      /*
       * 干扰项：优先选「词性不同」的词。
       * 之前随便挑一个不含目标字母组合的词，会出现 "I can see the _____" 里
       * mirror（名词）和 airport（名词）都成立的情况——句子本身区分不了。
       * 词性不同至少能排除一部分语法上同样成立的干扰项；真正消歧靠前端展示中文释义。
       */
      const tPos = String(targetRow.pos || '').toLowerCase();
      const decoys = (() => {
        const notSameRule = poolSingle.filter((r) => !norm(r.word).includes(chosen.p.grapheme)
          && norm(r.word) !== norm(target));
        // 先找"听起来像"的拼写组合（igh ↔ ai/ay/ee/ea/oo），逼孩子真的分辨音
        const conf = CONFUSABLE_GRAPHEMES[chosen.p.grapheme] || [];
        const confusable = conf.length
          ? notSameRule.filter((r) => conf.some((g) => norm(r.word).includes(g)))
          : [];
        if (confusable.length) return confusable.slice(0, 1);
        const diffPos = tPos ? notSameRule.filter((r) => String(r.pos || '').toLowerCase() && String(r.pos).toLowerCase() !== tPos) : [];
        return (diffPos.length ? diffPos : notSameRule).slice(0, 1);
      })();

      let options = [target, ...sameRule.map((r) => r.word), ...decoys.map((r) => r.word)];
      options = [...new Set(options)];
      while (options.length < 3 && bank.length > options.length) {
        const extra = bank[Math.floor(Math.random() * bank.length)].word;
        if (!options.includes(extra)) options.push(extra);
      }
      options.sort(() => Math.random() - 0.5);

      const blanked = targetRow.sentence.replace(
        new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        '_____'
      );

      return {
        card_type: 'PHONICS_CONTEXT_MATCH',
        speaker: CHARACTERS[character] || null,
        speaker_is_own_line: isOwnLine(targetRow),
        prompt: (characterLabel(character) && isOwnLine(targetRow))
          ? characterLabel(character) + ' 说的这句话缺了一个词'
          : '这句话里的空格应该填哪个词？',
        sentence: blanked.includes('_____') ? blanked : `${blanked} ( _____ )`,
        hint: targetRow.hint,
        options,
        correct: target,
        focus: chosen.p.grapheme,
        reveal: {
          grapheme: chosen.p.grapheme,
          phoneme: chosen.p.phoneme,
          articulation: chosen.p.articulation,
          family: usePool.map((r) => r.word).slice(0, 6),
          tip: `字母组合 ${chosen.p.grapheme} 通常发 ${chosen.p.phoneme}`,
        },
        meta: { rule: chosen.p.grapheme },
      };
    }

    /* 4. 视觉词闪卡 */
    function makeSightWordCard(player) {
      // 全池加权：错过的词权重高，高频词（rank 小）略高，其余均匀
      const pool = SIGHT_WORDS.map(([word, rank, zh]) => ({ word, rank, zh, err: errOf(player, word) }));
      const target = weightedPick(pool, (x) => 1 + x.err * 6 + 6 / Math.max(1, x.rank) + priorityWeight(x.word) * 1.6);

      const others = SIGHT_WORDS.filter(([w]) => w !== target.word)
        .sort(() => Math.random() - 0.5).slice(0, 3).map(([, , zh]) => zh);
      const options = [target.zh, ...others].sort(() => Math.random() - 0.5);

      return {
        card_type: 'SIGHT_WORD_FLASH',
        word: target.word,
        prompt: '闪现！快选它的意思',
        flash_ms: 800,
        options,
        correct: target.zh,
        focus: `sight:${target.word}`,
        reveal: { word: target.word, zh: target.zh, rank: target.rank, tip: '高频词靠"整体认读"，不用逐字母拼。' },
        meta: { frequency_rank: target.rank },
      };
    }

    /* 5. 标点填空（句末 + 句中） */
    function makePunctuationCard(player, level) {
      const item = weightedPick(PUNCT_BANK, () => 1);
      if (!item) return null;
      const shown = item.s.replace(/\{\}/g, '_____');
      const full = item.s.replace(/\{\}/g, item.mark);
      return {
        card_type: 'PUNCTUATION_MARK',
        word: item.mark,                       // 供 cardWord 去重（同轮不重复同一标点）
        sentence: shown,
        prompt: '空格里应该填哪个标点？',
        options: item.options.slice().sort(() => Math.random() - 0.5),
        correct: item.mark,
        focus: 'punct:' + item.mark,
        reveal: {
          mark: item.mark,
          tip: item.tip,
          full,
        },
        meta: { mark: item.mark },
      };
    }

    /* 出题入口 */
    function nextTask({ player, level = 'G1', type, character, exclude } = {}) {
      const p = player || 'guest';
      const TYPES = ['syllable', 'phoneme', 'phonics', 'sight', 'punctuation'];
      const T = type && TYPES.includes(type)
        ? type
        : TYPES[Math.floor(Math.random() * TYPES.length)];

      // 本轮已考过的词：跨题型也要排除（同一个词换个题型不能再出现）
      const skip = new Set(
        String(exclude || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
      );

      const gen = () => {
        let c = null;
        if (T === 'syllable') c = makeSyllableCard(p, level, character);
        else if (T === 'phoneme') c = makePhonemeCard(p, level);
        else if (T === 'phonics') c = makePhonicsCard(p, level, character);
        else if (T === 'punctuation') c = makePunctuationCard(p, level);
        else c = makeSightWordCard(p, level);
        if (!c) c = makeSyllableCard(p, level, character) || makePhonemeCard(p, level);
        return c;
      };

      let card = gen();
      if (card && skip.size) {
        for (let i = 0; i < 14 && skip.has(cardWord(card)); i++) {
          const nx = gen();
          if (!nx) break;
          card = nx;
        }
      }
      if (!card) return { error: 'NO_TASK', message: '字库为空，请先导入 CSV 字库' };

      return {
        id: `${T}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        player: p,
        level,
        ...card,
      };
    }

    return {
      nextTask, makeSyllableCard, makePhonemeCard, makePhonicsCard, makeSightWordCard, makePunctuationCard,
      cardWord, errOf,
    };
  }

  return {
    createEngine,
    // 常量与纯函数同时导出，服务端（answer/profile/recommend）和构建脚本都要用
    SYLLABLE_OVERRIDES, CHARACTERS, ALL_NAMES, PHONEME_PATTERNS, MINIMAL_PAIRS, SIGHT_WORDS, PUNCT_BANK,
    charactersIn, characterLabel, syllabify, syllableCount, phonemesOf, weightedPick, cardWord, norm,
    isAISound, PHONEME_BOOST, CONFUSABLE_GRAPHEMES, FOCUS_WORDS,
  };
});
