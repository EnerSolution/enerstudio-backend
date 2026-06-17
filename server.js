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
    version: '8.5.1',
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
    
    // For whiteboard mode: enforce ink style with strong negative prompt
    let finalPrompt = prompt;
    if (styleMode === 'whiteboard') {
      // Ensure prompt has strong ink enforcement
      if (!finalPrompt.includes('no text')) {
        finalPrompt += ', absolutely no text no words no letters, hand-drawn ink illustration only, pure white background, no photography no realistic rendering';
      }
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
# Pen image is 200x120, scale to reasonable size
PEN_W=int(min(W,H)*0.18)
PEN_H=int(PEN_W*0.6)
hand=hand.resize((PEN_W,PEN_H),Image.LANCZOS)
HAND_SIZE=PEN_W
TIP_OFFSET_X=int(PEN_W*0.10)  # tip is at ~10% from left
TIP_OFFSET_Y=int(PEN_H*0.17)  # tip is at ~17% from top

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
        px_i=int(hx-TIP_OFFSET_X)
        py_i=int(hy-TIP_OFFSET_Y)
        px_i=max(0,min(W-PEN_W,px_i))
        py_i=max(0,min(H-PEN_H,py_i))
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

    // AUDIO-FIRST: Get voiceover, measure its duration, then set video duration to match
    let audioFile = null;
    let audioDuration = perScene * imageUrls.length; // fallback
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
        if (vr.ok) {
          audioFile=path.join(tempDir,'voice.mp3');
          fs.writeFileSync(audioFile,Buffer.from(await vr.arrayBuffer()));
          // Measure actual audio duration using ffprobe
          try {
            // ffmpeg prints duration to stderr, so we catch the error output
            execSync('"'+ffmpegPath+'" -i "'+audioFile+'"', {timeout:10000});
          } catch(pe) {
            const dm = (pe.stderr||pe.message||'').toString().match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            if (dm) {
              audioDuration = parseInt(dm[1])*3600 + parseInt(dm[2])*60 + parseFloat(dm[3]);
              console.log('Audio duration:', audioDuration.toFixed(2)+'s');
            }
          }
        } else { console.log('Voiceover failed:', vr.status); }
      } catch(e) { console.log('Voice error:', e.message); }
    }

    // Concat scenes
    const listFile = path.join(tempDir,'list.txt');
    fs.writeFileSync(listFile, sceneClips.map(f=>"file '"+f+"'").join('\n'));
    const stitched = path.join(tempDir,'stitched.mp4');
    execSync('"'+ffmpegPath+'" -f concat -safe 0 -i "'+listFile+'" -c copy "'+stitched+'" -y', {timeout:120000});

    // Trim or extend video to exactly match audio duration
    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir,'final.mp4');
      // Use -t audioDuration to trim video to audio length, or loop last frame if video is shorter
      execSync('"'+ffmpegPath+'" -i "'+stitched+'" -i "'+audioFile+'" -map 0:v -map 1:a -c:v copy -c:a aac -t '+audioDuration.toFixed(2)+' "'+withAudio+'" -y', {timeout:120000});
      finalPath = withAudio;
      console.log('Final video trimmed to audio duration:', audioDuration.toFixed(2)+'s');
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
  console.log('EnerStudio Backend v8.5.0 running on port ' + PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
