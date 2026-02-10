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

// Firebase Admin (Firestore) support (optional) - ENABLED FOR PERSISTENT STORAGE
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
    console.log('✅ Firebase Admin initialized for persistent storage');
  } catch (e) {
    console.error('❌ Failed to initialize Firebase Admin:', e && e.message);
    console.log('⚠️  Falling back to local file storage (NOT PERSISTENT on Render)');
    firestore = null;
  }
} else {
  console.log('⚠️  No FIREBASE_SERVICE_ACCOUNT configured - using local file storage (NOT PERSISTENT on Render)');
  console.log('💡 To enable persistent storage, set FIREBASE_SERVICE_ACCOUNT in Render environment variables');
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'scores.json');

// If DATABASE_URL is provided, use Postgres; otherwise pool will be null and file fallback used
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// No authentication required - scores are globally accessible
// Removed adminAuthMiddleware for open access

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
      // Check for specific error codes and provide helpful messages
      try {
        const code = e && e.code ? e.code : undefined;
        if (code === 5) {
          console.error('Firestore NOT_FOUND (code=5): Falling back to file storage');
        } else if (code === 7) {
          console.error('Firestore PERMISSION_DENIED (code=7): Falling back to file storage');
        } else if (code === 16) {
          console.error('Firestore UNAUTHENTICATED (code=16): Falling back to file storage');
        }
      } catch (ee) { console.error('Error while logging Firestore read error', ee); }
      // Fall through to file storage
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
      // Fall through to file storage
    }
  }

  // Fallback to file (always available)
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    console.error('Failed to read scores from file:', e);
    return [];
  }
}

async function insertScore(score) {
  if (pool) {
    console.log('💾 Saving score to PostgreSQL database');
    const sql = `INSERT INTO scores(id, name, email, score, answeredQuestions, totalQuestions, timeTaken, reason, receivedAt, date)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
    const vals = [score.id, score.name, score.email || null, score.score || null, score.answeredQuestions || null, score.totalQuestions || null, score.timeTaken || null, score.reason || null, score.receivedAt || null, score.date || null];
    await pool.query(sql, vals);
    return true;
  }

  // If Firestore configured, write to Firestore
  if (firestore) {
    try {
      console.log('🔥 Saving score to Firestore (persistent storage)');
      const id = score.id ? String(score.id) : String(Date.now());
      await firestore.collection('scores').doc(id).set(score);
      console.log('✅ Score saved to Firestore successfully');
      return true;
    } catch (e) {
      console.error('❌ Failed to save to Firestore:', e);
      console.log('⚠️  Falling back to local file storage (NOT PERSISTENT on Render)');
    }
  }

  // If S3 is configured, write to S3
  if (s3Client) {
    try {
      console.log('☁️  Saving score to S3 (persistent storage)');
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
      console.log('✅ Score saved to S3 successfully');
      return true;
    } catch (e) {
      console.error('❌ Failed to save to S3:', e);
      console.log('⚠️  Falling back to local file storage (NOT PERSISTENT on Render)');
    }
  }

  // File fallback (always available but NOT PERSISTENT on Render)
  try {
    console.log('📁 Saving score to local file (NOT PERSISTENT on Render restarts)');
    let arr = [];
    if (fs.existsSync(DATA_FILE)) {
      arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]');
    }
    arr.push(score);
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
    console.log('⚠️  Score saved to local file - will be lost if server restarts on Render');
    return true;
  } catch (e) {
    console.error('❌ Failed to save scores to file:', e);
    return false;
  }
}

// Ensure DB table if pool exists
ensureTable().catch(err => { if (err) console.error('ensureTable error', err); });

app.get('/api/scores', async (req, res) => {
  try {
    const rows = await readScores();
    // Return JSON for frontend consumption
    res.json(rows);
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

// Diagnostic endpoint to help debug configuration issues
app.get('/api/diagnose', (req, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      hasAdminUser: !!process.env.ADMIN_USER,
      hasAdminPass: !!process.env.ADMIN_PASS,
      hasFirebaseServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      hasS3Bucket: !!process.env.S3_BUCKET,
      hasAwsRegion: !!process.env.AWS_REGION,
    },
    storage: {
      mode: pool ? 'postgres' : firestore ? 'firestore' : s3Client ? 's3' : 'file',
      firestoreEnabled: !!firestore,
      s3Enabled: !!s3Client,
      postgresEnabled: !!pool,
      persistent: !!(pool || firestore || s3Client)
    },
    warnings: [],
    recommendations: []
  };
  
  // Add warnings and recommendations
  if (!firestore && !pool && !s3Client) {
    diagnostics.warnings.push('⚠️  Using local file storage - scores will be lost on server restart');
    diagnostics.recommendations.push('💡 Set FIREBASE_SERVICE_ACCOUNT for persistent storage');
  }
  
  if (firestore) {
    diagnostics.recommendations.push('✅ Firestore enabled - scores will persist across restarts');
  }
  
  if (pool) {
    diagnostics.recommendations.push('✅ PostgreSQL enabled - scores will persist across restarts');
  }
  
  if (s3Client) {
    diagnostics.recommendations.push('✅ S3 enabled - scores will persist across restarts');
  }
  
  res.json(diagnostics);
});

// Health check endpoint for Render and other hosting platforms
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    port: PORT,
    mode: pool ? 'postgres' : firestore ? 'firestore' : s3Client ? 's3' : 'file'
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
