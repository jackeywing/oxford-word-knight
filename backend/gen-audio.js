#!/usr/bin/env node
/**
 * gen-audio.js — 用 Azure Speech 批量生成发音音频
 *
 * 为什么在构建期生成而不是运行时调用：
 *   GitHub Pages 是纯静态站，前端直连 Azure 会把 key 暴露在浏览器里。
 *   所以一次性生成 mp3 落到 docs/audio/，前端用 <audio> 播放，零外部依赖。
 *
 * 增量策略：已存在的文件跳过，只有新增词才消耗额度。
 *
 * 用法：
 *   node backend/gen-audio.js                 # 全量（缺什么补什么）
 *   node backend/gen-audio.js --limit 20      # 只做前 20 个词（试跑）
 *   node backend/gen-audio.js --only words    # 只生词
 *   node backend/gen-audio.js --only sentences
 *   node backend/gen-audio.js --force         # 忽略已存在，全部重生成
 *   node backend/gen-audio.js --concurrency 4
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'audio');
const WORD_DIR = path.join(OUT_DIR, 'words');
const SENT_DIR = path.join(OUT_DIR, 'sentences');
const PHRASE_DIR = path.join(OUT_DIR, 'phrases');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

/* ─────────── 参数 ─────────── */
const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const LIMIT = Number(argVal('limit', 0)) || 0;
const ONLY = argVal('only', '');
const FORCE = argv.includes('--force');
const CONC = Math.max(1, Math.min(8, Number(argVal('concurrency', 3)) || 3));

/* ─────────── 凭据（只读 .env，不打印） ─────────── */
function loadEnv() {
  const f = path.join(__dirname, '.env');
  const env = {};
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return env;
}
const ENV = loadEnv();
const KEY = process.env.AZURE_SPEECH_KEY || ENV.AZURE_SPEECH_KEY || '';
const REGION = process.env.AZURE_SPEECH_REGION || ENV.AZURE_SPEECH_REGION || '';
if (!KEY || !REGION) {
  console.error('❌ 缺少 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION（写在 backend/.env）');
  process.exit(1);
}

/* ─────────── 音色映射 ───────────
 * ORT 是英式教材，所以词汇统一用 en-GB。
 * en-GB-MaisieNeural 是 Azure 官方标注为「孩子」的音色，正好对应低龄主角。
 */
const VOICE = {
  narrador:   'en-GB-SoniaNeural',   // 旁白：清晰成年女声
  narrator:   'en-GB-SoniaNeural',
  vocab:      'en-GB-SoniaNeural',   // 单词发音：统一、干净
  biff:       'en-GB-MaisieNeural',  // 女孩（儿童音色）
  wilma:      'en-GB-HollieNeural',  // 女孩
  chip:       'en-GB-RyanNeural',    // 男孩
  kipper:     'en-GB-RyanNeural',    // 男孩（靠 prosody 提亮，模拟更小的孩子）
  floppy:     'en-GB-RyanNeural',    // 宠物（pitch 抬高）
  mum:        'en-GB-SoniaNeural',
  dad:        'en-GB-RyanNeural',
  gran:       'en-GB-SoniaNeural',
  wilf:       'en-GB-RyanNeural',
  nadim:      'en-GB-RyanNeural',
  anneena:    'en-GB-MaisieNeural',
};
/*
 * 音高/语速微调（Azure 没有宠物音色，靠 pitch/rate 做区分）：
 *   chip    -5%  → 音高略低，比 Kipper 沉稳
 *   kipper +15%  → 明显更小的男孩
 *   floppy +35%  → 卡通化的宠物
 * 同一句朗读时这些差异要足够大，否则「切换角色听不出变化」。
 */
const PITCH = { chip: '-5%', kipper: '+15%', floppy: '+35%', gran: '-6%' };
const RATE_CHAR = { chip: '', kipper: '-8%', floppy: '-8%' };

/* 角色自我介绍：文本必须与 frontend/practice.html 的 GREET 完全一致，
   否则前端按文本查不到音频，会掉回系统语音（之前就是这个问题）。 */
const PHRASES = [
  { key: 'hello-biff',   speaker: 'biff',   text: 'Hello, I am Biff.' },
  { key: 'hello-chip',   speaker: 'chip',   text: 'Hello, I am Chip.' },
  { key: 'hello-kipper', speaker: 'kipper', text: 'Hello, I am Kipper.' },
  { key: 'hello-wilma',  speaker: 'wilma',  text: 'Hello, I am Wilma.' },
  { key: 'hello-floppy', speaker: 'floppy', text: 'Woof! I am Floppy.' },
];
const RATE = { vocab: '-10%' };   // 单词读慢一点，方便孩子跟读

