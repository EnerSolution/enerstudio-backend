const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RUNWAY_KEY = process.env.RUNWAY_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ 
    status: 'EnerStudio Backend Running', 
    version: '3.0.0',
    keys: {
      anthropic: ANTHROPIC_KEY ? 'SET (' + ANTHROPIC_KEY.substring(0,10) + '...)' : 'MISSING',
      runway: RUNWAY_KEY ? 'SET (' + RUNWAY_KEY.substring(0,10) + '...)' : 'MISSING',
      elevenlabs: ELEVENLABS_KEY ? 'SET (' + ELEVENLABS_KEY.substring(0,10) + '...)' : 'MISSING'
    }
  });
});

// ANTHROPIC
app.post('/api/claude/generate', async (req, res) => {
  try {
    console.log('Claude generate called');
    console.log('ANTHROPIC_KEY exists:', !!ANTHROPIC_KEY);
    console.log('ANTHROPIC_KEY prefix:', ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0,15) : 'MISSING');
    
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
    console.log('Anthropic response status:', response.status);
    console.log('Anthropic response:', JSON.stringify(data).substring(0, 200));
    
    if (!response.ok) throw new Error('Anthropic error ' + response.status + ': ' + JSON.stringify(data));
    res.json({ text: data.content?.[0]?.text || '', success: true });
  } catch (e) {
    console.error('Claude generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// RUNWAY BALANCE
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

// RUNWAY GENERATE
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

// RUNWAY STATUS
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

// ELEVENLABS
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

app.listen(PORT, () => {
  console.log('EnerStudio Backend v3.0 running on port ' + PORT);
  console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'SET' : 'MISSING');
  console.log('RUNWAY_KEY:', RUNWAY_KEY ? 'SET' : 'MISSING');
  console.log('ELEVENLABS_KEY:', ELEVENLABS_KEY ? 'SET' : 'MISSING');
});
