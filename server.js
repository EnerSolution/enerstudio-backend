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
    version: '7.0.0',
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

    // If imageUrl provided (pre-generated Runway image), use directly
    if (imageUrl) {
      console.log('Using provided image URL for video generation');
      const vidRes = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RUNWAY_KEY,
          'X-Runway-Version': '2024-11-06',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gen4_turbo',
          promptImage: imageUrl,
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
      execSync('"' + ffmpegPath + '" -i "' + withText + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "' + withAudio + '" -y', { timeout: 120000 });
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
  console.log('EnerStudio Backend v7.0 running on port ' + PORT);
  console.log('FFmpeg path:', ffmpegPath);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