function voiceFor(speaker, kind) {
  if (kind === 'vocab') return VOICE.vocab;
  const s = String(speaker || '').toLowerCase();
  return VOICE[s] || VOICE.narrator;
}

function ssml(text, voiceName, { pitch, rate } = {}) {
  const safe = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const prosody = [];
  if (pitch) prosody.push(`pitch="${pitch}"`);
  if (rate) prosody.push(`rate="${rate}"`);
  const inner = prosody.length ? `<prosody ${prosody.join(' ')}>${safe}</prosody>` : safe;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-GB">`
       + `<voice name="${voiceName}">${inner}</voice></speak>`;
}

/* ─────────── 合成 ─────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function synth(text, voiceName, opts = {}, tries = 3) {
  const url = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'owk-gen-audio',
        },
        body: ssml(text, voiceName, opts),
      });
      if (res.status === 429) {                       // 限流 → 退避
        const ra = Number(res.headers.get('retry-after')) || (attempt * 2);
        await sleep(ra * 1000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (attempt === tries) throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
        await sleep(600 * attempt);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error(`音频过短 (${buf.length} 字节)`);
      return buf;
    } catch (e) {
      if (attempt === tries) throw e;
      await sleep(700 * attempt);
    }
  }
  throw new Error('synthesis failed');
}

/* ─────────── 裁尾部静音 ───────────
 * Azure 对每个短词都会补一段固定长度的尾部静音（实测 1.0–1.4 秒），
 * 不裁的话 "of" 也要播 1.87 秒，听着像卡住。用 ffmpeg 反向裁剪再补 80ms 尾音。
 */
const HAS_FFMPEG = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
})();

function trimSilence(buf) {
  if (!HAS_FFMPEG) return buf;
  const tag = crypto.randomBytes(6).toString('hex');
  const src = path.join(require('os').tmpdir(), `owk_${tag}_in.mp3`);
  const dst = path.join(require('os').tmpdir(), `owk_${tag}_out.mp3`);
  try {
    fs.writeFileSync(src, buf);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', src,
      '-af', 'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_duration=0.10,areverse,apad=pad_dur=0.08',
      '-c:a', 'libmp3lame', '-b:a', '48k', dst,
    ]);
    const out = fs.readFileSync(dst);
    return out.length > 400 ? out : buf;
  } catch (e) {
    return buf;               // 裁剪失败就用原音频，不影响生成
  } finally {
    try { fs.unlinkSync(src); } catch (e) {}
    try { fs.unlinkSync(dst); } catch (e) {}
  }
}

/* ─────────── 主流程 ─────────── */
function safeName(word) {
  return String(word).toLowerCase().replace(/[^a-z0-9]/g, '_');
}
function sentKey(sentence) {
  return crypto.createHash('sha1').update(String(sentence)).digest('hex').slice(0, 12);
}

async function pool(items, worker, concurrency) {
  let idx = 0, done = 0;
  const total = items.length;
  const errors = [];
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= total) return;
      const item = items[i];
      try {
        await worker(item);
      } catch (e) {
        errors.push({ item, error: e.message });
        console.error(`  ✗ ${item.label}: ${e.message}`);
      }
      done++;
      if (done % 25 === 0 || done === total) {
        process.stdout.write(`\r  进度 ${done}/${total}  (${(done / total * 100).toFixed(0)}%)   `);
      }
    }
  });
  await Promise.all(runners);
  process.stdout.write('\n');
  return errors;
}

