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
    version: '8.2.0',
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

// ===== WHITEBOARD v8.2.0: PURE FFMPEG REVEAL ENGINE =====
// NO Python, NO numpy, NO native dependencies — works on Render free tier
// Method: xfade wipe reveals illustration over white canvas + hand overlay
// Each scene: white→illustration wipe (3s) + hold (remainder) + moving hand PNG
// Cost: ~2 Runway credits per scene image (gen4_image), zero video credits

const HAND_B64 = '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';

app.post('/api/whiteboard/animate', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-wb-'));
  try {
    const { imageUrls, voiceoverText, voiceId, secondsPerScene } = req.body;
    if (!imageUrls || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No image URLs provided' });
    }
    const perScene = Math.max(6, Math.min(12, parseInt(secondsPerScene) || 8));
    const revealDur = Math.min(3.5, perScene - 2);
    console.log('Whiteboard v8.2.0: FFmpeg-only,', imageUrls.length, 'scenes x', perScene + 's');

    // Write hand PNG from embedded base64 — no external file needed
    const handPath = path.join(tempDir, 'hand.png');
    fs.writeFileSync(handPath, Buffer.from(HAND_B64, 'base64'));

    // Render each scene: white wipe reveals illustration, hand follows wipe front
    const sceneClips = [];
    const transitions = ['wipeleft', 'wipedown', 'wiperight', 'wipetl', 'wipeleft', 'wipedown', 'wiperight', 'wipetl'];
    
    for (let i = 0; i < imageUrls.length; i++) {
      // Download source image
      const imgPath = path.join(tempDir, 'img' + i + '.jpg');
      const ir = await fetch(imageUrls[i]);
      if (!ir.ok) throw new Error('Image ' + i + ' download failed: ' + ir.status);
      fs.writeFileSync(imgPath, Buffer.from(await ir.arrayBuffer()));

      const clip = path.join(tempDir, 'scene' + i + '.mp4');
      const tr = transitions[i % transitions.length];
      
      // Hand movement: follows wipe from left to right during reveal, then stays at right
      // x moves 0 → 1100 over revealDur seconds, y stays at vertical center (290)
      const handX = "if(lt(t," + revealDur + "),(t/" + revealDur + ")*1100,1100)";
      
      const filterComplex = [
        "[0:v]format=yuv420p[white]",
        "[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,format=yuv420p[im]",
        "[white][im]xfade=transition=" + tr + ":duration=" + revealDur + ":offset=0.3,format=yuv420p[wipe]",
        "[2:v]scale=140:140[hand]",
        "[wipe][hand]overlay=x='" + handX + "':y=270,format=yuv420p[out]"
      ].join(";");

      execSync(
        '"' + ffmpegPath + '" -y' +
        ' -f lavfi -i "color=white:s=1280x720:d=' + perScene + ':r=25"' +
        ' -loop 1 -t ' + perScene + ' -i "' + imgPath + '"' +
        ' -loop 1 -i "' + handPath + '"' +
        ' -filter_complex "' + filterComplex + '"' +
        ' -map "[out]" -t ' + perScene +
        ' -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p' +
        ' "' + clip + '"',
        { timeout: 120000 }
      );
      sceneClips.push(clip);
      console.log('Scene', i + 1, '/' + imageUrls.length, 'rendered (' + tr + ')');
    }

    // Voiceover via ElevenLabs
    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        let vid = voiceId || await getFirstVoice();
        if (!vid) vid = 'EXAVITQu4vr4xnSDxMaL';
        const cleanText = voiceoverText
          .replace(/\[.*?\]/g, '').replace(/SCENE.*?:\s*/gi, '')
          .replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000);
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
          method: 'POST',
          headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify({ text: cleanText, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
        });
        if (vr.ok) {
          audioFile = path.join(tempDir, 'voice.mp3');
          fs.writeFileSync(audioFile, Buffer.from(await vr.arrayBuffer()));
          console.log('Voiceover ready');
        } else { console.log('Voiceover failed:', vr.status); }
      } catch(e) { console.log('Voice error:', e.message); }
    }

    // Concat all scene clips
    const listFile = path.join(tempDir, 'list.txt');
    fs.writeFileSync(listFile, sceneClips.map(f => "file '" + f + "'").join('\n'));
    const stitched = path.join(tempDir, 'stitched.mp4');
    execSync('"' + ffmpegPath + '" -f concat -safe 0 -i "' + listFile + '" -c copy "' + stitched + '" -y', { timeout: 120000 });

    // Mux voiceover
    let finalPath = stitched;
    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir, 'final.mp4');
      execSync('"' + ffmpegPath + '" -i "' + stitched + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "' + withAudio + '" -y', { timeout: 120000 });
      finalPath = withAudio;
    }

    const finalVideo = fs.readFileSync(finalPath);
    console.log('Whiteboard v8.2.0 ready:', finalVideo.length, 'bytes,', imageUrls.length, 'scenes');
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="enerstudio-whiteboard.mp4"');
    res.send(finalVideo);

  } catch(e) {
    console.error('Whiteboard v8.2.0 error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
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
