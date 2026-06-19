const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
let pythonReady = false;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RUNWAY_KEY = process.env.RUNWAY_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const PEXELS_KEY = process.env.PEXELS_API_KEY;
const HEYGEN_KEY = process.env.HEYGEN_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── VIDEO OUTPUT STORE (bypasses Render 30s timeout) ──────────────────────
const outputStore = {}; // { videoId: { path, size, created } }
// Cleanup files older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
  Object.keys(outputStore).forEach(id => {
    if (outputStore[id].created < cutoff) {
      try { fs.unlinkSync(outputStore[id].path); } catch(e) {}
      delete outputStore[id];
      console.log('Cleaned up video:', id);
    }
  });
}, 2 * 60 * 60 * 1000); // every 2 hours

// ── PEXELS STOCK VIDEO FETCH (brand-agnostic; uses each scene's own query) ──
// Returns a local file path to a downloaded clip, or null on any failure.
async function fetchPexelsClip(query, orientation, tempDir, idx, directUrl) {
  if (!PEXELS_KEY) return null;
  try {
    let best = directUrl || null;
    if (!best) {
      if (!query) return null;
      async function searchFirst(q) {
        const url = 'https://api.pexels.com/videos/search?query=' + encodeURIComponent(q)
          + '&per_page=5&orientation=' + (orientation || 'landscape');
        const rr = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
        if (!rr.ok) return null;
        const dd = await rr.json();
        const vids = (dd && dd.videos) || [];
        for (const v of vids) {
          const files = (v.video_files || []).slice().sort((a,b)=> (a.width||0)-(b.width||0));
          let pick = files.find(f => (f.width||0) >= 720 && (f.width||0) <= 1280) || files[0];
          if (pick && pick.link) return pick.link;
        }
        return null;
      }
      best = await searchFirst(query);
      if (!best) {
        const words = query.trim().split(/\s+/);
        const broad = words.slice(-2).join(' ');
        if (broad && broad !== query) best = await searchFirst(broad);
        if (!best) best = await searchFirst('business professional');
      }
    }
    if (!best) return null;
    const clipPath = path.join(tempDir, 'stock' + idx + '.mp4');
    const vr = await fetch(best);
    if (!vr.ok) { console.log('Pexels download failed', vr.status); return null; }
    const buf = Buffer.from(await vr.arrayBuffer());
    if (!buf || buf.length < 10000) return null;
    fs.writeFileSync(clipPath, buf);
    return clipPath;
  } catch (e) {
    console.log('Pexels fetch error for', query, ':', e.message);
    return null;
  }
}

// Return MULTIPLE candidate clips for a query (thumbnails + a downloadable file URL) for user review/replace
async function searchPexelsCandidates(query, orientation, perPage) {
  if (!PEXELS_KEY || !query) return [];
  async function doSearch(q) {
    const url = 'https://api.pexels.com/videos/search?query=' + encodeURIComponent(q)
      + '&per_page=' + (perPage || 6) + '&orientation=' + (orientation || 'landscape');
    const r = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (!r.ok) return [];
    const data = await r.json();
    const videos = (data && data.videos) || [];
    return videos.map(v => {
      const files = (v.video_files || []).slice().sort((a,b)=> (a.width||0)-(b.width||0));
      const pick = files.find(f => (f.width||0) >= 720 && (f.width||0) <= 1280) || files[0];
      return { id: v.id, thumb: v.image, fileUrl: pick ? pick.link : null, duration: v.duration,
               width: pick ? pick.width : null, height: pick ? pick.height : null };
    }).filter(c => c.fileUrl && c.thumb);
  }
  try {
    let out = await doSearch(query);
    if (!out.length) {
      // broaden: try the last two words, then a generic business fallback
      const words = query.trim().split(/\s+/);
      const broad = words.slice(-2).join(' ');
      if (broad && broad !== query) out = await doSearch(broad);
      if (!out.length) out = await doSearch('business professional');
    }
    return out;
  } catch (e) {
    console.log('Pexels candidates error for', query, ':', e.message);
    return [];
  }
}



// Latest video endpoint — returns most recently saved videoId (for polling after timeout)
app.get('/api/video/latest', (req, res) => {
  const ids = Object.keys(outputStore);
  if (!ids.length) return res.json({ status: 'processing' });
  // Return the most recently created one
  const latest = ids.sort((a,b) => outputStore[b].created - outputStore[a].created)[0];
  const entry = outputStore[latest];
  if (!entry) return res.json({ status: 'processing' });
  res.json({ status: 'ready', videoId: latest, size: entry.size });
});

// Download endpoint — app fetches this after getting videoId
app.get('/api/video/:id', (req, res) => {
  const entry = outputStore[req.params.id];
  if (!entry) return res.status(404).json({ error: 'Video not found or expired' });
  if (!fs.existsSync(entry.path)) return res.status(404).json({ error: 'Video file missing' });
  res.set('Content-Type', 'video/mp4');
  res.set('Content-Disposition', 'attachment; filename="enerstudio-whiteboard.mp4"');
  res.set('Content-Length', entry.size);
  const stream = fs.createReadStream(entry.path);
  stream.pipe(res);
  // Clean up after download
  stream.on('end', () => {
    setTimeout(() => {
      try { fs.unlinkSync(entry.path); } catch(e) {}
      delete outputStore[req.params.id];
    }, 5000);
  });
});

// Status check endpoint — app polls this while video is processing
app.get('/api/video/:id/status', (req, res) => {
  const entry = outputStore[req.params.id];
  if (!entry) return res.json({ status: 'processing' });
  res.json({ status: 'ready', size: entry.size });
});


