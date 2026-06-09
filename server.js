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
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: system || 'You are a professional video script writer.', messages: [{ role: 'user', content: prompt }] })
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/runway/generate', async (req, res) => {
  try {
    const { prompt, imageUrl } = req.body;
    if (!prompt || !imageUrl) return res.status(400).json({ error: 'prompt and imageUrl required' });
    const response = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RUNWAY_KEY, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gen4_turbo', promptImage: imageUrl, promptText: prompt, duration: 5, ratio: '1280:720' })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    res.json({ id: data.id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/runway/status/:taskId', async (req, res) => {
  try {
    const response = await fetch('https://api.dev.runwayml.com/v1/tasks/' + req.params.taskId, {
      he
