const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_FILE = path.join(__dirname, 'scores.json');
const DATABASE_URL = process.env.DATABASE_URL || null;

if (!DATABASE_URL) {
  console.error('Please set DATABASE_URL env var before running migrate.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function ensureTable() {
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

async function migrate() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('No scores.json found, nothing to migrate.');
    process.exit(0);
  }

  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const arr = JSON.parse(raw || '[]');
  if (!Array.isArray(arr) || arr.length === 0) {
    console.log('No data to migrate.');
    process.exit(0);
  }

  await ensureTable();

  for (const s of arr) {
    try {
      const sql = `INSERT INTO scores(id, name, email, score, answeredQuestions, totalQuestions, timeTaken, reason, receivedAt, date)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                   ON CONFLICT (id) DO NOTHING`;
      const vals = [s.id || Date.now(), s.name, s.email || null, s.score || null, s.answeredQuestions || null, s.totalQuestions || null, s.timeTaken || null, s.reason || null, s.receivedAt || null, s.date || null];
      await pool.query(sql, vals);
      console.log(`Inserted ${s.id || 'id-less'} `);
    } catch (e) {
      console.error('Failed inserting', e);
    }
  }

  console.log('Migration complete.');
  process.exit(0);
}

migrate().catch(err => { console.error(err); process.exit(2); });