app.get('/', (req, res) => {
  res.json({ 
    status: 'EnerStudio Backend Running', 
    version: '8.48.0',
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
        temperature: 1.0,
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
    const { prompt, styleMode } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    
    // For whiteboard mode: put NO TEXT instruction FIRST, then style, then content
    let finalPrompt = prompt;
    if (styleMode === 'whiteboard') {
      // NO TEXT must come FIRST — Runway weighs earlier instructions more heavily
      finalPrompt = 'ZERO TEXT ZERO WORDS ZERO LETTERS ZERO NUMBERS anywhere in image. ' +
        'Pure white background only. Professional hand-drawn ink illustration. ' +
        'Clean confident black linework. No photography. No realistic rendering. No gradients. ' +
        finalPrompt;
    }
    console.log('Generating image for:', finalPrompt.substring(0, 80));

    const imgRes = await fetch('https://api.dev.runwayml.com/v1/text_to_image', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gen4_image',
        promptText: finalPrompt,
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

    const videoId = 'cin_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const outputPath = path.join(os.tmpdir(), videoId + '.mp4');
    fs.copyFileSync(finalPath, outputPath);
    const fileSize = fs.statSync(outputPath).size;
    outputStore[videoId] = { path: outputPath, size: fileSize, created: Date.now() };
    console.log('Cinematic ready:', fileSize, 'bytes, id:', videoId);
    res.json({ videoId, downloadUrl: '/api/video/' + videoId, size: fileSize });

  } catch (e) {
    console.error('Stitch error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// Professional hand with pen — 400x400px, transparent bg, pen tip at upper-left (91,70)
const HAND_B64_WB = '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';

app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-wb-'));
  try {
    const { imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No image URLs provided' });
    }
    const numScenes = imageUrls.length;
    console.log('Whiteboard v8.28.0:', numScenes, 'scenes, pythonReady=' + pythonReady);

    const handPath = path.join(tempDir, 'hand.png');
    fs.writeFileSync(handPath, Buffer.from(HAND_B64_WB, 'base64'));

    // ── STEP 1: GENERATE VOICEOVER FIRST ──────────────────────────
    // Audio-first architecture: measure voiceover duration, then
    // set perScene = audioDuration / numScenes so video matches exactly
    let audioFile = null;
    let audioDuration = parseInt(secondsPerScene || '5') * numScenes; // fallback
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const cleanText = voiceoverText.replace(/\[.*?\]/g,'').replace(/SCENE.*?:\s*/gi,'')
          .replace(/\n+/g,' ').replace(/\s+/g,' ').trim().substring(0,2000);
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+vid, {
          method:'POST',
          headers:{'xi-api-key':ELEVENLABS_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
          body:JSON.stringify({text:cleanText,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.75}})
        });
        if (vr.ok) {
          audioFile = path.join(tempDir,'voice.mp3');
          fs.writeFileSync(audioFile, Buffer.from(await vr.arrayBuffer()));
          // Measure actual audio duration from FFmpeg stderr
          try {
            execSync('"'+ffmpegPath+'" -i "'+audioFile+'"', {timeout:10000});
          } catch(pe) {
            const dm = (pe.stderr||pe.message||'').toString().match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            if (dm) {
              audioDuration = parseInt(dm[1])*3600 + parseInt(dm[2])*60 + parseFloat(dm[3]);
              console.log('Voiceover ready, duration:', audioDuration.toFixed(2)+'s');
            }
          }
        } else { console.log('Voiceover failed:', vr.status); }
      } catch(e) { console.log('Voice error:', e.message); }
    }

    // Calculate perScene from actual audio duration — NO minimum clamp
    // Each scene gets exactly audioDuration/numScenes seconds
    const perScene = parseFloat((audioDuration / numScenes).toFixed(2));
    console.log('perScene calculated:', perScene+'s ('+audioDuration.toFixed(2)+'s audio / '+numScenes+' scenes)');

    const sceneClips = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const imgPath = path.join(tempDir, 'img' + i + '.jpg');
      const ir = await fetch(imageUrls[i]);
      if (!ir.ok) throw new Error('Image ' + i + ' download failed: ' + ir.status);
      fs.writeFileSync(imgPath, Buffer.from(await ir.arrayBuffer()));
      const clip = path.join(tempDir, 'scene' + i + '.mp4');

      if (pythonReady) {
        const frameDir = path.join(tempDir, 'f' + i);
        fs.mkdirSync(frameDir);
        const pyScript = path.join(tempDir, 'reveal' + i + '.py');

        const pyCode = `
import numpy as np, math, os
from PIL import Image, ImageDraw
from skimage import measure

FPS=25
# 88% of scene time for drawing, 12% for hold — ensures image completes
DRAW_SECS=round(${perScene}*0.88, 2)
HOLD_SECS=round(${perScene}*0.12, 2)
draw_frames=int(DRAW_SECS*FPS)
ink_frames=int(draw_frames*0.72)
fill_frames=draw_frames-ink_frames
hold_frames=max(int(HOLD_SECS*FPS), 8)
total_frames=draw_frames+hold_frames

src=Image.open(${JSON.stringify(imgPath)}).convert('RGB')
W,H=src.size
arr=np.array(src)
r2,g2,b2=arr[:,:,0].astype(int),arr[:,:,1].astype(int),arr[:,:,2].astype(int)
gray=r2+g2+b2
max_c=np.maximum(np.maximum(arr[:,:,0],arr[:,:,1]),arr[:,:,2]).astype(int)
min_c=np.minimum(np.minimum(arr[:,:,0],arr[:,:,1]),arr[:,:,2]).astype(int)
sat=max_c-min_c

ink_mask=(gray<300).astype(np.uint8)
fill_mask=((sat>30)&(gray<700)&(gray>200)).astype(np.uint8)

labeled_ink=measure.label(ink_mask,connectivity=2)
labeled_fill=measure.label(fill_mask,connectivity=2)
ink_regs=sorted([r for r in measure.regionprops(labeled_ink) if r.area>=8],
    key=lambda r:(int(r.centroid[0]/60),r.centroid[1]))
fill_regs=sorted([r for r in measure.regionprops(labeled_fill) if r.area>=30],
    key=lambda r:(int(r.centroid[0]/60),r.centroid[1]))

def get_px(regs,labeled,mask):
    result=[]
    for reg in regs:
        m=(labeled==reg.label)&(mask==1)
        ys,xs=np.where(m)
        pts=sorted(zip(ys.tolist(),xs.tolist()))
        result.append({'pixels':[(x,y) for y,x in pts],'area':reg.area})
    return result

ink_data=get_px(ink_regs,labeled_ink,ink_mask)
fill_data=get_px(fill_regs,labeled_fill,fill_mask)

total_ink=sum(d['area'] for d in ink_data) or 1
total_fill=sum(d['area'] for d in fill_data) or 1

cum=0
for seg in ink_data:
    seg['start']=round(cum/total_ink*ink_frames)
    seg['end']=seg['start']+max(2,round(seg['area']/total_ink*ink_frames))
    cum+=seg['area']
cum=0
for seg in fill_data:
    seg['start']=ink_frames+round(cum/total_fill*fill_frames)
    seg['end']=seg['start']+max(2,round(seg['area']/total_fill*fill_frames))
    cum+=seg['area']

last_draw=max(
    (max(s['end'] for s in ink_data) if ink_data else 0),
    (max(s['end'] for s in fill_data) if fill_data else 0)
)

def ease(t): return 2*t*t if t<0.5 else 1-((-2*t+2)**2)/2

hand=Image.open(${JSON.stringify(handPath)}).convert('RGBA')
# Hand is 400x400, scale to 28% of image height for good visibility
HAND_SIZE=int(min(W,H)*0.28)
hand=hand.resize((HAND_SIZE,HAND_SIZE),Image.LANCZOS)
# Pen tip is at (91,70) in 400x400 image = 22.75% from left, 17.5% from top
TIP_OFFSET_X=int(HAND_SIZE*0.2275)
TIP_OFFSET_Y=int(HAND_SIZE*0.175)

canvas=np.full((H,W,3),255,dtype=np.uint8)
os.makedirs(${JSON.stringify(frameDir)},exist_ok=True)

for f in range(total_frames):
    hx,hy=None,None
    for seg in ink_data:
        if f<seg['start']: continue
        pr=1.0 if f>=seg['end'] else (f-seg['start'])/max(1,seg['end']-seg['start'])
        prog=ease(pr) if pr<1 else 1.0
        pxl=seg['pixels']
        n=max(1,int(len(pxl)*prog))
        for px,py in pxl[:n]: canvas[py,px]=arr[py,px]
        if pr<1 and pxl:
            # Smooth over last 20 pixels for stable hand position
            w=pxl[max(0,n-20):n]
            hx=sum(p[0] for p in w)/len(w)
            hy=sum(p[1] for p in w)/len(w)
    for seg in fill_data:
        if f<seg['start']: continue
        pr=1.0 if f>=seg['end'] else (f-seg['start'])/max(1,seg['end']-seg['start'])
        prog=ease(pr) if pr<1 else 1.0
        pxl=seg['pixels']
        n=max(1,int(len(pxl)*prog))
        for px,py in pxl[:n]: canvas[py,px]=arr[py,px]
        if pr<1 and pxl:
            # Smooth over last 20 pixels for stable hand position
            w=pxl[max(0,n-20):n]
            hx=sum(p[0] for p in w)/len(w)
            hy=sum(p[1] for p in w)/len(w)
    img=Image.fromarray(canvas.copy())
    if hx is not None and f<last_draw:
        px_i=int(hx-TIP_OFFSET_X)
        py_i=int(hy-TIP_OFFSET_Y)
        px_i=max(0,min(W-HAND_SIZE,px_i))
        py_i=max(0,min(H-HAND_SIZE,py_i))
        img_rgba=img.convert('RGBA')
        img_rgba.paste(hand,(px_i,py_i),hand)
        img=img_rgba.convert('RGB')
    img.save(f'${frameDir}/fr{f:04d}.jpg',quality=95)
print(f'done:{total_frames}')
`;
        fs.writeFileSync(pyScript, pyCode);
        const pyOut = execFileSync('python3', [pyScript], { timeout: 600000, encoding: 'utf8' });
        const totalFrames = parseInt((pyOut.match(/done:(\d+)/) || [,'150'])[1]);
        execSync('"' + ffmpegPath + '" -y -framerate 25 -i "' + path.join(frameDir,'fr%04d.jpg') + '" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p "' + clip + '"', { timeout: 300000 });
        try { fs.rmSync(frameDir, { recursive:true, force:true }); } catch(e) {}
        console.log('Scene', i+1, '/' + imageUrls.length, 'done (' + totalFrames + ' frames)');

      } else {
        // FFmpeg wipe fallback
        const tr = ['wipeleft','wipedown','wiperight','wipetl'][i%4];
        const rd = Math.min(3.5, perScene-2);
        const fc = "[0:v]format=yuv420p[w];[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,format=yuv420p[im];[w][im]xfade=transition="+tr+":duration="+rd+":offset=0.3,format=yuv420p[wipe];[2:v]scale=140:140[hand];[wipe][hand]overlay=x='if(lt(t,"+rd+"),(t/"+rd+")*1100,1100)':y=270,format=yuv420p[out]";
        execSync('"'+ffmpegPath+'" -y -f lavfi -i "color=white:s=1280x720:d='+perScene+':r=25" -loop 1 -t '+perScene+' -i "'+imgPath+'" -loop 1 -i "'+handPath+'" -filter_complex "'+fc+'" -map "[out]" -t '+perScene+' -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p "'+clip+'"', { timeout:120000 });
        console.log('Scene', i+1, 'FFmpeg fallback');
      }
      sceneClips.push(clip);
    }

    // Voiceover already generated above in audio-first step

    // Concat scenes
    const listFile = path.join(tempDir,'list.txt');
    fs.writeFileSync(listFile, sceneClips.map(f=>"file '"+f+"'").join('\n'));
    const stitched = path.join(tempDir,'stitched.mp4');
    execSync('"'+ffmpegPath+'" -f concat -safe 0 -i "'+listFile+'" -c copy "'+stitched+'" -y', {timeout:120000});

    // Mux pre-generated audio with video
    // Since perScene = audioDuration/numScenes, video and audio match perfectly
    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir,'final.mp4');
      execSync('"'+ffmpegPath+'" -i "'+stitched+'" -i "'+audioFile+'" -map 0:v -map 1:a -c:v copy -c:a aac "'+withAudio+'" -y', {timeout:120000});
      console.log('Video+audio muxed. Video:', (perScene*numScenes).toFixed(2)+'s Audio:', audioDuration.toFixed(2)+'s');
      finalPath = withAudio;
    }

    // Save to outputStore (bypasses 30s HTTP timeout)
    const videoId = 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const outputPath = path.join(os.tmpdir(), videoId+'.mp4');
    fs.copyFileSync(finalPath, outputPath);
    const fileSize = fs.statSync(outputPath).size;
    outputStore[videoId] = { path:outputPath, size:fileSize, created:Date.now() };
    console.log('Whiteboard v8.28.0 ready:', fileSize, 'bytes, id:', videoId);
    res.json({ videoId, downloadUrl:'/api/video/'+videoId, size:fileSize, scenes:imageUrls.length });

  } catch(e) {
    console.error('Whiteboard v8.28.0 error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir,{recursive:true,force:true}); } catch(e) {}
  }
});

