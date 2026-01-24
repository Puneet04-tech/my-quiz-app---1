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
// Admin basic auth middleware (optional). If ADMIN_USER and ADMIN_PASS are set in env,
// protected routes will require HTTP Basic auth.
function adminAuthMiddleware(req, res, next) {
  const protectedPaths = ['/scores.html', '/api/scores', '/api/clear-scores', '/api/export-scores'];
  const needsAuth = protectedPaths.some(p => req.path === p || req.path.startsWith(p + '/')) || protectedPaths.includes(req.path);
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_USER || !ADMIN_PASS || !needsAuth) return next();

  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Scores"');
    return res.status(401).send('Authentication required');
  }
  const creds = Buffer.from(auth.split(' ')[1], 'base64').toString('utf8');
  const [user, pass] = creds.split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.setHeader('WWW-Authenticate', 'Basic realm="Scores"');
  return res.status(401).send('Invalid credentials');
}

// Attach admin auth before static so scores.html is protected
app.use(adminAuthMiddleware);
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

// In-memory tracking of users who completed the quiz (resets on server restart)
const completedUsers = new Set();

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

// Check if user has already completed the quiz (since last server restart)
app.get('/api/quiz-status/:userName', (req, res) => {
  const userName = req.params.userName;
  const hasCompleted = completedUsers.has(userName);
  res.json({ completed: hasCompleted });
});

app.post('/api/scores', async (req, res) => {
  const payload = req.body;
  if (!payload || !payload.name) return res.status(400).json({ error: 'Invalid payload' });

  // Mark this user as completed
  completedUsers.add(payload.name);

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

// Clear all persisted scores (file or DB) and notify connected clients
app.post('/api/clear-scores', async (req, res) => {
  try {
    if (pool) {
      // Remove all rows from scores table
      await pool.query('DELETE FROM scores');
    } else {
      // Overwrite file with empty array
      fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), 'utf8');
    }

    // Clear in-memory completedUsers set as well
    completedUsers.clear();

    // Broadcast clear event to WebSocket clients
    try {
      const msg = JSON.stringify({ type: 'clear-scores' });
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
      });
    } catch (e) {
      console.error('Broadcast clear event error', e);
    }

    return res.json({ success: true });
  } catch (e) {
    console.error('POST /api/clear-scores error', e);
    return res.status(500).json({ error: 'Failed to clear scores' });
  }
});

// Export scores as CSV for faculty review
app.get('/api/export-scores', async (req, res) => {
  try {
    const rows = await readScores();
    // Normalize to array of objects
    const arr = Array.isArray(rows) ? rows : [];
    const headers = ['id','name','email','score','answeredQuestions','totalQuestions','timeTaken','reason','receivedAt','date'];
    const csv = [headers.join(',')].concat(arr.map(r => {
      return headers.map(h => {
        const v = r[h] == null ? '' : String(r[h]).replace(/"/g, '""');
        return '"' + v + '"';
      }).join(',');
    })).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="scores.csv"');
    res.send(csv);
  } catch (e) {
    console.error('GET /api/export-scores error', e);
    res.status(500).json({ error: 'Failed to export scores' });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
