#!/usr/bin/env node
/**
 * audition-audio.js — 生成角色音色试听样本
 *
 * 起因：Azure 英文里只有 2 个儿童音色（en-GB-Maisie、en-US-Ana，都是女孩）。
 * Chip / Kipper 这类男孩角色只能靠成年男声 + prosody 模拟，哪一种"更像小孩"
 * 没法靠代码判断，必须人耳试听。
 *
 * 产出 docs/audio/audition/*.mp3 + docs/audio/audition.html
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'audio', 'audition');

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
if (!KEY || !REGION) { console.error('缺少 Azure 凭据'); process.exit(1); }

/* 候选清单：男声 7 个，女声 3 个，各配两档音高 */
const BOYS = ['en-GB-RyanNeural', 'en-GB-AlfieNeural', 'en-GB-ElliotNeural',
              'en-GB-EthanNeural', 'en-GB-NoahNeural', 'en-GB-ThomasNeural', 'en-GB-OliverNeural'];
const GIRLS = ['en-GB-MaisieNeural', 'en-GB-HollieNeural', 'en-GB-BellaNeural', 'en-GB-AbbiNeural', 'en-US-AnaNeural'];
const PITCHES = ['0%', '+15%'];

const TEXT_BOY = 'Hello, I am Chip.';
const TEXT_GIRL = 'Hello, I am Biff.';

function ssml(text, voice, pitch) {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inner = pitch && pitch !== '0%' ? `<prosody pitch="${pitch}">${safe}</prosody>` : safe;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-GB">`
       + `<voice name="${voice}">${inner}</voice></speak>`;
}

async function synth(text, voice, pitch) {
  const url = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  for (let i = 1; i <= 3; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'owk-audition',
      },
      body: ssml(text, voice, pitch),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000 * i)); continue; }
    if (!res.ok) { if (i === 3) throw new Error('HTTP ' + res.status); await new Promise((r) => setTimeout(r, 800)); continue; }
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > 500) return b;
  }
  throw new Error('failed');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const items = [];
  for (const v of BOYS) for (const p of PITCHES) items.push({ voice: v, pitch: p, text: TEXT_BOY, group: '男孩候选（Chip / Kipper）' });
  for (const v of GIRLS) for (const p of PITCHES) items.push({ voice: v, pitch: p, text: TEXT_GIRL, group: '女孩候选（Biff / Wilma）' });

  const manifest = [];
  let n = 0;
  for (const it of items) {
    const id = `${it.voice.replace('en-GB-', '').replace('Neural', '')}${it.pitch === '0%' ? '' : '_p15'}`;
    const file = id + '.mp3';
    try {
      const buf = await synth(it.text, it.voice, it.pitch);
      fs.writeFileSync(path.join(OUT, file), buf);
      manifest.push({ ...it, id, file, bytes: buf.length });
      process.stdout.write(`\r  ${++n}/${items.length}  ${id}          `);
    } catch (e) {
      console.error(`\n  ✗ ${it.voice} ${it.pitch}: ${e.message}`);
    }
  }
  process.stdout.write('\n');

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const groups = [...new Set(manifest.map((m) => m.group))];
  const body = groups.map((g) => `
  <h2>${esc(g)}</h2>
  <div class="grid">
    ${manifest.filter((m) => m.group === g).map((m) => `
      <div class="row">
        <span class="nm">${esc(m.id)}</span>
        <span class="meta">${esc(m.voice)} · pitch ${esc(m.pitch)}</span>
        <button onclick="play('audition/${esc(m.file)}', this)">▶ 试听</button>
      </div>`).join('')}
  </div>`).join('');

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>音色试听 · Word Knight</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;background:#1d1309;color:#FFE0B2;padding:20px;max-width:900px;margin:0 auto}
h1{color:#FFD54F;font-size:20px}h2{color:#FFD54F;font-size:15px;margin:22px 0 10px}
.grid{display:flex;flex-direction:column;gap:6px}
.row{display:grid;grid-template-columns:150px 1fr 92px;gap:10px;align-items:center;background:#3E2723;border:2px solid #5D4037;padding:9px 12px;border-radius:6px}
.nm{font-weight:700;font-size:13px}.meta{font-size:12px;color:#BCAAA4}
button{font:inherit;font-size:13px;padding:7px 12px;background:#2E7D32;color:#fff;border:none;border-radius:4px;cursor:pointer}
button:active{transform:translateY(1px)}
.note{font-size:13px;color:#BCAAA4;line-height:1.8;background:#3E2723;border-left:3px solid #FFD54F;padding:10px 14px;margin:14px 0}
</style></head><body>
<h1>🎧 角色音色试听</h1>
<div class="note">Azure 英文只有 2 个儿童音色（Maisie / Ana，都是女孩），没有男孩儿童音色。
男孩只能靠成年男声 + 音高模拟。请挑出你觉得最像 6–9 岁孩子的组合，告诉我 ID（如 <b>Alfie_p15</b>）。
<br>同一角色会用在「自我介绍 + 台词朗读」上，所以请按"像不像这个角色"来选，而不是"好不好听"。</div>
${body}
<script>
let cur=null;
function play(f,btn){
  if(cur){cur.pause();cur=null;}
  cur=new Audio(f);
  cur.play().catch(e=>alert('播放失败: '+e.name));
  document.querySelectorAll('button').forEach(b=>b.textContent='▶ 试听');
  btn.textContent='⏸ 播放中';
  cur.onended=()=>btn.textContent='▶ 试听';
}
</script></body></html>`;
  fs.writeFileSync(path.join(ROOT, 'docs', 'audio', 'audition.html'), html);

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n✓ ${manifest.length} 个样本 → docs/audio/audition/`);
  console.log('✓ 试听页 → docs/audio/audition.html');
})();