(async () => {
  fs.mkdirSync(WORD_DIR, { recursive: true });
  fs.mkdirSync(SENT_DIR, { recursive: true });

  const db = new Database(path.join(ROOT, 'backend', 'db.sqlite3'), { readonly: true });
  const rows = db.prepare('SELECT word, sentence, hint FROM words ORDER BY id').all();
  db.close();

  let manifest = {};
  if (fs.existsSync(MANIFEST)) {
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { manifest = {}; }
  }
  manifest.words = manifest.words || {};
  manifest.sentences = manifest.sentences || {};
  manifest.voices = VOICE;

  /* ── 0. 角色开场白（5 条，很快） ── */
  if (!ONLY || ONLY === 'phrases') {
    fs.mkdirSync(PHRASE_DIR, { recursive: true });
    manifest.phrases = manifest.phrases || {};
    const todo = PHRASES.filter((ph) => {
      if (FORCE) return true;
      return !fs.existsSync(path.join(PHRASE_DIR, ph.key + '.mp3'));
    });
    console.log(`\n【开场白】共 ${PHRASES.length}，待生成 ${todo.length}`);
    const errs = await pool(
      todo.map((ph) => ({ ...ph, label: 'phrase:' + ph.key })),
      async (ph) => {
        const voice = voiceFor(ph.speaker, 'sentence');
        const raw = await synth(ph.text, voice, { pitch: PITCH[ph.speaker], rate: RATE_CHAR[ph.speaker] });
        const buf = trimSilence(raw);
        const file = 'phrases/' + ph.key + '.mp3';
        fs.writeFileSync(path.join(OUT_DIR, file), buf);
        manifest.phrases[ph.text] = { file, bytes: buf.length, voice, speaker: ph.speaker };
      },
      CONC
    );
    console.log(`  完成，失败 ${errs.length}`);
  }

  /* ── 1. 单词 ── */
  if (!ONLY || ONLY === 'words') {
    let list = rows.filter((r) => /^[a-z]+$/i.test(String(r.word).trim()));
    if (LIMIT) list = list.slice(0, LIMIT);
    const todo = list.filter((r) => {
      if (FORCE) return true;
      const f = path.join(WORD_DIR, safeName(r.word) + '.mp3');
      return !fs.existsSync(f);
    });
    console.log(`\n【单词】共 ${list.length}，待生成 ${todo.length}（已存在 ${list.length - todo.length}）`);
    const errs = await pool(
      todo.map((r) => ({ word: r.word, label: 'word:' + r.word })),
      async (it) => {
        const raw = await synth(it.word, VOICE.vocab, { rate: RATE.vocab });
        const buf = trimSilence(raw);
        const file = 'words/' + safeName(it.word) + '.mp3';
        fs.writeFileSync(path.join(OUT_DIR, file), buf);
        manifest.words[it.word.toLowerCase()] = { file, bytes: buf.length, voice: VOICE.vocab };
      },
      CONC
    );
    console.log(`  完成，失败 ${errs.length}`);
  }

  /* ── 2. 例句 ── */
  if (!ONLY || ONLY === 'sentences') {
    let list = rows.filter((r) => r.sentence && String(r.sentence).trim().length > 4);
    if (LIMIT) list = list.slice(0, LIMIT);
    const todo = list.filter((r) => {
      if (FORCE) return true;
      return !fs.existsSync(path.join(SENT_DIR, sentKey(r.sentence) + '.mp3'));
    });
    console.log(`\n【例句】共 ${list.length}，待生成 ${todo.length}（已存在 ${list.length - todo.length}）`);

    // 逐句判断说话人：句子里出现某个角色就用那个角色的音色
    const charsOf = (s) => {
      const t = String(s || '').toLowerCase();
      return ['biff', 'chip', 'kipper', 'wilma', 'floppy', 'gran', 'mum', 'dad', 'wilf', 'nadim', 'anneena']
        .filter((n) => new RegExp('\\b' + n + '\\b').test(t));
    };

    const errs = await pool(
      todo.map((r) => ({ sentence: r.sentence, word: r.word, label: 'sent:' + String(r.sentence).slice(0, 30) })),
      async (it) => {
        const who = charsOf(it.sentence)[0] || '';
        const voice = voiceFor(who, 'sentence');
        const raw = await synth(it.sentence, voice, { pitch: PITCH[who], rate: RATE_CHAR[who] || '' });
        const buf = trimSilence(raw);
        const file = 'sentences/' + sentKey(it.sentence) + '.mp3';
        fs.writeFileSync(path.join(OUT_DIR, file), buf);
        manifest.sentences[it.sentence] = { file, bytes: buf.length, voice, speaker: who || 'narrator' };
      },
      CONC
    );
    console.log(`  完成，失败 ${errs.length}`);
  }

  manifest.generated_at = new Date().toISOString();
  manifest.counts = {
    words: Object.keys(manifest.words).length,
    sentences: Object.keys(manifest.sentences).length,
    phrases: Object.keys(manifest.phrases || {}).length,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  const size = (dir) => fs.readdirSync(dir).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
  console.log('\n=== 完成 ===');
  console.log('  单词文件 :', Object.keys(manifest.words).length, '/', mb(size(WORD_DIR)));
  console.log('  例句文件 :', Object.keys(manifest.sentences).length, '/', mb(size(SENT_DIR)));
  console.log('  manifest :', MANIFEST);
})();
