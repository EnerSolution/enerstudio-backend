const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// API Keys from environment variables
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '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';
const RUNWAY_KEY = process.env.RUNWAY_API_KEY || 'key_fd9392fd63f5816016460dc999ca909f9f5dd2969781368033ce5ef6ce65e91d6b6aff84525086e59c8add0aff097f540ef5979a1eaef775c28056b2d7f44748';
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || 'sk_f5879a02e2ff031b0da44cc04cf76aec071d34a05a6101b7';

// CORS - allow all origins
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'EnerStudio Backend Running', version: '1.0.0' });
});

// =====================
// ANTHROPIC PROXY
// =====================
app.post('/api/claude/generate', async (req, res) => {
  try {
    const { prompt, system } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: system || 'You are a professional video script writer.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Anthropic error ' + response.status);
    const text = data.content?.[0]?.text || '';
    res.json({ text, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================
// RUNWAY PROXY
// =====================
app.get('/api/runway/balance', async (req, res) => {
  try {
    const response = await fetch('https://api.dev.runwayml.com/v1/organization', {
      headers: {
        'Authorization': 'Bearer ' + RUNWAY_KEY,
        'X-Runway-Version': '2024-11-06'
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/runway/generate', async (req, res) => {
  try {
    const { prompt, imageUrl } = req.body;
    if (!prompt || !imageUrl) return res.status(400).json({ error: 'prompt and imageUrl are required' });
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
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================
// ELEVENLABS PROXY
// =====================
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
    const buffer = await response.buffer();
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', 'attachment; filename="voiceover.mp3"');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/voice/list', async (req, res) => {
  try {
    const response = await fetch('https://api.elevenlabs.io/v2/voices', {
      headers: { 'xi-api-key': ELEVENLABS_KEY }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('EnerStudio Backend running on port ' + PORT);
});
