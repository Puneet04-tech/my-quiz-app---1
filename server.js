const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
// Optional S3 support (non-SQL durable storage)
let S3Client, GetObjectCommand, PutObjectCommand;
let s3Client = null;
const S3_BUCKET = process.env.S3_BUCKET;
if (S3_BUCKET) {
  try {
    ({ S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3'));
    s3Client = new S3Client({ region: process.env.AWS_REGION });
  } catch (e) {
    console.warn('S3 SDK not installed or failed to load:', e && e.message);
    s3Client = null;
  }
}

// Firebase Admin (Firestore) support (optional)
let admin = null;
let firestore = null;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin = require('firebase-admin');
    let creds;
    try {
      creds = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      // maybe base64 encoded
      creds = JSON.parse(Buffer.from(FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
    }
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    firestore = admin.firestore();
    console.log('Initialized Firebase Admin for Firestore');
  } catch (e) {
    console.error('Failed to initialize Firebase Admin:', e && e.message);
    firestore = null;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'scores.json');

// If DATABASE_URL is provided, use Postgres; otherwise pool will be null and file fallback used
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// Admin basic auth middleware (optional). If ADMIN_USER and ADMIN_PASS are set in env,
// protect only faculty/admin routes. Public endpoints like POST /api/scores remain open so
// anyone can submit quiz results.
function adminAuthMiddleware(req, res, next) {
  // Only these paths require admin credentials
  const protectedPaths = ['/scores.html', '/api/clear-scores', '/api/export-scores'];
  const needsAuth = protectedPaths.some(p => req.path === p || req.path.startsWith(p + '/'));
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_USER || !ADMIN_PASS || !needsAuth) return next();

  // First, allow a simple cookie-based session for web login (admin_auth stores base64(user:pass))
  try {
    const cookieHeader = req.headers['cookie'] || '';
    const cookies = cookieHeader.split(';').map(c => c.trim());
    const adminCookie = cookies.find(c => c.startsWith('admin_auth='));
    const expected = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');
    if (adminCookie) {
      const val = adminCookie.split('=')[1] || '';
      if (val === expected) return next();
    }
  } catch (e) {}

  // Support Basic Auth header for API clients
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Basic ')) {
    const creds = Buffer.from(auth.split(' ')[1], 'base64').toString('utf8');
    const [user, pass] = creds.split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
    // Invalid basic auth provided
    res.setHeader('WWW-Authenticate', 'Basic realm="Scores"');
    return res.status(401).send('Invalid credentials');
  }

  // If client explicitly requests basic challenge (e.g. /scores.html?basic=1), send WWW-Authenticate 401
  if (req.query && String(req.query.basic) === '1') {
    res.setHeader('WWW-Authenticate', 'Basic realm="Scores"');
    return res.status(401).send('Authentication required');
  }

  // For normal browser navigation, redirect to the friendly login page
  const accept = req.headers['accept'] || '';
  const ua = req.headers['user-agent'] || '';
  if (accept.includes('text/html') || ua) {
    return res.redirect('/admin-login');
  }

  // Fallback: challenge with Basic
  res.setHeader('WWW-Authenticate', 'Basic realm="Scores"');
  return res.status(401).send('Authentication required');
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
  // If Postgres configured, read from DB
  if (pool) {
    const res = await pool.query('SELECT * FROM scores ORDER BY receivedAt ASC');
    return res.rows;
  }

  // If Firestore configured, read from Firestore collection 'scores'
  if (firestore) {
    try {
      const snapshot = await firestore.collection('scores').orderBy('receivedAt', 'asc').get();
      const docs = [];
      snapshot.forEach(doc => {
        docs.push(doc.data());
      });
      return docs;
    } catch (e) {
      console.error('Failed to read scores from Firestore:', e);
      return [];
    }
  }

  // If S3 configured, read from S3
  if (s3Client) {
    try {
      const get = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: 'scores.json' }));
      const streamToString = (stream) => new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      const body = await streamToString(get.Body);
      return JSON.parse(body || '[]');
    } catch (e) {
      if (e.name === 'NoSuchKey' || e.$metadata && e.$metadata.httpStatusCode === 404) return [];
      console.error('Failed to read scores from S3:', e);
      return [];
    }
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

  // If Firestore configured, write to Firestore
  if (firestore) {
    try {
      const id = score.id ? String(score.id) : String(Date.now());
      await firestore.collection('scores').doc(id).set(score);
      return true;
    } catch (e) {
      // More helpful diagnostics for common issues (NOT_FOUND often means project/db not found or insufficient permissions)
      try {
        const code = e && e.code ? e.code : undefined;
        console.error('Failed to write score to Firestore:', code ? `${code} ${e.message || ''}` : e);
        if (code === 5) {
          console.error('Firestore NOT_FOUND (code=5): check that the service account project_id matches an existing GCP project with Firestore enabled, and that the account has write permissions.');
        }
      } catch (ee) { console.error('Error while logging Firestore error', ee); }
      return false;
    }
  }

  // If S3 is configured, write to S3
  if (s3Client) {
    try {
      // read existing
      let arr = [];
      try {
        const get = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: 'scores.json' }));
        const streamToString = (stream) => new Promise((resolve, reject) => {
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on('error', (err) => reject(err));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        const body = await streamToString(get.Body);
        arr = JSON.parse(body || '[]');
      } catch (e) {
        arr = [];
      }
      arr.push(score);
      await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: 'scores.json', Body: JSON.stringify(arr, null, 2), ContentType: 'application/json' }));
      return true;
    } catch (e) {
      console.error('Failed to write scores to S3:', e);
      return false;
    }
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
    console.error('GET /api/scores error', e);
    res.status(500).json({ error: 'Failed to read scores' });
  }
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
    if (!ok) {
      console.error('insertScore returned false - possible write failure');
      return res.status(500).json({ error: 'Failed to persist score' });
    }
    try { broadcastNewScore(payload); } catch (e) { console.error('broadcast error', e); }
    return res.json({ success: true });
  } catch (e) {
    console.error('POST /api/scores error', e);
    return res.status(500).json({ error: 'Failed to persist score', details: e && e.message ? e.message : undefined });
  }
});

