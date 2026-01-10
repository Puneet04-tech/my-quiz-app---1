const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'scores.json');

// If DATABASE_URL is provided, use Postgres; otherwise pool will be null and file fallback used
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Allow CORS for API so scores.html opened from file:// can still fetch when needed
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Broadcast helper for WebSocket clients
function broadcastNewScore(scoreObj) {
  const message = JSON.stringify({ type: 'new-score', payload: scoreObj });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// DB helpers
async function ensureTable() {
  if (!pool) return;
  const createSql = `
    CREATE TABLE IF NOT EXISTS scores (
      id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      score INTEGER,
      answeredQuestions INTEGER,
      totalQuestions INTEGER,
      timeTaken TEXT,
      reason TEXT,
      receivedAt TIMESTAMP WITH TIME ZONE,
      date TIMESTAMP WITH TIME ZONE
    );
  `;
  await pool.query(createSql);
}

async function readScores() {
  // Try DB first
  if (pool) {
    const res = await pool.query('SELECT * FROM scores ORDER BY receivedAt ASC');
    return res.rows;
  }

  // Fallback to file
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    console.error('Failed to read scores:', e);
    return [];
  }
}

async function insertScore(score) {
  if (pool) {
    const sql = `INSERT INTO scores(id, name, email, score, answeredQuestions, totalQuestions, timeTaken, reason, receivedAt, date)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
    const vals = [score.id, score.name, score.email || null, score.score || null, score.answeredQuestions || null, score.totalQuestions || null, score.timeTaken || null, score.reason || null, score.receivedAt || null, score.date || null];
    await pool.query(sql, vals);
    return true;
  }

  // File fallback
  try {
    let arr = [];
    if (fs.existsSync(DATA_FILE)) {
      arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]');
    }
    arr.push(score);
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to write scores to file:', e);
    return false;
  }
}

// Ensure DB table if pool exists
ensureTable().catch(err => { if (err) console.error('ensureTable error', err); });

app.get('/api/scores', async (req, res) => {
  try {
    const scores = await readScores();
    res.json(scores);
  } catch (e) {
    console.error('GET /api/scores error', e);
    res.json([]);
  }
});

app.post('/api/scores', async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.name) return res.status(400).json({ error: 'Invalid payload' });

  payload.id = payload.id || Date.now();
  payload.receivedAt = payload.receivedAt || new Date().toISOString();

  try {
    const ok = await insertScore(payload);
    if (!ok) return res.status(500).json({ error: 'Failed to persist score' });
    try { broadcastNewScore(payload); } catch (e) { console.error('broadcast error', e); }
    return res.json({ success: true });
  } catch (e) {
    console.error('POST /api/scores error', e);
    return res.status(500).json({ error: 'Failed to persist score' });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
