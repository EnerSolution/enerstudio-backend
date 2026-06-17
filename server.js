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

// ── VIDEO OUTPUT STORE (bypasses Render 30s timeout) ──────────────────────
const outputStore = {}; // { videoId: { path, size, created } }
// Cleanup files older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  Object.keys(outputStore).forEach(id => {
    if (outputStore[id].created < cutoff) {
      try { fs.unlinkSync(outputStore[id].path); } catch(e) {}
      delete outputStore[id];
      console.log('Cleaned up video:', id);
    }
  });
}, 5 * 60 * 1000);

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
    version: '8.5.0',
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

// ===== WHITEBOARD v8.4.0: RASTER REVEAL + FFmpeg FALLBACK =====
// Primary: Python pixel-by-pixel reveal (professional hand-draws strokes progressively)
// Fallback: FFmpeg wipe reveal (if Python packages not yet installed)
// Python packages auto-installed at server startup


app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-wb-'));
  try {
    const { imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No image URLs provided' });
    }
    const perScene = Math.max(6, Math.min(12, parseInt(secondsPerScene) || 8));
    console.log('Whiteboard v8.4.0: ' + imageUrls.length + ' scenes, pythonReady=' + pythonReady);

    // Write hand PNG
    const handPath = path.join(tempDir, 'hand.png');
    fs.writeFileSync(handPath, Buffer.from(HAND_B64_WB, 'base64'));

    const sceneClips = [];
    const transitions = ['wipeleft','wipedown','wiperight','wipetl','wipeleft','wipedown','wiperight','wipetl'];

    for (let i = 0; i < imageUrls.length; i++) {
      const imgPath = path.join(tempDir, 'img' + i + '.jpg');
      const ir = await fetch(imageUrls[i]);
      if (!ir.ok) throw new Error('Image ' + i + ' download failed: ' + ir.status);
      fs.writeFileSync(imgPath, Buffer.from(await ir.arrayBuffer()));

      const clip = path.join(tempDir, 'scene' + i + '.mp4');

      if (pythonReady) {
        // ── RASTER REVEAL: hand draws strokes progressively ──────────────
        const frameDir = path.join(tempDir, 'f' + i);
        fs.mkdirSync(frameDir);
        const pyScript = path.join(tempDir, 'reveal' + i + '.py');

        const pyCode = `
import numpy as np, math, os
from PIL import Image, ImageDraw
from skimage import measure, morphology

FPS=25
DRAW_SECS=${perScene - 1}
HOLD=round(FPS*1.5)

src=Image.open(${JSON.stringify(imgPath)}).convert('RGB')
W,H=src.size
arr=np.array(src)
gray=arr[:,:,0].astype(int)+arr[:,:,1].astype(int)+arr[:,:,2].astype(int)
not_white=(gray<720)
reveal_mask=not_white.astype(np.uint8)
labeled=measure.label(reveal_mask,connectivity=2)
regions=[r for r in measure.regionprops(labeled) if r.area>=15]
regions.sort(key=lambda r:(int(r.centroid[0]/100),r.centroid[1]))
region_pixels=[]
for r in regions:
    m=(labeled==r.label)&(reveal_mask==1)
    ys,xs=np.where(m)
    pts=sorted(zip(ys.tolist(),xs.tolist()))
    region_pixels.append([(x,y) for y,x in pts])
total_px=sum(len(p) for p in region_pixels)
draw_frames=DRAW_SECS*FPS
cum=0
for i,r in enumerate(regions):
    px=len(region_pixels[i])
    span=max(2,round(px/max(1,total_px)*draw_frames))
    r._start=round(cum/max(1,total_px)*draw_frames)
    r._end=r._start+span
    cum+=px
last_draw=regions[-1]._end if regions else draw_frames
total_frames=last_draw+HOLD
def ease(t): return 2*t*t if t<0.5 else 1-((-2*t+2)**2)/2
def hand(d,x,y,lifted):
    s=1.05 if lifted else 1.0
    def T(px,py):
        c,sn=math.cos(0.10),math.sin(0.10)
        return(x+(px*c-py*sn)*s,y+(px*sn+py*c)*s)
    d.ellipse([x+25*s,y+80*s,x+160*s,y+115*s],fill=(242,242,242,255))
    d.line([T(3,-3),T(45,-45)],fill=(26,39,64,255),width=int(13*s))
    d.line([T(1,-1),T(10,-10)],fill=(138,143,152,255),width=int(6*s))
    sk=(232,180,142,255);skd=(201,142,99,255)
    d.polygon([T(20,-25),T(46,-40),T(60,-24),T(40,-13)],fill=sk,outline=skd)
    d.polygon([T(13,-5),T(37,-29),T(56,-28),T(56,-15),T(16,0)],fill=sk,outline=skd)
    d.polygon([T(28,2),T(65,-20),T(105,-13),T(130,9),T(130,46),T(112,70),T(65,80),T(37,56)],fill=sk,outline=skd)
    d.polygon([T(90,65),T(138,112),T(175,80),T(128,36)],fill=sk,outline=skd)
    d.polygon([T(128,100),T(162,134),T(210,90),T(175,56)],fill=(59,77,113,255),outline=(42,58,88,255))
canvas=np.full((H,W,3),255,dtype=np.uint8)
os.makedirs(${JSON.stringify(frameDir)}, exist_ok=True)
for f in range(total_frames):
    hp=None;lifted=False
    for ri,r in enumerate(regions):
        if f<r._start: break
        pr=1.0 if f>=r._end else (f-r._start)/max(1,r._end-r._start)
        prog=ease(pr) if pr<1 else 1.0
        pxl=region_pixels[ri]
        n=max(1,int(len(pxl)*prog))
        for px,py in pxl[:n]: canvas[py,px]=arr[py,px]
        if pr<1 and pxl:
            w=pxl[max(0,n-6):n]
            hp=[sum(p[0] for p in w)/len(w),sum(p[1] for p in w)/len(w)]
    if hp is None and f<last_draw:
        for ri in range(len(regions)-1):
            a,b=regions[ri],regions[ri+1]
            if a._end<=f<b._start:
                t=ease((f-a._end)/max(1,b._start-a._end))
                ap=region_pixels[ri][-1] if region_pixels[ri] else [W//2,H//2]
                bp=region_pixels[ri+1][0] if region_pixels[ri+1] else [W//2,H//2]
                hp=[ap[0]+(bp[0]-ap[0])*t,ap[1]+(bp[1]-ap[1])*t]
                lifted=True;break
    img=Image.fromarray(canvas.copy())
    d=ImageDraw.Draw(img)
    if hp and f<last_draw: hand(d,hp[0],hp[1],lifted)
    img.save(f'${frameDir}/fr{f:04d}.jpg',quality=96)
print(f'done:{total_frames}')
`;
        fs.writeFileSync(pyScript, pyCode);
        const { execFileSync } = require('child_process');
        const pyOut = execFileSync('python3', [pyScript], { timeout: 600000, encoding: 'utf8' });
        const totalFrames = parseInt((pyOut.match(/done:(\d+)/) || [,'150'])[1]);
        execSync('"' + ffmpegPath + '" -y -framerate 25 -i "' + path.join(frameDir, 'fr%04d.jpg') + '" -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p "' + clip + '"', { timeout: 300000 });
        try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch(e) {}
        console.log('Scene', i+1, 'raster reveal done (' + totalFrames + ' frames)');

      } else {
        // ── FFMPEG WIPE FALLBACK (no Python) ─────────────────────────────
        const tr = transitions[i % transitions.length];
        const revealDur = Math.min(3.5, perScene - 2);
        const handX = "if(lt(t," + revealDur + "),(t/" + revealDur + ")*1100,1100)";
        const fc = [
          "[0:v]format=yuv420p[white]",
          "[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,format=yuv420p[im]",
          "[white][im]xfade=transition=" + tr + ":duration=" + revealDur + ":offset=0.3,format=yuv420p[wipe]",
          "[2:v]scale=140:140[hand]",
          "[wipe][hand]overlay=x='" + handX + "':y=270,format=yuv420p[out]"
        ].join(";");
        execSync('"' + ffmpegPath + '" -y -f lavfi -i "color=white:s=1280x720:d=' + perScene + ':r=25" -loop 1 -t ' + perScene + ' -i "' + imgPath + '" -loop 1 -i "' + handPath + '" -filter_complex "' + fc + '" -map "[out]" -t ' + perScene + ' -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p "' + clip + '"', { timeout: 120000 });
        console.log('Scene', i+1, 'FFmpeg wipe fallback done');
      }
      sceneClips.push(clip);
    }

    // Voiceover
    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const cleanText = voiceoverText.replace(/\[.*?\]/g,'').replace(/SCENE.*?:\s*/gi,'').replace(/\n+/g,' ').replace(/\s+/g,' ').trim().substring(0,2000);
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
          method: 'POST',
          headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({ text: cleanText, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
        });
        if (vr.ok) { audioFile = path.join(tempDir,'voice.mp3'); fs.writeFileSync(audioFile, Buffer.from(await vr.arrayBuffer())); console.log('Voiceover ready'); }
        else { console.log('Voiceover failed:', vr.status); }
      } catch(e) { console.log('Voice error:', e.message); }
    }

    // Concat + mux
    const listFile = path.join(tempDir, 'list.txt');
    fs.writeFileSync(listFile, sceneClips.map(f => "file '" + f + "'").join('\n'));
    const stitched = path.join(tempDir, 'stitched.mp4');
    execSync('"' + ffmpegPath + '" -f concat -safe 0 -i "' + listFile + '" -c copy "' + stitched + '" -y', { timeout: 120000 });
    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir, 'final.mp4');
      execSync('"' + ffmpegPath + '" -i "' + stitched + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac "' + withAudio + '" -y', { timeout: 120000 });
      finalPath = withAudio;
    }
    const videoId = 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const outputPath = path.join(os.tmpdir(), videoId + '.mp4');
    fs.copyFileSync(finalPath, outputPath);
    const fileSize = fs.statSync(outputPath).size;
    outputStore[videoId] = { path: outputPath, size: fileSize, created: Date.now() };
    console.log('Whiteboard v8.4.0 ready:', fileSize, 'bytes, id:', videoId, 'pythonReady=' + pythonReady);
    res.json({ videoId, downloadUrl: '/api/video/' + videoId, size: fileSize, scenes: imageUrls.length });

  } catch(e) {
    console.error('Whiteboard v8.4.0 error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir, {recursive:true,force:true}); } catch(e) {}
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

// ===== STARTUP: ensure Python packages available for whiteboard engine =====
const { execSync: execSyncQ } = require('child_process');
let pythonReady = false;
function ensurePythonPackages() {
  try {
    execSyncQ('python3 -c "import numpy, PIL, skimage; print(numpy.__version__)"', { timeout: 10000 });
    pythonReady = true;
    console.log('Python packages: numpy/PIL/skimage already available');
  } catch(e) {
    console.log('Installing Python packages (numpy, Pillow, scikit-image)...');
    try {
      execSyncQ('pip3 install numpy Pillow scikit-image --quiet --break-system-packages', { timeout: 300000 });
      pythonReady = true;
      console.log('Python packages installed successfully');
    } catch(e2) {
      console.log('pip3 install failed, trying pip:', e2.message.substring(0,100));
      try {
        execSyncQ('pip install numpy Pillow scikit-image --quiet', { timeout: 300000 });
        pythonReady = true;
        console.log('Python packages installed via pip');
      } catch(e3) {
        console.log('Python packages unavailable - whiteboard will use FFmpeg fallback');
      }
    }
  }
}
// Install asynchronously so server starts immediately
setTimeout(() => ensurePythonPackages(), 1000);

app.listen(PORT, function() {
  console.log('EnerStudio Backend v7.3 running on port ' + PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});// ===== WHITEBOARD v8.5.0: OUTLINE-FIRST RASTER REVEAL =====
// Draws INK STROKES first (72% of time), then COLOR FILLS (28%)
// Mimics natural artist drawing: sketch outline → color in
// Professional hand PNG with pen tip precisely at reveal point
// Duration fix: video duration matches voiceover, not -shortest

const HAND_B64_WB = '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';

app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-wb-'));
  try {
    const { imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No image URLs provided' });
    }
    const perScene = Math.max(6, Math.min(12, parseInt(secondsPerScene) || 8));
    console.log('Whiteboard v8.5.0:', imageUrls.length, 'scenes x', perScene + 's, pythonReady=' + pythonReady);

    const handPath = path.join(tempDir, 'hand.png');
    fs.writeFileSync(handPath, Buffer.from(HAND_B64_WB, 'base64'));

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
DRAW_SECS=${perScene - 1}
HOLD_SECS=1.5
draw_frames=int(DRAW_SECS*FPS)
ink_frames=int(draw_frames*0.72)
fill_frames=draw_frames-ink_frames
hold_frames=int(HOLD_SECS*FPS)
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
HAND_SIZE=int(min(W,H)*0.22)
hand=hand.resize((HAND_SIZE,HAND_SIZE),Image.LANCZOS)
TIP_OFFSET=int(HAND_SIZE*0.20)

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
            w=pxl[max(0,n-6):n]
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
            w=pxl[max(0,n-6):n]
            hx=sum(p[0] for p in w)/len(w)
            hy=sum(p[1] for p in w)/len(w)
    img=Image.fromarray(canvas.copy())
    if hx is not None and f<last_draw:
        px_i=int(hx-TIP_OFFSET)
        py_i=int(hy-TIP_OFFSET)
        px_i=max(0,min(W-HAND_SIZE,px_i))
        py_i=max(0,min(H-HAND_SIZE,py_i))
        img_rgba=img.convert('RGBA')
        img_rgba.paste(hand,(px_i,py_i),hand)
        img=img_rgba.convert('RGB')
    img.save(f'${frameDir}/fr{f:04d}.jpg',quality=95)
print(f'done:{total_frames}')
`;
        fs.writeFileSync(pyScript, pyCode);
        const { execFileSync } = require('child_process');
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

    // Voiceover
    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const cleanText = voiceoverText.replace(/\[.*?\]/g,'').replace(/SCENE.*?:\s*/gi,'').replace(/\n+/g,' ').replace(/\s+/g,' ').trim().substring(0,2000);
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+vid, {
          method:'POST',
          headers:{'xi-api-key':ELEVENLABS_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
          body:JSON.stringify({text:cleanText,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.75}})
        });
        if (vr.ok) { audioFile=path.join(tempDir,'voice.mp3'); fs.writeFileSync(audioFile,Buffer.from(await vr.arrayBuffer())); console.log('Voiceover ready'); }
        else console.log('Voiceover failed:', vr.status);
      } catch(e) { console.log('Voice error:', e.message); }
    }

    // Concat scenes
    const listFile = path.join(tempDir,'list.txt');
    fs.writeFileSync(listFile, sceneClips.map(f=>"file '"+f+"'").join('\n'));
    const stitched = path.join(tempDir,'stitched.mp4');
    execSync('"'+ffmpegPath+'" -f concat -safe 0 -i "'+listFile+'" -c copy "'+stitched+'" -y', {timeout:120000});

    // Mux audio — use video duration as master (fixes duration mismatch)
    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir,'final.mp4');
      // -shortest removed: let video duration be the master, pad audio if needed
      execSync('"'+ffmpegPath+'" -i "'+stitched+'" -i "'+audioFile+'" -map 0:v -map 1:a -c:v copy -c:a aac "'+withAudio+'" -y', {timeout:120000});
      finalPath = withAudio;
    }

    // Save to outputStore (bypasses 30s HTTP timeout)
    const videoId = 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    const outputPath = path.join(os.tmpdir(), videoId+'.mp4');
    fs.copyFileSync(finalPath, outputPath);
    const fileSize = fs.statSync(outputPath).size;
    outputStore[videoId] = { path:outputPath, size:fileSize, created:Date.now() };
    console.log('Whiteboard v8.5.0 ready:', fileSize, 'bytes, id:', videoId);
    res.json({ videoId, downloadUrl:'/api/video/'+videoId, size:fileSize, scenes:imageUrls.length });

  } catch(e) {
    console.error('Whiteboard v8.5.0 error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir,{recursive:true,force:true}); } catch(e) {}
  }
});