// ===== ANIMATED SLIDES (Path A: code-rendered, brand-palette driven) =====
// Two endpoints:
//   POST /api/brand/extract-colors  -> derive a 7-slot palette from a logo (base64) or website
//   POST /api/slides/animate        -> render designed animated slides to MP4

// Helper: write a temp file from a base64 data URL or raw base64
function writeB64(b64, p) {
  const data = b64.includes(',') ? b64.split(',')[1] : b64;
  fs.writeFileSync(p, Buffer.from(data, 'base64'));
}

// ---- Brand color extraction ----
app.post('/api/brand/extract-colors', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-brand-'));
  try {
    const { logoBase64, website } = req.body;
    // Default palette (used if no logo and no usable website colors)
    const DEFAULT = { bg_dark:'#0B1F3A', bg_mid:'#10314F', accent:'#3B82F6',
      accent2:'#2563EB', text:'#FFFFFF', text_soft:'#BFD4EA', ink:'#0B1F3A' };

    if (logoBase64) {
      const logoPath = path.join(tempDir, 'logo.png');
      writeB64(logoBase64, logoPath);
      const py = path.join(tempDir, 'extract.py');
      fs.writeFileSync(py, `
import json, colorsys
from PIL import Image
def lum(c): r,g,b=[x/255 for x in c]; return 0.2126*r+0.7152*g+0.0722*b
def sat(c): return colorsys.rgb_to_hsv(*[x/255 for x in c])[1]
def hexs(c): return '#%02X%02X%02X'%tuple(int(x) for x in c)
def mix(a,b,t): return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))
im=Image.open(${JSON.stringify(logoPath)}).convert('RGBA')
bg=Image.new('RGBA',im.size,(255,255,255,255)); bg.alpha_composite(im); im=bg.convert('RGB')
q=im.quantize(colors=8,method=Image.MEDIANCUT).convert('RGB')
colors=q.getcolors(im.size[0]*im.size[1]); colors.sort(reverse=True)
allc=[c for _,c in colors]
hues=[c for _,c in colors if 0.15<lum(c)<0.92 and sat(c)>0.25]
accent=max(hues,key=sat) if hues else max(allc,key=sat)
others=[c for c in hues if c!=accent]
accent2=others[0] if others else tuple(min(255,int(x*0.8)) for x in accent)
dark=min(allc,key=lum)
if lum(dark)>0.3:
    h,s,v=colorsys.rgb_to_hsv(*[x/255 for x in accent]); dark=tuple(int(x*255) for x in colorsys.hsv_to_rgb(h,min(1,s+0.2),0.16))
pal={'bg_dark':hexs(dark),'bg_mid':hexs(mix(dark,(255,255,255),0.10)),
 'accent':hexs(accent),'accent2':hexs(accent2),'text':'#FFFFFF',
 'text_soft':hexs(mix((255,255,255),accent,0.25)),'ink':hexs(dark)}
print(json.dumps(pal))
`);
      const out = execFileSync('python3', [py], { timeout: 30000, encoding: 'utf8' });
      const pal = JSON.parse(out.trim());
      console.log('Brand colors extracted from logo:', pal.accent, pal.bg_dark);
      return res.json({ palette: pal, source: 'logo' });
    }

    // No logo: return default (website scraping can be added later)
    console.log('Brand colors: no logo provided, returning default palette');
    return res.json({ palette: DEFAULT, source: 'default', website: website || null });
  } catch (e) {
    console.error('extract-colors error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir, { recursive:true, force:true }); } catch(e) {}
  }
});

