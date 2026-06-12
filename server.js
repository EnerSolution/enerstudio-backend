const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RUNWAY_KEY = process.env.RUNWAY_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ 
    status: 'EnerStudio Backend Running', 
    version: '7.7.0',
    ffmpeg: ffmpegPath ? 'available' : 'missing'
  });
});

app.post('/api/claude/generate', async (req, res) => {
  try {
    const { prompt, system } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        system: system || 'You are a professional video script writer.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error('Anthropic error ' + response.status + ': ' + JSON.stringify(data));
    res.json({ text: data.content?.[0]?.text || '', success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/runway/balance', async (req, res) => {
  try {
    const response = await fetch('https://api.dev.runwayml.com/v1/organization', {
      headers: { 'Authorization': 'Bearer ' + RUNWAY_KEY, 'X-Runway-Version': '2024-11-06' }
    });
    res.json(await response.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// GENERATE SINGLE IMAGE via Runway gen4_image
app.post('/api/runway/generate-image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    console.log('Generating image for:', prompt.substring(0, 60));

    const imgRes = await fetch('https://api.dev.runwayml.com/v1/text_to_image', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gen4_image',
        promptText: prompt,
        ratio: '1280:720'
      })
    });
    const imgData = await imgRes.json();
    if (!imgRes.ok) throw new Error('Image gen failed: ' + JSON.stringify(imgData));

    // Poll for completion
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await fetch('https://api.dev.runwayml.com/v1/tasks/' + imgData.id, {
        headers: { 'Authorization': 'Bearer ' + RUNWAY_KEY, 'X-Runway-Version': '2024-11-06' }
      });
      const sd = await s.json();
      if (sd.status === 'SUCCEEDED' && sd.output?.[0]) {
        console.log('Image ready:', sd.output[0].substring(0, 60));
        return res.json({ imageUrl: sd.output[0], success: true });
      }
      if (sd.status === 'FAILED') throw new Error('Image task failed');
    }
    throw new Error('Image generation timeout');
  } catch (e) {
    console.error('Image gen error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/runway/generate', async (req, res) => {
  try {
    const { prompt, imageUrl } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // If imageUrl provided, use directly (handles both URLs and base64)
    if (imageUrl) {
      let finalImageUrl = imageUrl;

      // If base64, upload to a temp hosting or convert to data URI
      if (imageUrl.startsWith('data:')) {
        console.log('Base64 image detected - uploading to Runway as data URI');
        // Runway accepts data URIs directly in promptImage
        finalImageUrl = imageUrl;
      }

      console.log('Using provided image for video generation');
      const vidRes = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RUNWAY_KEY,
          'X-Runway-Version': '2024-11-06',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gen4_turbo',
          promptImage: finalImageUrl,
          promptText: prompt + ', smooth cinematic camera movement',
          duration: 5,
          ratio: '1280:720'
        })
      });
      const vidData = await vidRes.json();
      if (!vidRes.ok) throw new Error(JSON.stringify(vidData));
      console.log('Video task:', vidData.id);
      return res.json({ id: vidData.id, success: true });
    }

    // Step 1: Generate image with gen4_image (2 credits/sec = cheap)
    console.log('Generating image for:', prompt.substring(0, 60));
    const imgRes = await fetch('https://api.dev.runwayml.com/v1/text_to_image', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gen4_image',
        promptText: prompt + ', photorealistic, cinematic, 4K, professional photography, solar energy',
        ratio: '1280:720'
      })
    });
    const imgData = await imgRes.json();
    if (!imgRes.ok) throw new Error('Image gen failed: ' + JSON.stringify(imgData));
    
    // Step 2: Poll for image
    let generatedImageUrl = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await fetch('https://api.dev.runwayml.com/v1/tasks/' + imgData.id, {
        headers: { 'Authorization': 'Bearer ' + RUNWAY_KEY, 'X-Runway-Version': '2024-11-06' }
      });
      const statusData = await statusRes.json();
      if (statusData.status === 'SUCCEEDED' && statusData.output?.[0]) {
        generatedImageUrl = statusData.output[0];
        console.log('Image ready:', generatedImageUrl.substring(0, 60));
        break;
      }
      if (statusData.status === 'FAILED') throw new Error('Image failed');
    }
    if (!generatedImageUrl) throw new Error('Image timeout');

    // Step 3: Generate video with gen4_turbo (5 credits/sec = cheap)
    console.log('Generating video from image...');
    const vidRes = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gen4_turbo',
        promptImage: generatedImageUrl,
        promptText: prompt + ', smooth cinematic camera movement',
        duration: 5,
        ratio: '1280:720'
      })
    });
    const vidData = await vidRes.json();
    if (!vidRes.ok) throw new Error(JSON.stringify(vidData));
    console.log('Video task:', vidData.id);
    res.json({ id: vidData.id, success: true });
  } catch (e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/runway/status/:taskId', async (req, res) => {
  try {
    const response = await fetch('https://api.dev.runwayml.com/v1/tasks/' + req.params.taskId, {
      headers: { 'Authorization': 'Bearer ' + RUNWAY_KEY, 'X-Runway-Version': '2024-11-06' }
    });
    res.json(await response.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get first available ElevenLabs voice
async function getFirstVoice() {
  try {
    const r = await fetch('https://api.elevenlabs.io/v2/voices?page_size=1', {
      headers: { 'xi-api-key': ELEVENLABS_KEY }
    });
    const data = await r.json();
    const voices = data.voices || data.results || [];
    if (voices.length > 0) return voices[0].voice_id;
  } catch(e) {
    console.log('Could not fetch voices:', e.message);
  }
  return null;
}

app.post('/api/runway/stitch', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-'));
  try {
    const { clipUrls, voiceoverText, brandName, websiteUrl } = req.body;
    if (!clipUrls || clipUrls.length === 0) {
      return res.status(400).json({ error: 'No clip URLs provided' });
    }

    console.log('Stitching', clipUrls.length, 'clips. FFmpeg:', ffmpegPath);

    // Download all clips
    const clipFiles = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const clipPath = path.join(tempDir, 'clip' + i + '.mp4');
      const r = await fetch(clipUrls[i]);
      if (!r.ok) throw new Error('Clip ' + i + ' download failed: ' + r.status);
      fs.writeFileSync(clipPath, Buffer.from(await r.arrayBuffer()));
      clipFiles.push(clipPath);
      console.log('Downloaded clip', i + 1);
    }

    // Generate voiceover
    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        console.log('Getting voice ID...');
        let voiceId = req.body.voiceId || await getFirstVoice();
        if (!voiceId) voiceId = 'EXAVITQu4vr4xnSDxMaL'; // fallback Sarah voice
        console.log('Using voice ID:', voiceId);

        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
          },
          body: JSON.stringify({
            text: voiceoverText
              .replace(/\[.*?\]/g, '')
              .replace(/SCENE.*?:\s*/gi, '')
              .replace(/HOOK.*?:\s*/gi, '')
              .replace(/PROBLEM.*?:\s*/gi, '')
              .replace(/SOLUTION.*?:\s*/gi, '')
              .replace(/PROOF.*?:\s*/gi, '')
              .replace(/CTA.*?:\s*/gi, '')
              .replace(/VISUAL.*?:\n/gi, '')
              .replace(/Style:.*?\n/gi, '')
              .replace(/Open with.*?\n/gi, '')
              .replace(/Show.*?\n/gi, '')
              .replace(/\n+/g, ' ')
              .replace(/\s+/g, ' ')
              .replace(/\*\*Word count:.*?\*\*/gi, '')
              .replace(/Word count:.*?words/gi, '')
              .trim()
              .substring(0, 2000),
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        });
        if (vr.ok) {
          audioFile = path.join(tempDir, 'voice.mp3');
          const audioBuf = await vr.arrayBuffer();
          fs.writeFileSync(audioFile, Buffer.from(audioBuf));
          console.log('Voiceover generated:', audioBuf.byteLength, 'bytes');
        } else {
          const errText = await vr.text();
          console.log('Voiceover failed:', vr.status, errText.substring(0, 200));
        }
      } catch (e) {
        console.log('Voice error:', e.message);
      }
    }

    // Stitch clips
    const listFile = path.join(tempDir, 'list.txt');
    fs.writeFileSync(listFile, clipFiles.map(f => "file '" + f + "'").join('\n'));
    const stitched = path.join(tempDir, 'stitched.mp4');
    execSync('"' + ffmpegPath + '" -f concat -safe 0 -i "' + listFile + '" -c copy "' + stitched + '" -y', { timeout: 120000 });
    console.log('Clips stitched');

    // Add text overlays using a drawtext file to avoid special character issues
    const brand = (brandName || 'EnerStudio').replace(/[^a-zA-Z0-9 ]/g, '');
    const website = (websiteUrl || 'EnerStudio.io').replace(/[^a-zA-Z0-9./]/g, '');
    const totalDuration = clipFiles.length * 5;
    const withText = path.join(tempDir, 'with_text.mp4');

    // Skip text overlay - ffmpeg-static does not support drawtext filter
    // Text overlay will be added in next version with full FFmpeg build
    fs.copyFileSync(stitched, withText);
    console.log('Skipping text overlay - using stitched video directly');

    let finalPath = withText;

    // Add voiceover
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir, 'final.mp4');
      const videoDuration = clipFiles.length * 5;
      execSync('"' + ffmpegPath + '" -i "' + withText + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac -t ' + videoDuration + ' "' + withAudio + '" -y', { timeout: 120000 });
      finalPath = withAudio;
      console.log('Audio added to final video');
    } else {
      console.log('No audio file available - sending video without voiceover');
    }

    const finalVideo = fs.readFileSync(finalPath);
    console.log('Sending final video:', finalVideo.length, 'bytes');
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="enerstudio-video.mp4"');
    res.send(finalVideo);

  } catch (e) {
    console.error('Stitch error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ===== WHITEBOARD 2.0: TRUE DRAW-ON ANIMATION =====
// Claude generates vector SVG scenes -> this engine animates every stroke being
// drawn by a marker, frame by frame, plus letter-by-letter text writing.
// Zero Runway credits. Crisp line art. VideoScribe-style output.
let createCanvas = null;
try { createCanvas = require('canvas').createCanvas; } catch (e) { console.log('canvas module not available:', e.message); }

const WB_W = 1280, WB_H = 720, WB_FPS = 25;

// --- Parse simple SVG elements (path/line/circle/rect/ellipse/text) in document order ---
function wbParseSvg(svg) {
  const els = [];
  const re = /<(path|line|circle|rect|ellipse|text)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/gi;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = {};
    const attrRe = /([a-zA-Z0-9\-:_]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[2])) !== null) attrs[a[1].toLowerCase()] = a[2];
    const inner = (m[4] || '').replace(/<[^>]+>/g, '').trim();
    els.push({ tag, attrs, text: inner });
  }
  return els;
}

