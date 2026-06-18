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
    version: '8.8.0',
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

// Professional 3D hand with pen — 400x400px, pen tip at upper-left (62,68)
const HAND_B64_WB = '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';

app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-wb-'));
  try {
    const { imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No image URLs provided' });
    }
    const numScenes = imageUrls.length;
    console.log('Whiteboard v8.8.0:', numScenes, 'scenes, pythonReady=' + pythonReady);

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
# Pen tip is at (62,68) in 400x400 image = 15.5% from left, 17% from top
TIP_OFFSET_X=int(HAND_SIZE*0.155)
TIP_OFFSET_Y=int(HAND_SIZE*0.170)

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
    console.log('Whiteboard v8.8.0 ready:', fileSize, 'bytes, id:', videoId);
    res.json({ videoId, downloadUrl:'/api/video/'+videoId, size:fileSize, scenes:imageUrls.length });

  } catch(e) {
    console.error('Whiteboard v8.8.0 error:', e.message);
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
  console.log('EnerStudio Backend v8.8.0 running on port ' + PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
