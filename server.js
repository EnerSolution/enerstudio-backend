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
    version: '8.3.0',
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

// ===== WHITEBOARD v8.3.0: RASTER REVEAL + FFmpeg FALLBACK =====
// Primary: Python pixel-by-pixel reveal (professional hand-draws strokes progressively)
// Fallback: FFmpeg wipe reveal (if Python packages not yet installed)
// Python packages auto-installed at server startup

const HAND_B64_WB = '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';

app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-wb-'));
  try {
    const { imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No image URLs provided' });
    }
    const perScene = Math.max(6, Math.min(12, parseInt(secondsPerScene) || 8));
    console.log('Whiteboard v8.3.0: ' + imageUrls.length + ' scenes, pythonReady=' + pythonReady);

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
      execSync('"' + ffmpegPath + '" -i "' + stitched + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "' + withAudio + '" -y', { timeout: 120000 });
      finalPath = withAudio;
    }
    const out = fs.readFileSync(finalPath);
    console.log('Whiteboard v8.3.0 ready:', out.length, 'bytes, pythonReady=' + pythonReady);
    res.set('Content-Type','video/mp4'); res.set('Content-Disposition','attachment; filename="enerstudio-whiteboard.mp4"'); res.send(out);

  } catch(e) {
    console.error('Whiteboard v8.3.0 error:', e.message);
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
});