// --- Convert one element to an ordered list of points (the "stroke") ---
// deterministic tiny jitter -> hand-drawn line feel instead of vector-perfect
function wbJitter(pts, seed) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  return pts.map((p, i) => (i === 0 || i === pts.length - 1) ? p : [p[0] + rnd() * 2.2, p[1] + rnd() * 2.2]);
}

function wbElementPoints(el) {
  const A = el.attrs, pts = [];
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  if (el.tag === 'line') {
    const x1 = num(A.x1, 0), y1 = num(A.y1, 0), x2 = num(A.x2, 0), y2 = num(A.y2, 0);
    const len = Math.hypot(x2 - x1, y2 - y1), steps = Math.max(2, Math.round(len / 4));
    for (let i = 0; i <= steps; i++) pts.push([x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps]);
  } else if (el.tag === 'circle') {
    const cx = num(A.cx, 0), cy = num(A.cy, 0), r = num(A.r, 10);
    const steps = Math.max(16, Math.round(2 * Math.PI * r / 5));
    for (let i = 0; i <= steps; i++) { const t = -Math.PI / 2 + 2 * Math.PI * i / steps; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  } else if (el.tag === 'ellipse') {
    const cx = num(A.cx, 0), cy = num(A.cy, 0), rx = num(A.rx, 10), ry = num(A.ry, 10);
    const steps = Math.max(16, Math.round(Math.PI * (rx + ry) / 5));
    for (let i = 0; i <= steps; i++) { const t = -Math.PI / 2 + 2 * Math.PI * i / steps; pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
  } else if (el.tag === 'rect') {
    const x = num(A.x, 0), y = num(A.y, 0), w = num(A.width, 10), h = num(A.height, 10);
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
    for (let c = 0; c < 4; c++) {
      const [ax, ay] = corners[c], [bx, by] = corners[c + 1];
      const len = Math.hypot(bx - ax, by - ay), steps = Math.max(2, Math.round(len / 4));
      for (let i = 0; i <= steps; i++) pts.push([ax + (bx - ax) * i / steps, ay + (by - ay) * i / steps]);
    }
  } else if (el.tag === 'path') {
    // Supports M/m L/l H/h V/v C/c Q/q Z/z — sampled into points
    const d = A.d || '';
    const tokens = d.match(/[MmLlHhVvCcQqZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
    let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = '';
    const read = () => parseFloat(tokens[i++]);
    const bez3 = (p0, p1, p2, p3, t) => { const u = 1 - t; return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3; };
    const bez2 = (p0, p1, p2, t) => { const u = 1 - t; return u*u*p0 + 2*u*t*p1 + t*t*p2; };
    while (i < tokens.length) {
      const t0 = tokens[i];
      if (/[MmLlHhVvCcQqZz]/.test(t0)) { cmd = t0; i++; }
      if (cmd === 'M' || cmd === 'm') {
        const x = read(), y = read();
        cx = cmd === 'm' ? cx + x : x; cy = cmd === 'm' ? cy + y : y;
        sx = cx; sy = cy; pts.push([cx, cy]); cmd = cmd === 'M' ? 'L' : 'l';
      } else if (cmd === 'L' || cmd === 'l') {
        const x = read(), y = read();
        const nx = cmd === 'l' ? cx + x : x, ny = cmd === 'l' ? cy + y : y;
        const len = Math.hypot(nx - cx, ny - cy), steps = Math.max(2, Math.round(len / 4));
        for (let k = 1; k <= steps; k++) pts.push([cx + (nx - cx) * k / steps, cy + (ny - cy) * k / steps]);
        cx = nx; cy = ny;
      } else if (cmd === 'H' || cmd === 'h') {
        const x = read(); const nx = cmd === 'h' ? cx + x : x;
        const steps = Math.max(2, Math.round(Math.abs(nx - cx) / 4));
        for (let k = 1; k <= steps; k++) pts.push([cx + (nx - cx) * k / steps, cy]);
        cx = nx;
      } else if (cmd === 'V' || cmd === 'v') {
        const y = read(); const ny = cmd === 'v' ? cy + y : y;
        const steps = Math.max(2, Math.round(Math.abs(ny - cy) / 4));
        for (let k = 1; k <= steps; k++) pts.push([cx, cy + (ny - cy) * k / steps]);
        cy = ny;
      } else if (cmd === 'C' || cmd === 'c') {
        const x1 = read(), y1 = read(), x2 = read(), y2 = read(), x = read(), y = read();
        const p1x = cmd === 'c' ? cx + x1 : x1, p1y = cmd === 'c' ? cy + y1 : y1;
        const p2x = cmd === 'c' ? cx + x2 : x2, p2y = cmd === 'c' ? cy + y2 : y2;
        const nx = cmd === 'c' ? cx + x : x, ny = cmd === 'c' ? cy + y : y;
        for (let k = 1; k <= 24; k++) { const t = k / 24; pts.push([bez3(cx, p1x, p2x, nx, t), bez3(cy, p1y, p2y, ny, t)]); }
        cx = nx; cy = ny;
      } else if (cmd === 'Q' || cmd === 'q') {
        const x1 = read(), y1 = read(), x = read(), y = read();
        const p1x = cmd === 'q' ? cx + x1 : x1, p1y = cmd === 'q' ? cy + y1 : y1;
        const nx = cmd === 'q' ? cx + x : x, ny = cmd === 'q' ? cy + y : y;
        for (let k = 1; k <= 16; k++) { const t = k / 16; pts.push([bez2(cx, p1x, nx, t), bez2(cy, p1y, ny, t)]); }
        cx = nx; cy = ny;
      } else if (cmd === 'Z' || cmd === 'z') {
        const len = Math.hypot(sx - cx, sy - cy), steps = Math.max(2, Math.round(len / 4));
        for (let k = 1; k <= steps; k++) pts.push([cx + (sx - cx) * k / steps, cy + (sy - cy) * k / steps]);
        cx = sx; cy = sy;
      } else { i++; }
    }
  }
  return pts;
}

// --- Draw a realistic hand holding a pen at the drawing position ---
// Pen tip lands exactly at (x,y). Hand extends to lower-right like a right-handed writer.
function wbDrawHand(ctx, x, y, lifted) {
  ctx.save();
  ctx.translate(x, y);
  const lift = lifted ? 1.06 : 1.0;
  ctx.scale(lift, lift);
  ctx.rotate(0.12);
  // soft shadow under hand
  ctx.fillStyle = lifted ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.12)';
  ctx.beginPath(); ctx.ellipse(95, 95, 95, 34, -0.5, 0, Math.PI * 2); ctx.fill();
  // pen (dark blue marker) from tip up-right
  ctx.strokeStyle = '#1a2740'; ctx.lineCap = 'round';
  ctx.lineWidth = 13;
  ctx.beginPath(); ctx.moveTo(3, -3); ctx.lineTo(46, -46); ctx.stroke();
  ctx.lineWidth = 17;
  ctx.beginPath(); ctx.moveTo(20, -20); ctx.lineTo(50, -50); ctx.stroke();
  // metal tip
  ctx.strokeStyle = '#8a8f98'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(1, -1); ctx.lineTo(12, -12); ctx.stroke();
  const skin = '#e8b48e', skinDark = '#c98e63';
  // thumb wrapping the pen
  ctx.fillStyle = skin; ctx.strokeStyle = skinDark; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(22, -28);
  ctx.bezierCurveTo(38, -44, 62, -42, 66, -26);
  ctx.bezierCurveTo(68, -16, 56, -10, 44, -14);
  ctx.bezierCurveTo(34, -17, 26, -22, 22, -28);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // index finger along the pen toward the tip
  ctx.beginPath();
  ctx.moveTo(14, -6);
  ctx.bezierCurveTo(22, -20, 40, -34, 58, -34);
  ctx.bezierCurveTo(70, -34, 72, -22, 62, -16);
  ctx.bezierCurveTo(48, -8, 30, -2, 18, 0);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // hand body / fist
  ctx.beginPath();
  ctx.moveTo(30, 2);
  ctx.bezierCurveTo(46, -14, 84, -26, 112, -14);
  ctx.bezierCurveTo(142, 0, 150, 36, 132, 62);
  ctx.bezierCurveTo(114, 86, 76, 92, 52, 76);
  ctx.bezierCurveTo(32, 62, 22, 24, 30, 2);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // curled fingers (3 knuckle bumps)
  ctx.beginPath();
  ctx.moveTo(36, 6);
  ctx.bezierCurveTo(46, -2, 58, -2, 64, 8);
  ctx.bezierCurveTo(70, 0, 84, 0, 90, 10);
  ctx.bezierCurveTo(98, 2, 110, 4, 114, 14);
  ctx.stroke();
  // wrist + sleeve
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.moveTo(96, 70); ctx.lineTo(150, 120); ctx.lineTo(190, 86); ctx.lineTo(136, 40); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#3b4d71'; ctx.strokeStyle = '#2a3a58';
  ctx.beginPath(); ctx.moveTo(136, 106); ctx.lineTo(176, 142); ctx.lineTo(230, 96); ctx.lineTo(190, 60); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-draw-'));
  try {
    if (!createCanvas) return res.status(500).json({ error: 'Canvas engine not installed on server — redeploy with updated package.json' });
    const { svgScenes, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!svgScenes || !svgScenes.length) return res.status(400).json({ error: 'No SVG scenes provided' });
    const perScene = Math.max(4, Math.min(10, parseInt(secondsPerScene) || 5));
    console.log('Whiteboard 2.0: animating', svgScenes.length, 'scenes x', perScene, 's');

    const sceneClips = [];
    for (let sIdx = 0; sIdx < svgScenes.length; sIdx++) {
      const els = wbParseSvg(svgScenes[sIdx]);
      if (els.length === 0) { console.log('Scene', sIdx, 'has no drawable elements, skipping'); continue; }

      // Build stroke jobs: drawn elements -> point lists; text -> letter reveal
      const jobs = [];
      let elIdx = 0;
      for (const el of els) {
        if (el.tag === 'text') {
          if (el.text) jobs.push({ type: 'text', el, weight: el.text.length * 14 });
        } else {
          let pts = wbElementPoints(el);
          if (pts.length > 1) { pts = wbJitter(pts, elIdx); jobs.push({ type: 'stroke', el, pts, weight: pts.length }); }
        }
        elIdx++;
      }
      if (jobs.length === 0) continue;

      // Timeline: drawing time per job + short pen-travel gaps between jobs (hand moves, no ink)
      const holdFrames = Math.round(WB_FPS * 1.0);
      const travelF = 3;
      const drawFrames = perScene * WB_FPS - holdFrames - travelF * (jobs.length - 1);
      const totalWeight = jobs.reduce((a, j) => a + j.weight, 0);
      let acc = 0, cursor = 0;
      for (let ji = 0; ji < jobs.length; ji++) {
        const j = jobs[ji];
        const span = Math.max(2, Math.round(j.weight / totalWeight * drawFrames));
        j.startF = cursor; j.endF = cursor + span; cursor = j.endF + travelF;
        acc += j.weight;
      }
      const lastDrawFrame = jobs[jobs.length - 1].endF;

      const canvas = createCanvas(WB_W, WB_H);
      const ctx = canvas.getContext('2d');
      const frameDir = path.join(tempDir, 'f' + sIdx);
      fs.mkdirSync(frameDir);

      const totalFrames = lastDrawFrame + holdFrames;
      for (let f = 0; f < totalFrames; f++) {
        // white board background
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, WB_W, WB_H);
        let markerPos = null, lifted = false;
        for (const j of jobs) {
          const prog = f >= j.endF ? 1 : f <= j.startF ? 0 : (f - j.startF) / (j.endF - j.startF);
          if (prog <= 0) continue;
          const A = j.el.attrs;
          const stroke = (A.stroke && A.stroke !== 'none') ? A.stroke : '#111111';
          const sw = parseFloat(A['stroke-width']) || 5;
          if (j.type === 'stroke') {
            const n = Math.max(1, Math.floor(j.pts.length * prog));
            ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(j.pts[0][0], j.pts[0][1]);
            for (let p = 1; p < n; p++) ctx.lineTo(j.pts[p][0], j.pts[p][1]);
            ctx.stroke();
            if (prog < 1) markerPos = j.pts[Math.min(n, j.pts.length - 1)];
            // fill only once fully drawn
            if (prog >= 1 && A.fill && A.fill !== 'none' && A.fill !== 'white' && A.fill !== '#ffffff') {
              ctx.fillStyle = A.fill;
              ctx.beginPath(); ctx.moveTo(j.pts[0][0], j.pts[0][1]);
              for (let p = 1; p < j.pts.length; p++) ctx.lineTo(j.pts[p][0], j.pts[p][1]);
              ctx.closePath(); ctx.fill();
            }
          } else {
            const full = j.el.text;
            const n = Math.max(0, Math.floor(full.length * prog));
            const fs2 = parseFloat(A['font-size']) || 40;
            ctx.font = 'bold ' + fs2 + 'px sans-serif';
            ctx.fillStyle = (A.fill && A.fill !== 'none') ? A.fill : '#111111';
            ctx.textBaseline = 'alphabetic';
            const tx = parseFloat(A.x) || 0, ty = parseFloat(A.y) || 0;
            const anchor = A['text-anchor'];
            let drawX = tx;
            if (anchor === 'middle') drawX = tx - ctx.measureText(full).width / 2;
            else if (anchor === 'end') drawX = tx - ctx.measureText(full).width;
            const part = full.substring(0, n);
            ctx.fillText(part, drawX, ty);
            if (prog < 1 && n > 0) markerPos = [drawX + ctx.measureText(part).width, ty - fs2 * 0.3];
            else if (prog >= 1 && f < lastDrawFrame && jobs[jobs.length-1].el === j.el) { /* keep hand off after final text */ }
          }
        }
        // Pen travel: between jobs the hand glides (lifted) from previous end to next start
        if (!markerPos && f < lastDrawFrame) {
          for (let ji = 0; ji < jobs.length - 1; ji++) {
            const a = jobs[ji], b = jobs[ji + 1];
            if (f >= a.endF && f < b.startF) {
              const t = (f - a.endF) / Math.max(1, b.startF - a.endF);
              const pa = a.type === 'stroke' ? a.pts[a.pts.length - 1] : [WB_W / 2, 660];
              const pb = b.type === 'stroke' ? b.pts[0] : [WB_W / 2, 660];
              markerPos = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
              lifted = true;
              break;
            }
          }
        }
        if (markerPos && f < lastDrawFrame) wbDrawHand(ctx, markerPos[0], markerPos[1], lifted);
        fs.writeFileSync(path.join(frameDir, 'fr' + String(f).padStart(4, '0') + '.jpg'), canvas.toBuffer('image/jpeg', { quality: 0.92 }));
      }

      const clip = path.join(tempDir, 'scene' + sIdx + '.mp4');
      // subtle camera push-in for a living, professional feel
      execSync('"' + ffmpegPath + '" -y -framerate ' + WB_FPS + ' -i "' + path.join(frameDir, 'fr%04d.jpg') + '" -vf "scale=1600:900,zoompan=z=\'min(1+0.00055*on,1.10)\':d=1:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1280x720:fps=' + WB_FPS + '" -c:v libx264 -preset fast -pix_fmt yuv420p "' + clip + '"', { timeout: 240000 });
      fs.rmSync(frameDir, { recursive: true, force: true });
      sceneClips.push(clip);
      console.log('Scene', sIdx + 1, 'drawn (' + jobs.length + ' strokes)');
    }
    if (sceneClips.length === 0) throw new Error('No scenes could be animated');

    // Voiceover (same pipeline as cinematic)
    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
          method: 'POST',
          headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({
            text: voiceoverText.replace(/\[.*?\]/g, '').replace(/SCENE.*?:\s*/gi, '').replace(/HOOK.*?:\s*/gi, '').replace(/PROBLEM.*?:\s*/gi, '').replace(/SOLUTION.*?:\s*/gi, '').replace(/PROOF.*?:\s*/gi, '').replace(/CTA.*?:\s*/gi, '').replace(/\*\*Word count:.*?\*\*/gi, '').replace(/Word count:.*?words/gi, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000),
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        });
        if (vr.ok) { audioFile = path.join(tempDir, 'voice.mp3'); fs.writeFileSync(audioFile, Buffer.from(await vr.arrayBuffer())); console.log('Voiceover ready'); }
      } catch (e) { console.log('Voice error:', e.message); }
    }

    const listFile = path.join(tempDir, 'list.txt');
    fs.writeFileSync(listFile, sceneClips.map(f => "file '" + f + "'").join('\n'));
    const stitched = path.join(tempDir, 'stitched.mp4');
    execSync('"' + ffmpegPath + '" -f concat -safe 0 -i "' + listFile + '" -c copy "' + stitched + '" -y', { timeout: 120000 });

    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir, 'final.mp4');
      const dur = sceneClips.length * perScene;
      execSync('"' + ffmpegPath + '" -i "' + stitched + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac -t ' + dur + ' "' + withAudio + '" -y', { timeout: 120000 });
      finalPath = withAudio;
    }
    const out = fs.readFileSync(finalPath);
    console.log('Whiteboard 2.0 video ready:', out.length, 'bytes');
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="enerstudio-whiteboard.mp4"');
    res.send(out);
  } catch (e) {
    console.error('Whiteboard 2.0 error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ===== WHITEBOARD: build animated whiteboard video from sketch images + voiceover =====
// Cost: zero video-generation credits — animation is done by FFmpeg on this server.
app.post('/api/whiteboard/stitch', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-wb-'));
  try {
    const { imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No image URLs provided' });
    }
    const perScene = Math.max(3, Math.min(10, parseInt(secondsPerScene) || 5));
    console.log('Whiteboard: building', imageUrls.length, 'scenes x', perScene, 's');

    // 1. Download sketch images
    const imgFiles = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const p = path.join(tempDir, 'img' + i + '.jpg');
      const r = await fetch(imageUrls[i]);
      if (!r.ok) throw new Error('Image ' + i + ' download failed: ' + r.status);
      fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
      imgFiles.push(p);
    }
    console.log('Images downloaded');

    // 2. Build each scene clip: white canvas wipes to reveal the sketch (draw-on feel)
    const transitions = ['wipeleft', 'wipedown', 'circleopen', 'wiperight', 'smoothup', 'circlecrop'];
    const clipFiles = [];
    for (let i = 0; i < imgFiles.length; i++) {
      const clip = path.join(tempDir, 'clip' + i + '.mp4');
      const tr = transitions[i % transitions.length];
      const revealDur = Math.min(2.5, perScene - 1);
      const cmd = '"' + ffmpegPath + '" -y' +
        ' -f lavfi -i "color=white:s=1280x720:d=' + perScene + ':r=25"' +
        ' -loop 1 -framerate 25 -t ' + perScene + ' -i "' + imgFiles[i] + '"' +
        ' -filter_complex "[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1[im];' +
        '[0:v][im]xfade=transition=' + tr + ':duration=' + revealDur + ':offset=0.4,format=yuv420p[v]"' +
        ' -map "[v]" -c:v libx264 -preset fast -pix_fmt yuv420p -t ' + perScene + ' "' + clip + '"';
      execSync(cmd, { timeout: 120000 });
      clipFiles.push(clip);
      console.log('Whiteboard scene', i + 1, 'animated (' + tr + ')');
    }

    // 3. Voiceover via ElevenLabs (same cleaning as cinematic pipeline)
    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
          method: 'POST',
          headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({
            text: voiceoverText
              .replace(/\[.*?\]/g, '')
              .replace(/SCENE.*?:\s*/gi, '')
              .replace(/HOOK.*?:\s*/gi, '')
              .replace(/PROBLEM.*?:\s*/gi, '')
              .replace(/SOLUTION.*?:\s*/gi, '')
              .replace(/PROOF.*?:\s*/gi, '')
              .replace(/CTA.*?:\s*/gi, '')
              .replace(/\*\*Word count:.*?\*\*/gi, '')
              .replace(/Word count:.*?words/gi, '')
              .replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000),
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        });
        if (vr.ok) {
          audioFile = path.join(tempDir, 'voice.mp3');
          fs.writeFileSync(audioFile, Buffer.from(await vr.arrayBuffer()));
          console.log('Whiteboard voiceover generated');
        } else {
          console.log('Voiceover failed:', vr.status);
        }
      } catch (e) { console.log('Voice error:', e.message); }
    }

    // 4. Concat scenes
    const listFile = path.join(tempDir, 'list.txt');
    fs.writeFileSync(listFile, clipFiles.map(f => "file '" + f + "'").join('\n'));
    const stitched = path.join(tempDir, 'stitched.mp4');
    execSync('"' + ffmpegPath + '" -f concat -safe 0 -i "' + listFile + '" -c copy "' + stitched + '" -y', { timeout: 120000 });

    // 5. Mux voiceover, trimmed to video length
    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir, 'final.mp4');
      const videoDuration = clipFiles.length * perScene;
      execSync('"' + ffmpegPath + '" -i "' + stitched + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac -t ' + videoDuration + ' "' + withAudio + '" -y', { timeout: 120000 });
      finalPath = withAudio;
    }

    const finalVideo = fs.readFileSync(finalPath);
    console.log('Whiteboard video ready:', finalVideo.length, 'bytes');
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="enerstudio-whiteboard.mp4"');
    res.send(finalVideo);
  } catch (e) {
    console.error('Whiteboard error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ===== HEYGEN: list real avatars from your HeyGen account =====
app.get('/api/heygen/avatars', async (req, res) => {
  try {
    if (!process.env.HEYGEN_API_KEY) {
      return res.status(400).json({ error: 'HEYGEN_API_KEY not configured', configured: false });
    }
    const r = await fetch('https://api.heygen.com/v2/avatars', {
      headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY, 'Accept': 'application/json' }
    });
    const d = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: d.message || 'HeyGen API error', configured: true });
    }
    // Normalize: return id, name, gender, photo, previewVideo
    const avatars = ((d.data && d.data.avatars) || []).map(a => ({
      id: a.avatar_id,
      name: a.avatar_name,
      gender: (a.gender || 'unknown').toLowerCase(),
      photo: a.preview_image_url,
      previewVideo: a.preview_video_url || null,
      premium: !!a.premium
    }));
    res.json({ configured: true, count: avatars.length, avatars });
  } catch (e) {
    res.status(500).json({ error: e.message, configured: false });
  }
});

app.get('/api/voice/list', async (req, res) => {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_KEY }
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/voice/generate', async (req, res) => {
  try {
    const { text, voice_id } = req.body;
    let vid = voice_id;
    if (!vid) vid = await getFirstVoice() || 'EXAVITQu4vr4xnSDxMaL';
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!response.ok) throw new Error('ElevenLabs error ' + response.status);
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, function() {
  console.log('EnerStudio Backend v7.3 running on port ' + PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
