/**
 * agent.js — 两个 Agent 的工程实现
 *
 *  Spec A  牛津树语境脚手架生成器（Context-Aware Scaffolding）
 *  Spec C  HITL 审核证据溯源与动态边生成器（Evidence Grounding）
 *
 * ── 与原始 Spec 的两处偏离（必须有话直说）──────────────────────────
 *  1. Spec 假设用 ChromaDB 做稠密向量检索。本项目无向量库、无 embedding 依赖，
 *     改用**确定性打分检索**：目标词命中 > 共享拼读组合 > 同角色 > 同首字母 > stage 接近。
 *     结果可复现、零外部依赖；将来接向量库只需替换 retrieve() 内部实现。
 *  2. Spec 假设存在「真实牛津树绘本语料」。本项目的 corpus 由既有词库的句子种子化而来，
 *     其中多数是工程生成的示范句，**不是 ORT 原文**。source 字段如实标注：
 *     seed(既有词库) / agent(Agent 提案) / imported(人工导入的真实语料)。
 *     要变成真 ORT 语料，走 HITL 导入通道，不要改这个模块。
 */

const STAGE_MIN = 1;
const STAGE_MAX = 7;

module.exports = function createAgent(db, practice) {
  /* ───────────────────────── schema ───────────────────────── */
  db.exec(`
    CREATE TABLE IF NOT EXISTS corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentence TEXT NOT NULL,
      word TEXT NOT NULL,
      oxford_stage INTEGER DEFAULT 3,
      character TEXT DEFAULT '',
      source TEXT DEFAULT 'seed',
      status TEXT DEFAULT 'approved',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_corpus_word ON corpus(LOWER(word));
    CREATE INDEX IF NOT EXISTS idx_corpus_stage ON corpus(oxford_stage);
    CREATE INDEX IF NOT EXISTS idx_corpus_char ON corpus(character);

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      confidence REAL DEFAULT 0,
      evidence TEXT DEFAULT '[]',
      reason TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      reviewed_at TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS phoneme_edge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      edge_type TEXT DEFAULT 'CONFUSED_WITH',
      confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'approved',
      proposal_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_edge_pair ON phoneme_edge(source, target, edge_type);
  `);

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z' ]/g, '');
  const wordsOf = (s) => norm(s).split(/\s+/).filter(Boolean);

  /* 词库全集：用于"严格词表"守卫 */
  let bankWords = new Set();
  let bankGraphemes = [];      // [{grapheme, phoneme}]
  function refreshBank() {
    try {
      bankWords = new Set(db.prepare('SELECT LOWER(word) w FROM words').all().map((r) => r.w));
      bankGraphemes = practice.PHONEME_PATTERNS || [];
    } catch (e) { /* ignore */ }
  }
  refreshBank();

  /* ─────────────── 1. 语料库：种子化 + 检索 ─────────────── */

  /** 从既有词库种子化 corpus（幂等）。character 用句子里出现的牛津树人物。 */
  function seedCorpus() {
    const rows = db.prepare(`
      SELECT word, sentence, stage, oxford_level FROM words
       WHERE sentence <> '' AND LENGTH(TRIM(sentence)) > 4
    `).all();
    // 注意：不能解构 .get，better-sqlite3 的 Statement 依赖 this
    const hasStmt = db.prepare('SELECT 1 FROM corpus WHERE LOWER(sentence) = LOWER(?) AND LOWER(word) = LOWER(?)');
    const ins = db.prepare(`
      INSERT INTO corpus (sentence, word, oxford_stage, character, source, status)
      VALUES (?, ?, ?, ?, 'seed', 'approved')
    `);
    let added = 0;
    db.transaction((list) => {
      for (const r of list) {
        if (hasStmt.get(r.sentence, r.word)) continue;
        const chars = practice.charactersIn(r.sentence);
        const stage = Number(r.stage) || (/^G1$/.test(r.oxford_level) ? 2 : 4);
        ins.run(String(r.sentence).trim(), String(r.word).trim(), stage, chars[0] || '');
        added++;
      }
    })(rows);
    return { added, total: db.prepare('SELECT COUNT(*) c FROM corpus').get().c };
  }

  /* 人物名不算生词：它们是专有名词，且是"语料与角色绑定"的锚点 */
  const CHARACTER_NAMES = new Set(['biff', 'chip', 'kipper', 'wilma', 'floppy', 'dad', 'mum', 'gran', 'anneena', 'nadim']);

  /** 严格词表守卫：句子里的每个词都必须在词库内（人物名放行），超出 stage 的生词一律不收 */
  function vocabClean(sentence) {
    const ws = wordsOf(sentence);
    if (!ws.length) return false;
    const missing = ws.filter((w) => !bankWords.has(w) && !CHARACTER_NAMES.has(w));
    return missing.length === 0 ? true : missing;
  }

  /**
   * 确定性检索（替代 Spec 里的 ChromaDB dense retrieval）
   * @returns {{hits:Array, guard:string}}
   */
  function retrieve({ targetWord, oxfordStage = 3, character = '', k = 3 }) {
    const tw = norm(targetWord);
    const stage = Math.max(STAGE_MIN, Math.min(STAGE_MAX, Number(oxfordStage) || 3));
    const twG = (practice.phonemesOf(tw) || []).map((p) => p.grapheme);

    const rows = db.prepare(`
      SELECT id, sentence, word, oxford_stage, character, source
        FROM corpus WHERE status = 'approved' AND oxford_stage <= ?
    `).all(stage);

    const scored = rows.map((r) => {
      const cw = norm(r.word);
      const cg = (practice.phonemesOf(cw) || []).map((p) => p.grapheme);
      const sharedG = cg.filter((g) => twG.includes(g)).length;
      let score = 0;
      if (cw === tw) score += 8;                                  // 同一个词，最高优先
      score += sharedG * 2.5;                                     // 共享拼读组合
      if (character && r.character === character) score += 2;      // 语料与角色绑定
      if (cw && tw && cw[0] === tw[0]) score += 1;                 // 同首字母
      score -= Math.abs(stage - (r.oxford_stage || 3)) * 0.15;     // stage 越接近越好
      // 词汇纯净度：句子全部落在词库内才加分（严格词表）
      const clean = vocabClean(r.sentence);
      if (clean === true) score += 1.5;
      return { ...r, score: Math.round(score * 100) / 100, sharedGraphemes: sharedG, vocabClean: clean === true };
    }).sort((a, b) => b.score - a.score);

    const hits = scored.slice(0, Math.max(1, k));
    return {
      hits,
      guard: bankWords.size ? `strict_vocab(${bankWords.size} words)` : 'vocab_unavailable',
    };
  }

  /* ─────────────── 2. Spec A：脚手架生成 ─────────────── */

  /* 单字母音素：引擎只覆盖多字母组合，这里补齐剩余字母。
     辅音映射是稳的；元音给短元音近似值并标 approximate。 */
  const CONSONANT_IPA = {
    b: '/b/', c: '/k/', d: '/d/', f: '/f/', g: '/g/', h: '/h/', j: '/dʒ/', k: '/k/',
    l: '/l/', m: '/m/', n: '/n/', p: '/p/', q: '/k/', r: '/r/', s: '/s/', t: '/t/',
    v: '/v/', w: '/w/', x: '/ks/', y: '/j/', z: '/z/',
  };
  const VOWEL_IPA = { a: '/æ/', e: '/e/', i: '/ɪ/', o: '/ɒ/', u: '/ʌ/' };

  /** 返回 [{grapheme, phoneme, approximate}] —— 先吃多字母组合，再补单字母 */
  function decomposePhonemes(word) {
    const w = norm(word).replace(/[^a-z]/g, '');
    const pats = (practice.phonemesOf(w) || []).slice();
    const out = [];
    let i = 0;
    // 按词内出现位置贪心匹配（长的优先，避免 ee 被拆成 e+e）
    const sorted = pats.filter((p) => p.grapheme).sort((a, b) => b.grapheme.length - a.grapheme.length);
    while (i < w.length) {
      const hit = sorted.find((p) => w.startsWith(p.grapheme, i));
      if (hit) {
        out.push({ grapheme: hit.grapheme, phoneme: hit.phoneme, approximate: false });
        i += hit.grapheme.length;
      } else {
        const ch = w[i];
        if (CONSONANT_IPA[ch]) out.push({ grapheme: ch, phoneme: CONSONANT_IPA[ch], approximate: false });
        else if (VOWEL_IPA[ch]) out.push({ grapheme: ch, phoneme: VOWEL_IPA[ch], approximate: true });
        else out.push({ grapheme: ch, phoneme: '', approximate: true });
        i++;
      }
    }
    // 去重（同字形只留一次）但保留顺序
    const seen = new Set();
    return out.filter((g) => (seen.has(g.grapheme) ? false : (seen.add(g.grapheme), true)));
  }

  function graphFacts(word) {
    const w = norm(word);
    const row = db.prepare('SELECT word, hint, stage, oxford_level FROM words WHERE LOWER(word) = ?').get(w) || {};
    const graphemes = decomposePhonemes(w).map((p) => ({
      grapheme: p.grapheme, phoneme: p.phoneme,
      articulation: (practice.articulationOf ? practice.articulationOf(p.phoneme) : '') || '',
      approximate: !!p.approximate,
    }));
    const syl = practice.syllabify(w);
    return {
      word: w,
      oxford_stage: Number(row.stage) || null,
      oxford_level: row.oxford_level || null,
      hint: row.hint || '',
      phonemes: graphemes.map((g) => g.phoneme),
      graphemes,
      rule: graphemes.length ? graphemes[graphemes.length - 1].grapheme : '',
      syllables: syl,
      in_bank: bankWords.has(w),
    };
  }

  /**
   * Spec A 主流程：图谱事实 → 检索 → 受控提示词 → 结构化输出
   */
  function scaffold(input = {}) {
    const target = norm(input.target_word);
    if (!target) return { status: 'error', error: 'target_word 必填' };
    if (!bankWords.has(target)) {
      return {
        status: 'rejected_by_guard',
        error: '目标词不在词库内，禁止生成超出字表的内容',
        target_word: target,
      };
    }

    const stage = Number(input.oxford_stage) || graphFacts(target).oxford_stage || 3;
    const character = String(input.character || '').trim().toLowerCase();
    const facts = graphFacts(target);
    const r = retrieve({ targetWord: target, oxfordStage: stage, character, k: 3 });

    // 选 grounded sentence：优先同词、其次同角色、最后分数最高
    const sameWord = r.hits.find((h) => norm(h.word) === target);
    const sameChar = r.hits.find((h) => character && h.character === character);
    const grounded = sameWord || sameChar || r.hits[0] || null;

    // 受控提示词：只用 目标词 + 角色名 + 音节切分，不引入任何字表外的英文
    const weak = String(input.identified_phoneme_weakness || '').trim();
    const sylText = facts.syllables.length > 1
      ? facts.syllables.join(' · ')
      : facts.graphemes.map((g) => g.grapheme).join(' · ');
    const who = grounded && grounded.character ? grounded.character : character;
    const parts = [];
    if (who) parts.push(`${who} 在故事里遇到过这个词`);
    parts.push(`这次是 ${target}，${facts.syllables.length > 1 ? '音节' : '拆开字母'}是 ${sylText}`);
    if (weak) parts.push(`重点听 ${weak} 这个音`);
    if (input.error_context) parts.push(`刚才 ${input.error_context} 差了一个音`);

    return {
      status: 'success',
      scaffolding_type: 'ort_context_hint',
      target_word: target,
      oxford_stage: stage,
      grounded_sentence: grounded ? grounded.sentence : '',
      grounded_from: grounded ? { corpus_id: grounded.id, character: grounded.character, stage: grounded.oxford_stage, source: grounded.source, score: grounded.score } : null,
      pedagogical_hint: parts.join('；') + '。',
      graph_facts: {
        phonemes: facts.phonemes,
        graphemes: facts.graphemes.map((g) => g.grapheme),
        rule: facts.rule,
        syllables: facts.syllables,
      },
      retrieval: {
        guard: r.guard,
        candidates: r.hits.map((h) => ({
          corpus_id: h.id, word: h.word, sentence: h.sentence,
          stage: h.oxford_stage, character: h.character, score: h.score,
        })),
      },
      // 供 HITL：把这次生成的提示也当作可审阅对象（不自动入库）
      needs_review: !sameWord,
    };
  }

  /* ─────────────── 3. Spec C：发现 → 证据 → 提案 ─────────────── */

  function makeProposalId() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const n = (db.prepare('SELECT COUNT(*) c FROM proposals').get() || {}).c || 0;
    return `PROP_${d.getFullYear()}_${ymd.slice(4)}_${String(n + 1).padStart(2, '0')}`;
  }

  /** 从真实错误日志里找"形近/音近混淆"：target 与用户输入差在哪个拼读组合 */
  function discoverConfusions({ windowDays = 7, threshold = 0.85, minFreq = 2 } = {}) {
    const since = `-${Math.max(1, Math.min(365, Number(windowDays) || 7))} day`;
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT ip, player, ts, detail FROM session_events
         WHERE event = 'answer_wrong' AND ts >= datetime('now','localtime',?)
         ORDER BY id DESC LIMIT 5000
      `).all(since);
    } catch (e) { return { error: 'session_events 不可用: ' + e.message }; }

    const pairs = new Map();   // key: gA>gB  -> {a,b,freq,players:Set,evidence:[]}
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.detail || '{}'); } catch (e) { continue; }
      const target = norm(d.word || d.target || '');
      const typed = norm(d.typed || d.response || '');
      if (!target || !typed || target === typed) continue;
      if (!/^[a-z]+$/.test(target) || !/^[a-z]+$/.test(typed)) continue;

      const tg = (practice.phonemesOf(target) || []).map((p) => p.grapheme);
      const yg = (practice.phonemesOf(typed) || []).map((p) => p.grapheme);
      const onlyT = tg.filter((g) => !yg.includes(g));
      const onlyY = yg.filter((g) => !tg.includes(g));
      for (const a of onlyT) {
        for (const b of onlyY) {
          if (!a || !b) continue;
          const key = `${a}>${b}`;
          const cur = pairs.get(key) || { a, b, freq: 0, players: new Set(), evidence: [] };
          cur.freq++;
          cur.players.add(r.player || r.ip || '?');
          if (cur.evidence.length < 5) {
            cur.evidence.push({ player: r.player || '?', target_word: target, user_input: typed, timestamp: r.ts });
          }
          pairs.set(key, cur);
        }
      }
    }

    /*
     * 统计闸门（可解释，不用黑箱）：
     *   confidence = 0.6 × min(1, freq/6) + 0.4 × min(1, users/4)
     * 再叠加硬下限：至少 MIN_FREQ 次、MIN_USERS 个不同孩子。
     *
     * 为什么不是"命中率"：我们没有"该孩子每次遇到这个词都错"的分母，
     * 只有错误事件本身，算命中率就是伪造分母。所以只用可观测的频次与受众广度。
     * 小样本会被这两项自然压低（4 条观测 → 0.80，过不了 0.85）。
     */
    const MIN_FREQ = 6;
    const MIN_USERS = 3;
    const reach = new Set(rows.map((r) => r.player || r.ip)).size || 1;
    const results = [];
    for (const [, v] of pairs) {
      const freqScore = Math.min(1, v.freq / 6);
      const reachScore = Math.min(1, v.players.size / 4);
      const confidence = Math.round((freqScore * 0.6 + reachScore * 0.4) * 1000) / 1000;
      const enough = v.freq >= MIN_FREQ && v.players.size >= MIN_USERS;
      results.push({
        source: v.a, target: v.b, freq: v.freq, users: v.players.size,
        confidence, evidence: v.evidence,
        gate: { enough_sample: enough, min_freq: MIN_FREQ, min_users: MIN_USERS },
      });
    }
    results.sort((x, y) => y.confidence - x.confidence);

    const passing = results.filter((x) => x.confidence >= threshold && x.gate.enough_sample);
    return { windowDays, threshold, totalErrors: rows.length, distinctUsers: reach, candidates: results.slice(0, 20), passing };
  }

  function createProposal({ kind, payload, confidence = 0, evidence = [], reason = '' }) {
    const id = makeProposalId();
    db.prepare(`
      INSERT INTO proposals (id, kind, payload, confidence, evidence, reason, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, kind, JSON.stringify(payload || {}), Number(confidence) || 0, JSON.stringify(evidence || []), String(reason || ''));
    return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  }

  /** 把检索到的候选边提升为"待审提案"（不会直接写生产图谱） */
  function proposeEdges(candidates = [], reason = '自动发现') {
    const out = [];
    const existsStmt = db.prepare(`
      SELECT 1 FROM proposals WHERE kind='graph_edge' AND status='pending'
        AND json_extract(payload,'$.source') = ? AND json_extract(payload,'$.target') = ?
    `);
    const inGraphStmt = db.prepare("SELECT 1 FROM phoneme_edge WHERE source=? AND target=? AND status='approved'");
    for (const c of candidates) {
      const payload = {
        edge_type: 'CONFUSED_WITH',
        source: `Phoneme_${c.source}`,
        target: `Phoneme_${c.target}`,
        grapheme_a: c.source, grapheme_b: c.target,
        freq: c.freq, users: c.users,
      };
      const srcNode = `Phoneme_${c.source}`, dstNode = `Phoneme_${c.target}`;
      if (existsStmt.get(srcNode, dstNode)) continue;
      if (inGraphStmt.get(c.source, c.target)) continue;
      out.push(createProposal({ kind: 'graph_edge', payload, confidence: c.confidence, evidence: c.evidence, reason }));
    }
    return out;
  }

  function listProposals(status = '') {
    const rows = status
      ? db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 200').all();
    return rows.map((r) => ({
      ...r,
      payload: safeJson(r.payload),
      evidence: safeJson(r.evidence, []),
      action_endpoints: {
        approve: `/api/proposals/approve?id=${r.id}`,
        reject: `/api/proposals/reject?id=${r.id}`,
      },
    }));
  }

  function safeJson(s, fb = {}) { try { return JSON.parse(s); } catch (e) { return fb; } }

  /** 审批通过 → 真正落库；拒绝 → 只改状态 */
  function reviewProposal(id, action) {
    const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    if (!p) return { error: 'proposal 不存在' };
    if (p.status !== 'pending') return { error: `该提案已是 ${p.status}，不能重复处理` };

    const payload = safeJson(p.payload);
    const done = (status) => db.prepare(
      "UPDATE proposals SET status=?, reviewed_at=datetime('now','localtime') WHERE id=?"
    ).run(status, id);

    if (action === 'reject') { done('rejected'); return { success: true, id, status: 'rejected', applied: null }; }

    if (p.kind === 'graph_edge') {
      try {
        db.prepare(`
          INSERT INTO phoneme_edge (source, target, edge_type, confidence, status, proposal_id)
          VALUES (?, ?, ?, ?, 'approved', ?)
          ON CONFLICT(source, target, edge_type) DO UPDATE SET confidence = excluded.confidence, status='approved'
        `).run(payload.grapheme_a || payload.source, payload.grapheme_b || payload.target,
               payload.edge_type || 'CONFUSED_WITH', Number(p.confidence) || 0, id);
        done('approved');
        return { success: true, id, status: 'approved', applied: { table: 'phoneme_edge', source: payload.source, target: payload.target } };
      } catch (e) { return { error: '落库失败: ' + e.message }; }
    }

    if (p.kind === 'corpus_sentence') {
      const bad = vocabClean(payload.sentence || '');
      if (bad !== true) return { error: '词表守卫拒绝：句子里含字表外的词 → ' + JSON.stringify(bad) };
      try {
        db.prepare(`
          INSERT INTO corpus (sentence, word, oxford_stage, character, source, status)
          VALUES (?, ?, ?, ?, 'agent', 'approved')
        `).run(String(payload.sentence).trim(), String(payload.word || '').trim(),
               Number(payload.oxford_stage) || 3, String(payload.character || ''));
        done('approved');
        return { success: true, id, status: 'approved', applied: { table: 'corpus', word: payload.word } };
      } catch (e) { return { error: '落库失败: ' + e.message }; }
    }

    return { error: '未知提案类型: ' + p.kind };
  }

  /* ─────────────── 4. 新增语料也必须走 HITL ─────────────── */

  function proposeCorpus({ sentence, word, oxfordStage = 3, character = '' }) {
    const bad = vocabClean(sentence || '');
    if (bad !== true) {
      return { error: '词表守卫拒绝：句子含字表外的词', missing: bad };
    }
    return createProposal({
      kind: 'corpus_sentence',
      payload: {
        sentence: String(sentence).trim(),
        word: norm(word),
        oxford_stage: Number(oxfordStage) || 3,
        character: String(character || '').trim().toLowerCase(),
      },
      confidence: 1,
      evidence: [],
      reason: '人工/Agent 新增语料，等待审阅',
    });
  }

  function listCorpus({ stage, character, q, limit = 200 } = {}) {
    let sql = "SELECT * FROM corpus WHERE status='approved'";
    const args = [];
    if (stage) { sql += ' AND oxford_stage <= ?'; args.push(Number(stage)); }
    if (character) { sql += ' AND character = ?'; args.push(String(character).toLowerCase()); }
    if (q) { sql += ' AND (LOWER(sentence) LIKE ? OR LOWER(word) LIKE ?)'; args.push('%' + String(q).toLowerCase() + '%', '%' + String(q).toLowerCase() + '%'); }
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(Math.max(1, Math.min(1000, Number(limit) || 200)));
    const rows = db.prepare(sql).all(...args);
    return { total: db.prepare('SELECT COUNT(*) c FROM corpus').get().c, rows };
  }

  function stats() {
    const c = (s) => (db.prepare(s).get() || {}).c || 0;
    return {
      corpus: c("SELECT COUNT(*) c FROM corpus WHERE status='approved'"),
      corpusByCharacter: db.prepare("SELECT COALESCE(NULLIF(character,''),'narrator') ch, COUNT(*) n FROM corpus WHERE status='approved' GROUP BY ch ORDER BY n DESC").all(),
      pending: c("SELECT COUNT(*) c FROM proposals WHERE status='pending'"),
      approved: c("SELECT COUNT(*) c FROM proposals WHERE status='approved'"),
      rejected: c("SELECT COUNT(*) c FROM proposals WHERE status='rejected'"),
      edges: c("SELECT COUNT(*) c FROM phoneme_edge WHERE status='approved'"),
    };
  }

  return {
    seedCorpus, retrieve, scaffold, graphFacts,
    discoverConfusions, proposeEdges, proposeCorpus,
    createProposal, listProposals, reviewProposal,
    listCorpus, stats, vocabClean,
  };
};
