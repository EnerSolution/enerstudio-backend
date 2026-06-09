const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RUNWAY_KEY = process.env.RUNWAY_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'EnerStudio Backend Running', version: '4.0.0' });
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
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06'
      }
    });
    res.json(await response.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/runway/generate', async (req, res) => {
  try {
    const { prompt, imageUrl } = req.body;
    if (!prompt || !imageUrl) return res.status(400).json({ error: 'prompt and imageUrl required' });
    const response = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gen4_turbo',
        promptImage: imageUrl,
        promptText: prompt,
        duration: 5,
        ratio: '1280:720'
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    res.json({ id: data.id, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/runway/status/:taskId', async (req, res) => {
  try {
    const response = await fetch('https://api.dev.runwayml.com/v1/tasks/' + req.params.taskId, {
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06'
      }
    });
    res.json(await response.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/runway/stitch', async (req, res) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enerstudio-'));
  try {
    const { clipUrls, voiceoverText } = req.body;
    if (!clipUrls || clipUrls.length === 0) {
      return res.status(400).json({ error: 'No clip URLs provided' });
    }

    const clipFiles = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const clipPath = path.join(tempDir, 'clip' + i + '.mp4');
      const r = await fetch(clipUrls[i]);
      if (!r.ok) throw new Error('Failed to download clip ' + i + ' status ' + r.status);
      const buf = await r.arrayBuffer();
      fs.writeFileSync(clipPath, Buffer.from(buf));
      clipFiles.push(clipPath);
      console.log('Downloaded clip', i + 1, 'of', clipUrls.length);
    }

    let audioFile = null;
    if (voiceoverText && ELEVENLABS_KEY) {
      try {
        const vr = await fetch('https://api.elevenlabs.io/v1/text-to-speech/f38a635bee7a4d1f9b0a654a31d050d2', {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
          },
          body: JSON.stringify({
            text: voiceoverText.substring(0, 2000),
            model_id: 'eleven_monolingual_v1',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        });
        if (vr.ok) {
          audioFile = path.join(tempDir, 'voice.mp3');
          fs.writeFileSync(audioFile, Buffer.from(await vr.arrayBuffer()));
          console.log('Voiceover generated successfully');
        }
      } catch (e) {
        console.log('Voice error:', e.message);
      }
    }

    const listFile = path.join(tempDir, 'list.txt');
    fs.writeFileSync(listFile, clipFiles.map(function(f) { return "file '" + f + "'"; }).join('\n'));

    const stitched = path.join(tempDir, 'stitched.mp4');
    execSync('ffmpeg -f concat -safe 0 -i "' + listFile + '" -c copy "' + stitched + '" -y', { timeout: 120000 });
    console.log('Clips stitched successfully');

    let finalPath = stitched;

    if (audioFile && fs.existsSync(audioFile)) {
      const withAudio = path.join(tempDir, 'final.mp4');
      execSync('ffmpeg -i "' + stitched + '" -i "' + audioFile + '" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "' + withAudio + '" -y', { timeout: 120000 });
      finalPath = withAudio;
      console.log('Audio added successfully');
    }

    const finalVideo = fs.readFileSync(finalPath);
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

app.post('/api/voice/generate', async (req, res) => {
  try {
    const { text, voice_id } = req.body;
    const vid = voice_id || 'f38a635bee7a4d1f9b0a654a31d050d2';
    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_monolingual_v1',
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
  console.log('EnerStudio Backend v4.0 running on port ' + PORT);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