// ════════════════ HEYGEN TALKING AVATAR (Option A) ════════════════
// List avatars from the connected HeyGen account
app.get('/api/heygen/avatars', async (req, res) => {
  if (!HEYGEN_KEY) return res.json({ configured: false, avatars: [] });
  try {
    const r = await fetch('https://api.heygen.com/v2/avatars', {
      headers: { 'X-Api-Key': HEYGEN_KEY, 'Accept': 'application/json' }
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'HeyGen avatars failed (' + r.status + ')', detail: t.slice(0, 200) });
    }
    const data = await r.json();
    const raw = (data && data.data && data.data.avatars) || [];
    const avatars = raw.map(a => ({
      id: a.avatar_id,
      name: a.avatar_name || a.avatar_id,
      gender: (a.gender || 'unknown').toLowerCase(),
      photo: a.preview_image_url || null,
      previewVideo: a.preview_video_url || null,
      premium: !!a.premium
    })).filter(a => a.photo);
    res.json({ configured: true, count: avatars.length, avatars });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start a talking-avatar video generation
// Cache HeyGen voices; pick a valid default voice id
let _heygenVoices = null;
async function getHeyGenVoiceId(preferGender) {
  try {
    if (!_heygenVoices) {
      const vr = await fetch('https://api.heygen.com/v2/voices', { headers: { 'X-Api-Key': HEYGEN_KEY } });
      if (vr.ok) {
        const vd = await vr.json();
        _heygenVoices = (vd && vd.data && vd.data.voices) || [];
      } else { _heygenVoices = []; }
    }
    if (!_heygenVoices.length) return null;
    // prefer an English voice, optionally matching gender
    const eng = _heygenVoices.filter(v => (v.language || '').toLowerCase().includes('english'));
    const pool = eng.length ? eng : _heygenVoices;
    const byGender = preferGender ? pool.filter(v => (v.gender || '').toLowerCase() === preferGender) : [];
    const pick = (byGender.length ? byGender : pool)[0];
    return pick ? pick.voice_id : null;
  } catch (e) { return null; }
}

app.post('/api/heygen/generate', async (req, res) => {
  if (!HEYGEN_KEY) return res.status(400).json({ error: 'HeyGen not configured' });
  try {
    let { avatarId, script, aspect, gender } = req.body;
    if (!avatarId || !script) return res.status(400).json({ error: 'avatarId and script are required' });
    const dim = (aspect === 'vertical') ? { width: 720, height: 1280 }
              : (aspect === 'square') ? { width: 1080, height: 1080 }
              : { width: 1280, height: 720 };
    // HeyGen needs ITS OWN voice id (not ElevenLabs). Fetch a valid one.
    const hgVoice = await getHeyGenVoiceId((gender || '').toLowerCase());
    if (!hgVoice) return res.status(502).json({ error: 'No HeyGen voice available on this account' });
    const body = {
      video_inputs: [{
        character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
        voice: { type: 'text', input_text: script, voice_id: hgVoice },
        background: { type: 'color', value: '#0B1F3A' }
      }],
      dimension: dim
    };
    const r = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    const vidId = data && data.data && data.data.video_id;
    if (!r.ok || !vidId) {
      const detail = (data && (data.error || data.message)) ? JSON.stringify(data.error || data.message) : JSON.stringify(data).slice(0, 300);
      console.log('HeyGen generate error:', detail);
      return res.status(502).json({ error: 'HeyGen generate failed: ' + detail });
    }
    res.json({ videoId: vidId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll generation status; when done, download the MP4 and return inline (if small) + a local id
app.get('/api/heygen/status/:id', async (req, res) => {
  if (!HEYGEN_KEY) return res.status(400).json({ error: 'HeyGen not configured' });
  try {
    const r = await fetch('https://api.heygen.com/v1/video_status.get?video_id=' + encodeURIComponent(req.params.id), {
      headers: { 'X-Api-Key': HEYGEN_KEY }
    });
    const data = await r.json();
    const d = (data && data.data) || {};
    const status = d.status || 'unknown';
    // HeyGen may put the URL in different fields depending on API version
    const videoUrl = d.video_url || d.video_url_caption || (d.video && d.video.url) || null;
    if (status === 'completed') {
      if (!videoUrl) {
        // completed but no URL yet — tell client to keep polling briefly
        return res.json({ status: 'processing', note: 'finalizing' });
      }
      // Try to download for a stable local copy, but DON'T let a slow download hang forever.
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 60000);
        const vr = await fetch(videoUrl, { signal: ctrl.signal });
        clearTimeout(to);
        const buf = Buffer.from(await vr.arrayBuffer());
        const vid = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const fp = path.join(os.tmpdir(), vid + '.mp4');
        fs.writeFileSync(fp, buf);
        outputStore[vid] = { path: fp, size: buf.length, created: Date.now() };
        let videoData = null;
        if (buf.length < 20 * 1024 * 1024) videoData = 'data:video/mp4;base64,' + buf.toString('base64');
        return res.json({ status: 'completed', videoId: vid, size: buf.length, videoData, heygenUrl: videoUrl });
      } catch (dlErr) {
        // download slow/failed — still give the client the playable HeyGen URL so it's never stuck
        return res.json({ status: 'completed', heygenUrl: videoUrl });
      }
    }
    if (status === 'failed') return res.json({ status: 'failed', error: (d.error && d.error.message) || 'generation failed' });
    res.json({ status: status }); // processing | pending | waiting
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Stock footage preview: returns candidate clips per scene for review/replace ----
app.post('/api/stock/preview', async (req, res) => {
  try {
    if (!PEXELS_KEY) return res.json({ configured: false, scenes: [] });
    let { queries, aspect } = req.body; // queries: array of strings (one per scene)
    if (!Array.isArray(queries) || !queries.length) return res.status(400).json({ error: 'No queries' });
    const orient = (aspect === 'vertical') ? 'portrait' : (aspect === 'square') ? 'square' : 'landscape';
    const scenes = [];
    for (let i = 0; i < queries.length; i++) {
      const q = (queries[i] || '').toString().trim() || 'abstract background';
      // eslint-disable-next-line no-await-in-loop
      const candidates = await searchPexelsCandidates(q, orient, 6);
      scenes.push({ index: i, query: q, candidates: candidates });
    }
    res.json({ configured: true, scenes: scenes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Animated Slides renderer ----
app.post('/api/slides/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-slides-'));
  try {
    let { slides, palette, durationSecs, aspect, musicBase64, musicTrack, audioMode, voiceId, voiceSync, videoType, stockMode } = req.body;
    if (!slides || !slides.length) return res.status(400).json({ error: 'No slides provided' });
    durationSecs = Math.max(4, Math.min(120, parseInt(durationSecs || '20')));
    const PAL = palette || { bg_dark:'#0B1F3A', bg_mid:'#10314F', accent:'#3B82F6',
      accent2:'#2563EB', text:'#FFFFFF', text_soft:'#BFD4EA', ink:'#0B1F3A' };
    const [W, H] = (aspect === 'vertical') ? [1080, 1920] : (aspect === 'square') ? [1080, 1080] : [1280, 720];
    console.log('Slides v8.48.0:', slides.length, (videoType||'slides'), W+'x'+H, audioMode||'music', 'stock='+(stockMode||'none'), 'pythonReady='+pythonReady);

    // ── AUDIO-FIRST (voice mode): generate per-slide voiceover, measure each, time slides to it ──
    let audioFile = null;
    let perSlideSecs = null; // array of seconds per slide when voice-synced
    if (audioMode === 'voice' && voiceSync && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const wavFiles = [];
        perSlideSecs = [];
        // We write WAV as PCM s16le, 44100 Hz, stereo => exactly 176400 bytes/sec.
        // Duration = (fileSize - 44-byte header) / 176400. No ffprobe needed (Render lacks it).
        const WAV_BYTES_PER_SEC = 44100 * 2 * 2; // 176400
        const PAUSE = 0.6; // seconds of silence appended after each slide's narration
        for (let i = 0; i < slides.length; i++) {
          const vt = (slides[i].voiceText || (slides[i].blocks||[]).map(b=>b.text).join('. ') || 'slide').toString().substring(0,300);
          const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+vid, {
            method:'POST',
            headers:{'xi-api-key':ELEVENLABS_KEY,'Content-Type':'application/json'},
            body:JSON.stringify({ text: vt, model_id:'eleven_turbo_v2', voice_settings:{stability:0.5,similarity_boost:0.75} })
          });
          if (!vr.ok) throw new Error('TTS failed '+vr.status);
          const mp3 = path.join(tempDir, 'v'+i+'.mp3');
          fs.writeFileSync(mp3, Buffer.from(await vr.arrayBuffer()));
          // Decode MP3 -> WAV at fixed rate AND append exact silence, in one pass.
          const wav = path.join(tempDir, 'v'+i+'.wav');
          execSync('"'+ffmpegPath+'" -y -i "'+mp3+'" -af "apad=pad_dur='+PAUSE+'" -ar 44100 -ac 2 -c:a pcm_s16le "'+wav+'"', {timeout:120000});
          // Measure from byte size — exact for PCM WAV, no ffprobe required
          let dur = 3.0;
          try {
            const bytes = fs.statSync(wav).size - 44;
            if (bytes > 0) dur = bytes / WAV_BYTES_PER_SEC;
          } catch(e) {}
          perSlideSecs.push(dur);
          wavFiles.push(wav);
        }
        // Concatenate WAVs losslessly (sample-accurate), then encode AAC once.
        const listFile = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(listFile, wavFiles.map(f=>"file '"+f+"'").join('\n'));
        const joinedWav = path.join(tempDir, 'voice_joined.wav');
        execSync('"'+ffmpegPath+'" -y -f concat -safe 0 -i "'+listFile+'" -c copy "'+joinedWav+'"', {timeout:120000});
        audioFile = path.join(tempDir, 'voice.m4a');
        execSync('"'+ffmpegPath+'" -y -i "'+joinedWav+'" -c:a aac -b:a 192k "'+audioFile+'"', {timeout:120000});
        durationSecs = perSlideSecs.reduce((a,b)=>a+b, 0);
        console.log('Voice-synced: per-slide secs', perSlideSecs.map(s=>s.toFixed(2)).join(','), 'total', durationSecs.toFixed(2));
      } catch(e) {
        console.log('Voice generation failed, falling back to timed slides:', e.message);
        audioFile = null; perSlideSecs = null;
      }
    }

    // ══ STOCK-FOOTAGE BRANCH (Faceless): real Pexels clips behind captions ══
    // Brand-agnostic: uses each scene's own stockQuery. Falls through to the
    // normal animated renderer if no key, no clips, or anything goes wrong.
    if (stockMode === 'auto' && PEXELS_KEY) {
      try {
        const orient = (aspect === 'vertical') ? 'portrait' : (aspect === 'square') ? 'square' : 'landscape';
        const nScenes = slides.length;
        // per-scene seconds (respect voice-synced timing if present)
        const secsArr = (perSlideSecs && perSlideSecs.length === nScenes)
          ? perSlideSecs.slice()
          : new Array(nScenes).fill(durationSecs / nScenes);
        // 1) fetch clips (use user-chosen clip URL if provided, else search by query)
        const clipPaths = [];
        for (let i = 0; i < nScenes; i++) {
          const chosen = slides[i] && slides[i].chosenClipUrl ? slides[i].chosenClipUrl : null;
          const q = (slides[i] && (slides[i].stockQuery || (slides[i].blocks && slides[i].blocks[0] && slides[i].blocks[0].text))) || 'abstract background';
          // eslint-disable-next-line no-await-in-loop
          const cp = await fetchPexelsClip(q, orient, tempDir, i, chosen);
          clipPaths.push(cp);
        }
        const gotAny = clipPaths.some(Boolean);
        if (!gotAny) throw new Error('no stock clips downloaded — using animated fallback');

        // 2) render a transparent caption overlay PNG per scene (captions + corner shapes only)
        const ovDir = path.join(tempDir, 'ov');
        fs.mkdirSync(ovDir, { recursive: true });
        const ovPy = path.join(tempDir, 'overlays.py');
        fs.writeFileSync(ovPy, `
import json, glob, os
from PIL import Image, ImageDraw, ImageFont
W,H=${W},${H}
PAL=json.loads(${JSON.stringify(JSON.stringify(PAL))})
SLIDES=json.loads(${JSON.stringify(JSON.stringify(slides))})
OV=${JSON.stringify(ovDir)}
def ff(*names):
    allf=glob.glob('/usr/share/fonts/**/*.ttf',recursive=True)
    for n in names:
        for f in allf:
            if n.lower() in os.path.basename(f).lower(): return f
    return allf[0] if allf else None
FB=ff('DejaVuSans-Bold','LiberationSans-Bold','Bold')
FR=ff('DejaVuSans','LiberationSans-Regular','Regular')
def font(p,s):
    try: return ImageFont.truetype(p,max(8,int(s)))
    except: return ImageFont.load_default()
def hx(h):
    h=str(h).lstrip('#')
    if len(h)!=6: h='FFFFFF'
    return tuple(int(h[i:i+2],16) for i in (0,2,4))
def col(spec,key,default):
    v=spec.get(key,default); v=PAL.get(v,v)
    return hx(v if str(v).startswith('#') else PAL.get(default,'#FFFFFF'))
def wrap(d,text,fnt,maxw):
    words=text.split(); lines=[]; cur=''
    for w in words:
        t=(cur+' '+w).strip()
        if d.textlength(t,font=fnt)<=maxw: cur=t
        else:
            if cur: lines.append(cur)
            cur=w
    if cur: lines.append(cur)
    return lines
for idx,s in enumerate(SLIDES):
    img=Image.new('RGBA',(W,H),(0,0,0,0))
    d=ImageDraw.Draw(img)
    # Build all blocks first (wrapped), then stack them as ONE centered group so they never overlap
    blocks=[]
    for b in s.get('blocks',[]):
        txt=b.get('text','')
        if not txt: continue
        size=b.get('size',0.08); fs=max(20,int(size*(W if H>W else H)))
        weight=b.get('weight','bold')
        fnt=font(FB if weight=='bold' else FR, fs)
        lines=wrap(d,txt,fnt,int(W*0.82))
        lh=fs*1.25
        c=col(b,'color','text')
        blocks.append({'lines':lines,'fnt':fnt,'fs':fs,'lh':lh,'c':c,'h':lh*len(lines)})
    if blocks:
        gap=int((H if H>=W else W)*0.03)  # space between blocks
        group_h=sum(bl['h'] for bl in blocks)+gap*(len(blocks)-1)
        # center the whole group vertically around 0.46 of the frame (slightly above middle)
        y=int(H*0.46)-group_h/2
        for bl in blocks:
            tc=bl['c']
            # brighten very dark text colors so they stay readable on darkened footage
            if (0.2126*tc[0]+0.7152*tc[1]+0.0722*tc[2])/255.0 < 0.35:
                tc=tuple(min(255,int(v*1.6)+60) for v in tc)
            for ln in bl['lines']:
                fnt=bl['fnt']; fs=bl['fs']; lh=bl['lh']
                tw=d.textlength(ln,font=fnt); x=(W-tw)/2
                pad=fs*0.30
                # stronger semi-opaque panel for guaranteed contrast over any footage
                d.rectangle([x-pad,y-pad*0.45,x+tw+pad,y+lh-pad*0.15],fill=(0,0,0,175))
                d.text((x+2,y+2),ln,font=fnt,fill=(0,0,0,230))
                d.text((x,y),ln,font=fnt,fill=tc+(255,))
                y+=lh
            y+=gap
    img.save(os.path.join(OV,'ov%02d.png'%idx))
print('overlays',len(SLIDES))
`);
        execSync('python3 "' + ovPy + '"', { timeout: 120000 });

        // 3) per-scene: trim/scale/crop clip to WxH, darken, overlay caption PNG
        const sceneClips = [];
        for (let i = 0; i < nScenes; i++) {
          const secs = Math.max(2, secsArr[i] || 3.5);
          const ovPng = path.join(ovDir, 'ov' + String(i).padStart(2, '0') + '.png');
          const outClip = path.join(tempDir, 'sc' + i + '.mp4');
          const src = clipPaths[i];
          if (src) {
            // scale to cover WxH, crop center, darken, force uniform fps+sar+format so concat is seamless
            const vf = "scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + ",eq=brightness=-0.10:saturation=1.05,fps=30,setsar=1";
            execSync('"' + ffmpegPath + '" -y -stream_loop -1 -t ' + secs.toFixed(2) + ' -i "' + src + '" -i "' + ovPng + '" -filter_complex "[0:v]' + vf + '[bg];[bg][1:v]overlay=0:0:format=auto,format=yuv420p[out]" -map "[out]" -t ' + secs.toFixed(2) + ' -r 30 -vsync cfr -an -c:v libx264 -preset ultrafast -threads 1 -x264-params "rc-lookahead=10:sync-lookahead=0:bframes=0:ref=1:sliced-threads=0" -crf 23 -pix_fmt yuv420p "' + outClip + '"', { timeout: 180000 });
          } else {
            // no clip for this scene: solid brand-color bg + caption (graceful)
            const bgc = (PAL.bg_dark || '#0B1F3A').replace('#','0x');
            execSync('"' + ffmpegPath + '" -y -f lavfi -t ' + secs.toFixed(2) + ' -i "color=c=' + bgc + ':s=' + W + 'x' + H + ':r=30" -i "' + ovPng + '" -filter_complex "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p,setsar=1[out]" -map "[out]" -t ' + secs.toFixed(2) + ' -r 30 -vsync cfr -an -c:v libx264 -preset ultrafast -threads 1 -crf 23 -pix_fmt yuv420p "' + outClip + '"', { timeout: 120000 });
          }
          sceneClips.push(outClip);
        }

        // 4) concat all scene clips
        const listF = path.join(tempDir, 'stock_concat.txt');
        fs.writeFileSync(listF, sceneClips.map(f => "file '" + f + "'").join('\n'));
        const stitchedV = path.join(tempDir, 'stock_stitched.mp4');
        execSync('"' + ffmpegPath + '" -y -f concat -safe 0 -i "' + listF + '" -c:v libx264 -preset ultrafast -threads 1 -x264-params "rc-lookahead=10:sync-lookahead=0:bframes=0:ref=1:sliced-threads=0" -crf 24 -r 30 -pix_fmt yuv420p "' + stitchedV + '"', { timeout: 240000 });

        // 5) audio: voice (already built) or music track/upload
        let finalV = stitchedV;
        let muxAudioPath = null;
        if (audioFile) {
          muxAudioPath = audioFile;
        } else if (musicBase64) {
          muxAudioPath = path.join(tempDir, 'music_in.mp3');
          fs.writeFileSync(muxAudioPath, Buffer.from(musicBase64.split(',').pop(), 'base64'));
        } else if (musicTrack) {
          const cand = [path.join(__dirname, musicTrack + '.mp3'), path.join(__dirname, 'music', musicTrack + '.mp3')];
          muxAudioPath = cand.find(p => { try { return fs.existsSync(p); } catch(e){ return false; } }) || null;
        }
        if (muxAudioPath) {
          const withA = path.join(tempDir, 'stock_final.mp4');
          execSync('"' + ffmpegPath + '" -y -stream_loop -1 -i "' + muxAudioPath + '" -i "' + stitchedV + '" -map 1:v -map 0:a -c:v copy -c:a aac -b:a 192k -shortest "' + withA + '" -y', { timeout: 120000 });
          finalV = withA;
        }

        // 6) store + return (inline if small enough)
        const vid = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const finalPath = path.join(os.tmpdir(), vid + '.mp4');
        fs.copyFileSync(finalV, finalPath);
        const sz = fs.statSync(finalPath).size;
        outputStore[vid] = { path: finalPath, size: sz, created: Date.now() };
        let videoData = null;
        if (sz < 20 * 1024 * 1024) {
          videoData = 'data:video/mp4;base64,' + fs.readFileSync(finalPath).toString('base64');
        }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
        console.log('Faceless stock video ready', vid, Math.round(sz/1024) + 'KB', clipPaths.filter(Boolean).length + '/' + nScenes + ' clips');
        return res.json({ videoId: vid, size: sz, videoData: videoData, stock: true });
      } catch (stockErr) {
        console.log('Stock-footage path failed, falling back to animated:', stockErr.message);
        // fall through to normal renderer below
      }
    }

    const frameDir = path.join(tempDir, 'frames');
    fs.mkdirSync(frameDir, { recursive:true });
    const py = path.join(tempDir, 'slides.py');
    fs.writeFileSync(py, `
import os, glob, json, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter
W,H,FPS=${W},${H},30
PAL=json.loads(${JSON.stringify(JSON.stringify(PAL))})
SLIDES=json.loads(${JSON.stringify(JSON.stringify(slides))})
TOTAL=${durationSecs}
PER_SLIDE=json.loads(${JSON.stringify(JSON.stringify(perSlideSecs))})
FRAME_DIR=${JSON.stringify(frameDir)}
def ff(*names):
    allf=glob.glob('/usr/share/fonts/**/*.ttf',recursive=True)
    for n in names:
        for f in allf:
            if n.lower() in os.path.basename(f).lower(): return f
    return allf[0] if allf else None
FB=ff('DejaVuSans-Bold','LiberationSans-Bold','Bold')
FR=ff('DejaVuSans','LiberationSans-Regular','Regular')
FS=ff('DejaVuSerif-Bold','LiberationSerif-Bold','Serif')
def font(p,s):
    try: return ImageFont.truetype(p,max(8,int(s)))
    except: return ImageFont.load_default()
def ease(t): return 4*t*t*t if t<0.5 else 1-((-2*t+2)**3)/2
def lerp(a,b,t): return a+(b-a)*t
def hx(h):
    h=str(h).lstrip('#')
    if len(h)!=6: h='0B1F3A'
    return tuple(int(h[i:i+2],16) for i in (0,2,4))
def col(spec,key,default):
    v=spec.get(key,default); v=PAL.get(v,v)
    return hx(v if str(v).startswith('#') else PAL.get(default,'#FFFFFF'))
def lum_rgb(c):
    return (0.2126*c[0]+0.7152*c[1]+0.0722*c[2])/255.0
def vgrad(d,c1,c2):
    for y in range(H):
        ty=y/H; d.line([(0,y),(W,y)],fill=tuple(int(lerp(c1[i],c2[i],ty)) for i in range(3)))
def hgrad(d,c1,c2):
    for x in range(0,W,2):
        tx=x/W; d.line([(x,0),(x,H)],fill=tuple(int(lerp(c1[i],c2[i],tx)) for i in range(3)),width=2)
def paint_bg(img,spec,t):
    d=ImageDraw.Draw(img); kind=spec.get('type','solid')
    if kind=='gradient':
        c1,c2=col(spec,'from','bg_mid'),col(spec,'to','bg_dark')
        if spec.get('dir')=='horizontal': hgrad(d,c1,c2)
        else: vgrad(d,c1,c2)
    elif kind=='split':
        # solid base + a large color block on one side (modern, professional)
        base=col(spec,'color','bg_dark'); block=col(spec,'block','bg_mid')
        d.rectangle([0,0,W,H],fill=base)
        side=spec.get('side','left'); frac=spec.get('frac',0.38)
        if side=='left': d.rectangle([0,0,int(W*frac),H],fill=block)
        elif side=='right': d.rectangle([int(W*(1-frac)),0,W,H],fill=block)
        elif side=='top': d.rectangle([0,0,W,int(H*frac)],fill=block)
        else: d.rectangle([0,int(H*(1-frac)),W,H],fill=block)
    elif kind=='diagonal':
        base=col(spec,'color','bg_dark'); block=col(spec,'block','bg_mid')
        d.rectangle([0,0,W,H],fill=base)
        d.polygon([(0,H),(W,0),(W,H)],fill=block)
    else:
        d.rectangle([0,0,W,H],fill=col(spec,'color','bg_dark'))
    # ── shapes: bold entrance (first 35%) THEN continuous subtle drift/float entire slide ──
    for si,sh in enumerate(spec.get('shapes',[])):
        c=col(sh,'color','accent'); anim=sh.get('anim','float')
        e=ease(min(1.0, t/0.35))            # entrance progress (settles by 35%)
        bx,by=sh.get('x',0.5),sh.get('y',0.5)
        # ── Auto-keep large shapes OUT of the central text zone (guaranteed readability) ──
        kind=sh.get('kind','circle'); rr=sh.get('r',0.1)
        if kind in ('circle','ring') and rr>0.09:
            # text band is x:0.18-0.82, y:0.25-0.75; if center is inside, push to nearest side
            if 0.10 < bx < 0.90:
                bx = 0.90 if bx >= 0.5 else 0.10
            if 0.20 < by < 0.80 and not (bx<=0.12 or bx>=0.88):
                by = 0.85 if by >= 0.5 else 0.15
        x,y=bx,by; scale=1.0
        # entrance
        if anim=='slidein': x=lerp(bx-0.12, bx, e)
        elif anim=='grow':  scale=lerp(0.3,1.0,e)
        elif anim=='dropin':y=lerp(by-0.12, by, e)
        # continuous drift for the WHOLE slide (gentle sine float, phase offset per shape)
        ph=si*1.7
        x += 0.012*math.sin(2*math.pi*(t*0.6)+ph)
        y += 0.018*math.cos(2*math.pi*(t*0.5)+ph)
        op=int(210*min(1.0,e+0.1))
        if sh.get('kind')=='circle':
            r=int(sh.get('r',0.1)*W*scale); cx,cy=int(x*W),int(y*H)
            d=r*2+4; tile=Image.new('RGBA',(d,d),(0,0,0,0)); td=ImageDraw.Draw(tile)
            td.ellipse([2,2,2+r*2,2+r*2],fill=c+(op,))
            img.alpha_composite(tile,(cx-r-2,cy-r-2))
        elif sh.get('kind')=='ring':
            r=int(sh.get('r',0.1)*W*scale); cx,cy=int(x*W),int(y*H); wd=max(4,int(r*0.16))
            d=r*2+4; tile=Image.new('RGBA',(d,d),(0,0,0,0)); td=ImageDraw.Draw(tile)
            td.ellipse([2,2,2+r*2,2+r*2],outline=c+(op,),width=wd)
            img.alpha_composite(tile,(cx-r-2,cy-r-2))
        elif sh.get('kind')=='bar':
            bw=int(sh.get('w',0.2)*W*scale); bh=max(1,int(sh.get('h',0.02)*H)); bxp,byp=int(x*W),int(y*H)
            tile=Image.new('RGBA',(max(1,bw),max(1,bh)),c+(op,))
            img.alpha_composite(tile,(bxp,byp))
def bg_lum_at(spec, fx, fy):
    # Estimate background brightness at a point WITHOUT reading pixels (fast).
    kind=spec.get('type','solid')
    if kind=='gradient':
        c1=col(spec,'from','bg_mid'); c2=col(spec,'to','bg_dark')
        tt = fy if spec.get('dir')!='horizontal' else fx
        mix=tuple(c1[i]+(c2[i]-c1[i])*tt for i in range(3))
        return lum_rgb(mix)
    if kind=='split':
        side=spec.get('side','left'); frac=spec.get('frac',0.38)
        inblock = (side=='left' and fx<frac) or (side=='right' and fx>1-frac) or (side=='top' and fy<frac) or (side=='bottom' and fy>1-frac)
        return lum_rgb(col(spec,'block','bg_mid')) if inblock else lum_rgb(col(spec,'color','bg_dark'))
    if kind=='diagonal':
        # block fills lower-right triangle (x+y > 1-ish); approximate
        return lum_rgb(col(spec,'block','bg_mid')) if (fx+fy)>1.0 else lum_rgb(col(spec,'color','bg_dark'))
    return lum_rgb(col(spec,'color','bg_dark'))
def fix_contrast(blocks, spec):
    # Decide each block's final text color ONCE (not per frame) for speed + readability.
    for b in blocks:
        c=col(b,'color','text')
        bl=bg_lum_at(spec, b.get('x',0.5), b.get('y',0.5))
        if abs(bl - lum_rgb(c)) < 0.35:
            b['_forceColor'] = '#FFFFFF' if bl < 0.5 else '#0F0F0F'
    return blocks
def draw_block(base,blk,prog):
    txt=str(blk.get('text','')); REF=min(W,H); size=int(blk.get('size',0.08)*REF)
    if blk.get('_forceColor'): c=hx(blk['_forceColor'])
    else: c=col(blk,'color','text')
    fp={'bold':FB,'serif':FS}.get(blk.get('weight'),FR)
    anim=blk.get('anim','fade'); shown=txt
    if anim=='type': shown=txt[:max(0,int(len(txt)*prog))]
    f=font(fp,size)
    _m=Image.new('RGBA',(1,1)); ld=ImageDraw.Draw(_m)
    maxw=int(W*0.86); bb=ld.textbbox((0,0),txt or ' ',font=f)
    while (bb[2]-bb[0])>maxw and size>10:
        size=int(size*0.92); f=font(fp,size); bb=ld.textbbox((0,0),txt or ' ',font=f)
    bb=ld.textbbox((0,0),shown or ' ',font=f); tw,th=bb[2]-bb[0],bb[3]-bb[1]
    cx,cy=int(blk.get('x',0.5)*W),int(blk.get('y',0.5)*H); align=blk.get('align','center')
    x=cx-tw//2 if align=='center' else (cx if align=='left' else cx-tw); y=cy-th//2
    e=ease(min(1,prog)) if anim!='type' else 1.0; dx=dy=0; a=1.0
    if anim=='fade': a=e
    elif anim=='rise': dy=int(lerp(0.05*H,0,e)); a=e
    elif anim=='slide': dx=int(lerp(-0.06*W,0,e)); a=e
    elif anim=='dropin': dy=int(lerp(-0.08*H,0,e)); a=e
    elif anim=='zoom':
        f=font(fp,max(8,int(size*lerp(1.4,1.0,e)))); a=e
        bb=ld.textbbox((0,0),shown or ' ',font=f); tw,th=bb[2]-bb[0],bb[3]-bb[1]; x=cx-tw//2 if align=='center' else (cx if align=='left' else cx-tw); y=cy-th//2
    elif anim=='pop':
        f=font(fp,max(8,int(size*lerp(0.6,1,e)))); a=e
        bb=ld.textbbox((0,0),shown or ' ',font=f); tw,th=bb[2]-bb[0],bb[3]-bb[1]; x=cx-tw//2 if align=='center' else (cx if align=='left' else cx-tw); y=cy-th//2
    # ── Draw everything onto a SMALL tile sized to the text (memory-light for vertical) ──
    sh_off=max(2,int(REF*0.006))
    padx,pady=int(REF*0.035),int(REF*0.03)
    margin=padx+sh_off*3
    tw2=max(1,tw+margin*2); th2=max(1,th+margin*2)
    tile=Image.new('RGBA',(tw2,th2),(0,0,0,0)); tl=ImageDraw.Draw(tile)
    # local coords: text origin inside tile
    lx=margin-bb[0]; ly=margin-bb[1]
    # panel behind text (shadow + card)
    if a>0.05:
        tl.rounded_rectangle([margin-padx+sh_off*2, margin-pady+sh_off*2, margin+tw+padx+sh_off*2, margin+th+pady+sh_off*2],
                             radius=int(REF*0.025), fill=(0,0,0,int(45*a)))
        tl.rounded_rectangle([margin-padx, margin-pady, margin+tw+padx, margin+th+pady],
                             radius=int(REF*0.025), fill=(0,0,0,int(85*a)))
    # drop shadow + text
    tl.text((lx+sh_off, ly+sh_off), shown, font=f, fill=(0,0,0,int(150*a)))
    tl.text((lx, ly), shown, font=f, fill=c+(int(255*a),))
    # composite tile at the block position
    base.alpha_composite(tile, (x+dx-margin, y+dy-margin))
os.makedirs(FRAME_DIR,exist_ok=True)
# Per-slide frame counts: use voice durations if present, else equal split
if PER_SLIDE:
    slide_frames=[max(1,int(round(s*FPS))) for s in PER_SLIDE]
    # Add a small tail to the LAST slide so the video always slightly outlasts the
    # audio (prevents -shortest from clipping the final word). Cheap: just more frames.
    slide_frames[-1]=slide_frames[-1]+int(0.5*FPS)
else:
    fp_each=max(1,int((TOTAL*FPS)/len(SLIDES))); slide_frames=[fp_each]*len(SLIDES)
idx=0
def space_blocks(blocks):
    # Prevent text blocks from stacking on top of each other: if any two blocks'
    # y positions are closer than their combined height, redistribute them evenly.
    if len(blocks)<2: return blocks
    items=sorted(enumerate(blocks), key=lambda kv: kv[1].get('y',0.5))
    needs=False
    ys=[b.get('y',0.5) for b in blocks]
    for i in range(len(ys)):
        for j in range(i+1,len(ys)):
            if abs(ys[i]-ys[j]) < 0.10: needs=True
    if needs:
        n=len(blocks); top,bot=0.32,0.74
        step=(bot-top)/max(1,(n-1)) if n>1 else 0
        for k,(orig_i,b) in enumerate(items):
            b['y']=top + step*k
    return blocks
for si,spec in enumerate(SLIDES):
    spec['blocks']=space_blocks(spec.get('blocks',[]))
    spec['blocks']=fix_contrast(spec['blocks'], spec.get('bg',{}))
    fcount=slide_frames[si]; intro=max(1,int(fcount*0.35))
    for lf in range(fcount):
        t=lf/max(1,fcount)
        img=Image.new('RGBA',(W,H),(0,0,0,255)); paint_bg(img,spec.get('bg',{}),t)
        for ln in spec.get('lines',[]):
            d=ImageDraw.Draw(img); lp=min(1,lf/max(1,intro))
            x1,y1=int(ln.get('x1',0.1)*W),int(ln.get('y1',0.5)*H)
            x2=int(lerp(ln.get('x1',0.1),ln.get('x2',0.4),ease(lp))*W); y2=int(lerp(ln.get('y1',0.5),ln.get('y2',0.5),ease(lp))*H)
            d.line([x1,y1,x2,y2],fill=col(ln,'color','accent'),width=max(2,int(ln.get('w',0.008)*W)))
        for blk in spec.get('blocks',[]):
            delay=blk.get('delay',0); span=max(1,intro*(1-delay)); prog=max(0,min(1,(lf-intro*delay)/span))
            draw_block(img,blk,prog)
        img.convert('RGB').save(f'{FRAME_DIR}/fr{idx:05d}.jpg',quality=92); idx+=1
print(f'done:{idx}')
`);
    execFileSync('python3', [py], { timeout: 600000, encoding: 'utf8' });
    const silent = path.join(tempDir, 'slides.mp4');
    execSync('"'+ffmpegPath+'" -y -framerate 30 -i "'+path.join(frameDir,'fr%05d.jpg')+'" -c:v libx264 -preset ultrafast -threads 1 -x264-params "rc-lookahead=10:sync-lookahead=0:bframes=0:ref=1:sliced-threads=0" -crf 22 -pix_fmt yuv420p "'+silent+'"', { timeout:300000 });

    // ── Audio muxing ──
    let finalPath = silent;
    let muxAudio = null;
    if (audioMode === 'voice' && audioFile && fs.existsSync(audioFile)) {
      muxAudio = audioFile;
    } else if (musicBase64) {
      try { const mp = path.join(tempDir,'music_up'); writeB64(musicBase64, mp); muxAudio = mp; } catch(e){}
    } else if (musicTrack) {
      // Accept starter tracks whether they sit in the repo root OR in a music/ subfolder.
      // This way the user can just upload the mp3s directly with no folder required.
      const candidates = [
        path.join(__dirname, musicTrack + '.mp3'),
        path.join(__dirname, 'music', musicTrack + '.mp3')
      ];
      const found = candidates.find(p => { try { return fs.existsSync(p); } catch(e){ return false; } });
      if (found) muxAudio = found;
      else console.log('Starter track not found. Upload '+musicTrack+'.mp3 to the backend repo. Looked in:', candidates.join(' | '));
    }
    if (muxAudio) {
      try {
        const withAudio = path.join(tempDir, 'final.mp4');
        if (audioMode === 'voice') {
          // Video frames already match the voice length to within a frame.
          // Stream-COPY the video (no re-encode) and just add the audio — fast & light.
          // -shortest trims the ~0.01s rounding tail; nothing meaningful is lost.
          execSync('"'+ffmpegPath+'" -i "'+silent+'" -i "'+muxAudio+'" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "'+withAudio+'" -y', { timeout:120000 });
        } else {
          // Music: loop/trim music to the video length (video is the master).
          execSync('"'+ffmpegPath+'" -i "'+silent+'" -stream_loop -1 -i "'+muxAudio+'" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "'+withAudio+'" -y', { timeout:120000 });
        }
        finalPath = withAudio;
        console.log('Slides: audio muxed ('+(audioMode==='voice'?'voiceover':'music')+')');
      } catch(e) { console.log('Slides: audio mux failed, using silent:', e.message); }
    }

    const videoId = 'sl_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const outputPath = path.join(os.tmpdir(), videoId+'.mp4');
    fs.copyFileSync(finalPath, outputPath);
    const fileSize = fs.statSync(outputPath).size;
    outputStore[videoId] = { path:outputPath, size:fileSize, created:Date.now() };
    console.log('Slides v8.48.0 ready:', fileSize, 'bytes, id:', videoId);
    // Quick-fix: also return the video inline as base64 so the browser has it
    // immediately and download works even if the backend later sleeps/restarts.
    // (Skip inline for very large files to avoid memory issues; fall back to URL.)
    let videoData = null;
    try {
      if (fileSize < 8 * 1024 * 1024) { // under 8MB → safe to inline without breaking fetch/JSON
        videoData = 'data:video/mp4;base64,' + fs.readFileSync(outputPath).toString('base64');
      } else {
        console.log('Video too large to inline ('+fileSize+'B) — client will use URL fallback');
      }
    } catch(e) { console.log('Inline encode skipped:', e.message); }
    res.json({ videoId, downloadUrl:'/api/video/'+videoId, size:fileSize, slides:slides.length, videoData });

  } catch(e) {
    console.error('Slides v8.48.0 error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir,{recursive:true,force:true}); } catch(e) {}
  }
});

// ===== VOICES: ElevenLabs voice list =====
app.get('/api/voice/list', async (req, res) => {
  try {
    const r = await fetch('https://api.elevenlabs.io/v2/voices?page_size=50', {
      headers: { 'xi-api-key': ELEVENLABS_KEY }
    });
    const data = await r.json();
    const voices = data.voices || data.results || [];
    res.json({ voices: voices.map(v => ({
      voice_id: v.voice_id,
      name: v.name,
      preview_url: v.preview_url,
      labels: v.labels || {}
    }))});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== VOICE PREVIEW: proxy ElevenLabs preview audio =====
app.get('/api/voice/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: 'Preview fetch failed' });
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ===== SERVER STARTUP =====
function ensurePythonPackages() {
  try {
    execSync('python3 -c "import numpy, PIL, skimage; print(numpy.__version__)"', { timeout: 10000 });
    pythonReady = true;
    console.log('Python packages: numpy/PIL/skimage already available');
  } catch(e) {
    console.log('Installing Python packages (numpy, Pillow, scikit-image)...');
    try {
      execSync('pip3 install numpy Pillow scikit-image --quiet --break-system-packages', { timeout: 300000 });
      pythonReady = true;
      console.log('Python packages installed successfully');
    } catch(e2) {
      try {
        execSync('pip install numpy Pillow scikit-image --quiet', { timeout: 300000 });
        pythonReady = true;
        console.log('Python packages installed via pip');
      } catch(e3) {
        console.log('Python packages unavailable - FFmpeg fallback will be used');
      }
    }
  }
}
setTimeout(() => ensurePythonPackages(), 1000);

app.listen(PORT, function() {
  console.log('EnerStudio Backend v8.48.0 running on port ' + PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