// Check whether a named user has already completed the quiz. The client uses this to
// prevent re-taking the quiz without resetting the server. This checks persistent
// stores (Postgres/Firestore/S3/file) as well as the in-memory set.
app.get('/api/quiz-status/:name', async (req, res) => {
  const name = req.params.name;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  try {
    // First check in-memory set (fast path)
    if (completedUsers.has(name)) return res.json({ completed: true });

    // Check Postgres
    if (pool) {
      const r = await pool.query('SELECT 1 FROM scores WHERE name=$1 LIMIT 1', [name]);
      return res.json({ completed: r.rowCount > 0 });
    }

    // Check Firestore
    if (firestore) {
      const snapshot = await firestore.collection('scores').where('name', '==', name).limit(1).get();
      return res.json({ completed: !snapshot.empty });
    }

    // Check S3
    if (s3Client) {
      try {
        const get = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: 'scores.json' }));
        const streamToString = (stream) => new Promise((resolve, reject) => {
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on('error', (err) => reject(err));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        const body = await streamToString(get.Body);
        const arr = JSON.parse(body || '[]');
        return res.json({ completed: arr.some(s => String(s.name) === String(name)) });
      } catch (e) {
        // Fall through to file fallback
      }
    }

    // File fallback
    const arr = await readScores();
    return res.json({ completed: arr.some(s => String(s.name) === String(name)) });
  } catch (e) {
    console.error('GET /api/quiz-status error', e);
    return res.status(500).json({ error: 'Failed to check status' });
  }
});

// Clear all persisted scores (file or DB) and notify connected clients
app.post('/api/clear-scores', async (req, res) => {
  try {
    if (pool) {
      // Remove all rows from scores table
      await pool.query('DELETE FROM scores');
    } else if (firestore) {
      // Delete all docs in Firestore collection 'scores'
      const snapshot = await firestore.collection('scores').get();
      const batch = firestore.batch();
      snapshot.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    } else if (s3Client) {
      // Overwrite file with empty array in S3
      await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: 'scores.json', Body: JSON.stringify([], null, 2), ContentType: 'application/json' }));
    } else {
      // Overwrite local file
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

// Lightweight endpoint to help diagnose storage on deployed hosts.
// Returns which backend is in use and whether local file storage is writable.
app.get('/api/storage-info', async (req, res) => {
  try {
    const info = { mode: null, writable: null, details: {} };
    if (pool) info.mode = 'postgres';
    else if (firestore) info.mode = 'firestore';
    else if (s3Client) info.mode = 's3';
    else info.mode = 'file';

    if (info.mode === 'file') {
      try {
        // Check write permission for directory
        fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK);
        info.writable = true;
      } catch (e) {
        info.writable = false;
        info.details.error = e && e.message ? e.message : String(e);
      }
    }

    // If Firestore is configured, attempt to show parsed project id from service account for diagnostics
    if (firestore) {
      try {
        if (FIREBASE_SERVICE_ACCOUNT) {
          let parsed;
          try { parsed = JSON.parse(FIREBASE_SERVICE_ACCOUNT); } catch (pe) { parsed = JSON.parse(Buffer.from(FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')); }
          info.details.firebase = { project_id: parsed && parsed.project_id ? parsed.project_id : null };
          if (!parsed || !parsed.project_id) info.details.firebase_note = 'Service account JSON does not contain project_id; Firestore writes may fail.';
        } else {
          info.details.firebase = { note: 'FIREBASE_SERVICE_ACCOUNT not set in environment' };
        }
      } catch (e) {
        info.details.firebase = { error: e && e.message ? e.message : String(e) };
      }
    }

    return res.json(info);
  } catch (e) {
    console.error('GET /api/storage-info error', e);
    return res.status(500).json({ error: 'Failed to check storage' });
  }
});

// Simple admin login page to allow entering ADMIN_USER/ADMIN_PASS when browser Basic prompt is not available
app.get('/admin-login', (req, res) => {
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_USER || !ADMIN_PASS) return res.status(404).send('Admin login not configured');
  const err = req.query && req.query.error ? '<p style="color:red">Invalid credentials</p>' : '';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Admin Login</title></head><body style="font-family:Arial;margin:24px;">${err}<h2>Admin Login</h2><form method="POST" action="/admin-login"><div><label>Username: <input name="user"></label></div><div><label>Password: <input name="pass" type="password"></label></div><div style="margin-top:12px;"><button type="submit">Login</button></div></form></body></html>`);
});

app.post('/admin-login', (req, res) => {
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_USER || !ADMIN_PASS) return res.status(404).send('Admin login not configured');
  const user = req.body && req.body.user ? String(req.body.user) : '';
  const pass = req.body && req.body.pass ? String(req.body.pass) : '';
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = Buffer.from(`${user}:${pass}`).toString('base64');
    // Set simple HttpOnly cookie for admin session for 24 hours
    res.setHeader('Set-Cookie', `admin_auth=${token}; HttpOnly; Path=/; Max-Age=${24*60*60}`);
    return res.redirect('/scores.html');
  }
  return res.redirect('/admin-login?error=1');
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
