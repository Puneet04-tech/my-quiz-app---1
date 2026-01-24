const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'scores.json');
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!FIREBASE_SERVICE_ACCOUNT) {
  console.error('Please set FIREBASE_SERVICE_ACCOUNT env var (raw JSON or base64) before running this migration.');
  process.exit(1);
}

let admin;
try {
  admin = require('firebase-admin');
} catch (e) {
  console.error('Please install firebase-admin (npm install firebase-admin)');
  process.exit(1);
}

let creds;
try {
  creds = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  try {
    creds = JSON.parse(Buffer.from(FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
  } catch (err) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT as JSON or base64 JSON:', err.message);
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(creds) });
const firestore = admin.firestore();

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

(async () => {
  console.log(`Migrating ${arr.length} records to Firestore collection 'scores'...`);
  for (const s of arr) {
    const id = s.id ? String(s.id) : String(Date.now()) + Math.random().toString(36).slice(2,8);
    try {
      await firestore.collection('scores').doc(id).set(s, { merge: false });
      console.log('Wrote', id);
    } catch (e) {
      console.error('Failed to write', id, e && e.message);
    }
  }
  console.log('Migration complete.');
  process.exit(0);
})();
