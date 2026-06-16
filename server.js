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
    version: '8.1.0',
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

// ===== WHITEBOARD v8.1.0: RASTER REVEAL ENGINE (VideoScribe method) =====
// Source = Runway gen4_image professional illustration (PNG/JPG, white background)
// Algorithm: threshold ink pixels → connected components → spatially order →
//   reveal pixel-by-pixel with hand following → stitch + voiceover → MP4
// Quality scales with image source quality — Runway gen4 master-ink prompt = professional grade

let sharp = null;
try { sharp = require('sharp'); } catch(e) {}
const { execFileSync } = require('child_process');

// Pure-JS image operations (no canvas needed for raster reveal)
app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-raster-'));
  try {
    const { svgScenes, imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    const perScene = Math.max(5, Math.min(12, parseInt(secondsPerScene) || 8));

    // Support both SVG (legacy) and imageUrl (new raster) modes
    const sources = imageUrls && imageUrls.length ? imageUrls : null;
    if (!sources && (!svgScenes || !svgScenes.length)) {
      return res.status(400).json({ error: 'Provide either imageUrls (raster mode) or svgScenes (legacy mode)' });
    }

    console.log('Whiteboard Raster v8.1.0: mode =', sources ? 'raster' : 'svg-fallback',
                '| scenes =', sources ? sources.length : svgScenes.length);

    const sceneClips = [];

    if (sources) {
      // ── RASTER REVEAL MODE ──────────────────────────────────────────────────
      for (let sIdx = 0; sIdx < sources.length; sIdx++) {
        // 1. Fetch source image
        const imgPath = path.join(tempDir, `src${sIdx}.jpg`);
        const ir = await fetch(sources[sIdx]);
        if (!ir.ok) throw new Error(`Image ${sIdx} fetch failed: ${ir.status}`);
        fs.writeFileSync(imgPath, Buffer.from(await ir.arrayBuffer()));
        console.log(`Scene ${sIdx+1} image downloaded`);

        // 2. Use Python raster-reveal script for this scene
        const frameDir = path.join(tempDir, `f${sIdx}`);
        fs.mkdirSync(frameDir);
        const pyScript = path.join(tempDir, `reveal${sIdx}.py`);
        fs.writeFileSync(pyScript, `
import numpy as np, math, os, shutil
from PIL import Image, ImageDraw
from skimage import measure, morphology

FPS=${WB_FPS || 30}
DRAW_SECS=${perScene}
HOLD=round(FPS*1.2)

src=Image.open(${JSON.stringify(imgPath)}).convert('RGB')
W,H=src.size
arr=np.array(src)
gray=arr[:,:,0].astype(int)+arr[:,:,1].astype(int)+arr[:,:,2].astype(int)
not_white=(gray<720)
reveal_mask=not_white.astype(np.uint8)
labeled=measure.label(reveal_mask,connectivity=2)
regions=[r for r in measure.regionprops(labeled) if r.area>=20]
regions.sort(key=lambda r:(int(r.centroid[0]/80),r.centroid[1]))
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
if not regions:
    total_frames=DRAW_SECS*FPS+HOLD
else:
    total_frames=regions[-1]._end+HOLD
def ease(t): return 2*t*t if t<0.5 else 1-((-2*t+2)**2)/2
def hand(d,x,y,lifted):
    s=1.05 if lifted else 1.0
    def T(px,py):
        c,sn=math.cos(0.10),math.sin(0.10)
        return(x+(px*c-py*sn)*s,y+(px*sn+py*c)*s)
    d.ellipse([x+30*s,y+95*s,x+190*s,y+135*s],fill=(242,242,242))
    d.line([T(3,-3),T(50,-50)],fill=(26,39,64),width=int(15*s))
    d.line([T(1,-1),T(12,-12)],fill=(138,143,152),width=int(7*s))
    sk=(232,180,142);skd=(201,142,99)
    d.polygon([T(22,-28),T(50,-44),T(66,-26),T(44,-14)],fill=sk,outline=skd)
    d.polygon([T(14,-6),T(40,-32),T(62,-30),T(62,-16),T(18,0)],fill=sk,outline=skd)
    d.polygon([T(30,2),T(70,-22),T(112,-14),T(140,10),T(140,50),T(120,76),T(70,86),T(40,60)],fill=sk,outline=skd)
    d.polygon([T(96,70),T(150,120),T(190,86),T(136,40)],fill=sk,outline=skd)
    d.polygon([T(136,106),T(176,142),T(230,96),T(190,60)],fill=(59,77,113),outline=(42,58,88))
canvas=np.full((H,W,3),255,dtype=np.uint8)
last_draw=regions[-1]._end if regions else draw_frames
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
            w=pxl[max(0,n-8):n]
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
    img.save(f'${frameDir}/fr{f:04d}.jpg',quality=97)
print(f'raster_reveal_done:{total_frames}')
`);
        const pyOut = execFileSync('python3', [pyScript], { timeout: 600000, encoding: 'utf8' });
        const totalFrames = parseInt((pyOut.match(/raster_reveal_done:(\d+)/) || [,'120'])[1]);
        console.log(`Scene ${sIdx+1} raster reveal: ${totalFrames} frames`);

        // 3. Encode scene clip
        const clip = path.join(tempDir, `scene${sIdx}.mp4`);
        execSync(`"${ffmpegPath}" -y -framerate ${WB_FPS||30} -i "${path.join(frameDir,'fr%04d.jpg')}" -c:v libx264 -preset medium -crf 16 -pix_fmt yuv420p "${clip}"`, { timeout: 300000 });
        fs.rmSync(frameDir, { recursive: true, force: true });
        sceneClips.push(clip);
      }

    } else {
      // ── SVG FALLBACK MODE (legacy) ──────────────────────────────────────────
      // Keep existing SVG draw-on engine for backward compatibility
      for (let sIdx = 0; sIdx < svgScenes.length; sIdx++) {
        if (!createCanvas) return res.status(500).json({ error: 'Canvas not available for SVG mode' });
        const els = wbParseSvg(svgScenes[sIdx]);
        if (!els.length) continue;
        const jobs = [];
        let elIdx = 0;
        for (const el of els) {
          if (el.tag === 'text') { if (el.text) jobs.push({ type: 'text', el, weight: el.text.length * 14 }); }
          else { const pls = wbElementPoints(el); for (const raw of pls) { if (raw.length > 1) { jobs.push({ type: 'stroke', el, raw, pts: wbWobble(raw, elIdx), weight: raw.length }); elIdx++; } } }
          elIdx++;
        }
        if (!jobs.length) continue;
        const holdFrames = Math.round((WB_FPS||30) * 1.1);
        const jobFn = j => j.type==='stroke' ? j.raw[0] : [WB_W/2,WB_H-90];
        const jobEnd = j => j.type==='stroke' ? j.raw[j.raw.length-1] : [WB_W/2,WB_H-90];
        const travels = []; let ttotal = 0;
        for (let ji = 0; ji < jobs.length-1; ji++) { const d=Math.hypot(jobFn(jobs[ji+1])[0]-jobEnd(jobs[ji])[0],jobFn(jobs[ji+1])[1]-jobEnd(jobs[ji])[1]); const tf=Math.max(1,Math.min(6,Math.round(d/250))); travels.push(tf); ttotal+=tf; }
        const drawFrames = Math.max(jobs.length*2, perScene*(WB_FPS||30)-holdFrames-ttotal);
        const totalWeight = jobs.reduce((a,j)=>a+j.weight,0); let cursor=0;
        for (let ji=0;ji<jobs.length;ji++){const j=jobs[ji];const span=Math.max(2,Math.round(j.weight/totalWeight*drawFrames));j.startF=cursor;j.endF=cursor+span;cursor=j.endF+(ji<travels.length?travels[ji]:0);}
        const lastDraw=jobs[jobs.length-1].endF; const totalFrames=lastDraw+holdFrames;
        const canvas=createCanvas(WB_W||1920,WB_H||1080); const ctx=canvas.getContext('2d');
        const frameDir=path.join(tempDir,'f'+sIdx); fs.mkdirSync(frameDir);
        function wbEase(t){return t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2;}
        for (let f=0;f<totalFrames;f++){
          ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,WB_W||1920,WB_H||1080);
          let handPos=null,lifted=false;
          for (const j of jobs){
            const rp=f>=j.endF?1:f<=j.startF?0:(f-j.startF)/(j.endF-j.startF);
            if(rp<=0)continue; const prog=rp>=1?1:wbEase(rp);
            const A=j.el.attrs; const strokeC=(A.stroke&&A.stroke!=='none')?A.stroke:'#111111';
            const sw=(parseFloat(A['stroke-width'])||3)*(WB_SCALE||1.5);
            if(j.type==='stroke'){
              const n=Math.max(1,Math.floor(j.pts.length*prog));
              if(prog>=1&&A.fill&&A.fill!=='none'&&A.fill!=='white'&&A.fill!=='#ffffff'){ctx.fillStyle=A.fill;ctx.beginPath();ctx.moveTo(j.pts[0][0],j.pts[0][1]);for(let p=1;p<j.pts.length;p++)ctx.lineTo(j.pts[p][0],j.pts[p][1]);ctx.closePath();ctx.fill();}
              ctx.strokeStyle=strokeC;ctx.lineWidth=sw;ctx.lineCap='round';ctx.lineJoin='round';
              ctx.beginPath();ctx.moveTo(j.pts[0][0],j.pts[0][1]);for(let p=1;p<n;p++)ctx.lineTo(j.pts[p][0],j.pts[p][1]);ctx.stroke();
              if(prog<1){const i0=Math.min(n,j.raw.length-1);let hx=0,hy=0,cnt=0;for(let w=-4;w<=4;w++){const k=Math.min(j.raw.length-1,Math.max(0,i0+w));hx+=j.raw[k][0];hy+=j.raw[k][1];cnt++;}handPos=[hx/cnt,hy/cnt];}
            } else {
              const full=j.el.text;const n=Math.max(0,Math.floor(full.length*prog));
              const fs2=(parseFloat(A['font-size'])||40)*(WB_SCALE||1.5);
              ctx.font='bold '+fs2+'px sans-serif';ctx.fillStyle=(A.fill&&A.fill!=='none')?A.fill:'#111111';ctx.textBaseline='alphabetic';
              const tx=(parseFloat(A.x)||0)*(WB_SCALE||1.5),ty=(parseFloat(A.y)||0)*(WB_SCALE||1.5);
              const anchor=A['text-anchor'];let drawX=tx;
              if(anchor==='middle')drawX=tx-ctx.measureText(full).width/2;else if(anchor==='end')drawX=tx-ctx.measureText(full).width;
              ctx.fillText(full.substring(0,n),drawX,ty);
              if(prog<1&&n>0){handPos=[drawX+ctx.measureText(full.substring(0,n)).width,ty-fs2*0.3];}
            }
          }
          if(!handPos&&f<lastDraw){for(let ji=0;ji<jobs.length-1;ji++){const a=jobs[ji],b=jobs[ji+1];if(a.endF<=f&&f<b.startF){const t=wbEase((f-a.endF)/Math.max(1,b.startF-a.endF));const pa=a.type==='stroke'?a.raw[a.raw.length-1]:[(WB_W||1920)/2,(WB_H||1080)-90];const pb=b.type==='stroke'?b.raw[0]:[(WB_W||1920)/2,(WB_H||1080)-90];handPos=[pa[0]+(pb[0]-pa[0])*t,pa[1]+(pb[1]-pa[1])*t];lifted=true;break;}}}
          if(handPos&&f<lastDraw){ctx.save();ctx.translate(handPos[0],handPos[1]);ctx.rotate(0.10);const S=(WB_SCALE||1.5)*(lifted?1.05:1);/* simplified hand */ctx.fillStyle='#e8b48e';ctx.fillRect(0,-30,60,80);ctx.restore();}
          fs.writeFileSync(path.join(frameDir,'fr'+String(f).padStart(4,'0')+'.jpg'),canvas.toBuffer('image/jpeg',{quality:0.97}));
        }
        const clip=path.join(tempDir,'scene'+sIdx+'.mp4');
        execSync('"'+ffmpegPath+'" -y -framerate '+(WB_FPS||30)+' -i "'+path.join(frameDir,'fr%04d.jpg')+'" -c:v libx264 -preset medium -crf 16 -pix_fmt yuv420p "'+clip+'"',{timeout:300000});
        fs.rmSync(frameDir,{recursive:true,force:true}); sceneClips.push(clip);
        console.log('SVG scene',sIdx+1,'rendered');
      }
    }

    if (!sceneClips.length) throw new Error('No scenes rendered');

    // Voiceover
    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
          method: 'POST',
          headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({
            text: voiceoverText.replace(/\[.*?\]/g,'').replace(/SCENE.*?:\s*/gi,'').replace(/\n+/g,' ').replace(/\s+/g,' ').trim().substring(0,2000),
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        });
        if (vr.ok) { audioFile = path.join(tempDir,'voice.mp3'); fs.writeFileSync(audioFile, Buffer.from(await vr.arrayBuffer())); console.log('Voiceover ready'); }
      } catch(e) { console.log('Voice error:', e.message); }
    }

    // Concat + mux
    const listFile = path.join(tempDir,'list.txt');
    fs.writeFileSync(listFile, sceneClips.map(f=>"file '"+f+"'").join('\n'));
    const stitched = path.join(tempDir,'stitched.mp4');
    execSync('"'+ffmpegPath+'" -f concat -safe 0 -i "'+listFile+'" -c copy "'+stitched+'" -y', {timeout:120000});
    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir,'final.mp4');
      execSync('"'+ffmpegPath+'" -i "'+stitched+'" -i "'+audioFile+'" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "'+withAudio+'" -y', {timeout:120000});
      finalPath = withAudio;
    }
    const out = fs.readFileSync(finalPath);
    console.log('Whiteboard Raster v8.1.0 ready:', out.length, 'bytes');
    res.set('Content-Type','video/mp4'); res.set('Content-Disposition','attachment; filename="enerstudio-whiteboard.mp4"'); res.send(out);
  } catch(e) {
    console.error('Whiteboard Raster error:', e.message);
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

app.listen(PORT, function() {
  console.log('EnerStudio Backend v7.3 running on port ' + PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
