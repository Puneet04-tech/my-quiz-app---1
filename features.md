# Project Features

This document provides a detailed breakdown of every feature implemented in the quiz application.

## Quiz UI
- 25 multiple-choice questions with clue and question text.
- Navigation buttons (Previous, Next, Submit) with dynamic visibility.
- Question grid showing answered/current/marked/unanswered states.
- Mark-for-review toggle per question.
- Clear selection button per question.
- Timer display with warning/danger color changes at 10 and 5 minutes.
- Score results page with:
  - Big score circle and progress bar.
  - Time taken or "Time's Up" messaging.
  - Recorded incidents list if any anti‑cheat events occurred.
  - Review Answers modal.
  - Server submission confirmation or fallback messaging.

## Anti‑Cheat Mechanisms
- Detect text selection inside quiz area.
- Detect tab visibility changes (visibilitychange event).
- Detect window blur (loss of focus).
- Key detection:
  - PrintScreen key press.
  - Ctrl/Cmd+C copy shortcut.
- Clipboard events:
  - copy event detection inside quiz.
  - contextmenu event (right-click) blocking inside quiz.
  - paste event detection of images.
- Incidents recorded with timestamp, type, and details.
- Incidents included in payload to server and shown on results page.
- On incident, quiz termination with a reason if configured.

## Webcam Proctoring
- Optional start-screen checkbox to enable camera.
- Model loading priority:
  1. @tensorflow-models/face-landmarks-detection (tfjs)
  2. @tensorflow-models/blazeface (tfjs)
  3. Browser FaceDetector API (shape detection)
  4. Pixel-diff fallback (frame difference) when no model available.
- Head-movement tracking:
  - Baseline captured on start.
  - Norm calculation relative to video dimensions.
  - Threshold and frame count adjustable via UI controls.
- Debug overlay showing keypoints, center, baseline.
- Periodic snapshot logging (not transmitted by default).
- Incident recording for missing face or movement beyond limits.

## Storage Backends
- **Local file**: `scores.json` in project root (JSON array).
- **Postgres**: if `DATABASE_URL` env var present. Table created automatically.
- **Firestore**: if `FIREBASE_SERVICE_ACCOUNT` env var present. Writes to `scores` collection.
- **S3**: if `S3_BUCKET` and AWS envoy vars present. Stores `scores.json` object.
- Fallback order: Postgres → Firestore → S3 → file.

## Server Endpoints
- `GET /api/scores` → returns CSV export of saved scores (protected by admin auth).
- `POST /api/scores` → accepts score payload (open to public), persists to configured backend.
- `POST /api/clear-scores` → removes all persisted scores (admin only).
- `GET /api/export-scores` → same as `/api/scores` (for faculty export).
- `GET /api/quiz-status/:name` → returns `{completed:true/false}` based on backend and in-memory cache.
- `GET /api/storage-info` → reports which storage mode is active and writable status; also shows Firestore project info if available.
- `GET /admin-login` and `POST /admin-login` → friendly login page for setting admin cookie.
- Static hosting of project files with admin auth middleware protecting relevant routes (`scores.html`, `/api/clear-scores`, `/api/export-scores`).

## Authentication
- Basic Auth when `ADMIN_USER`/`ADMIN_PASS` env vars are set.
- Middleware checks cookie `admin_auth` first for browser sessions.
- Redirect to `/admin-login` for HTML clients; query `?basic=1` forces Basic challenge.

## Client‑side Storage Fallback
- If POST /api/scores fails, scores are saved under `localScores` key in `localStorage`.
- `scores.html` merges server data with local scores when the page is open, showing both.
- Button on `scores.html` to clear `localStorage` entries.

## Deployment Notes
- Works as a static site when server not running (scores saved locally).
- Express server listens on `process.env.PORT` or 3000.
- Simple `npm start` for local development.
- Ready for Render, Railway, Vercel, Netlify as described in README.

## Environment Variables Summary
- `PORT` – port for server (default 3000).
- `DATABASE_URL` – Postgres connection string.
- `FIREBASE_SERVICE_ACCOUNT` – JSON or base64 string for Firestore.
- `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` – for S3.
- `ADMIN_USER`, `ADMIN_PASS` – credentials for admin routes.

## Developer Utilities
- `migrate_scores.js` – helper to convert `scores.json` to Postgres or Firestore.
- `migrate_to_firestore.js` – wrapper for migrating from file/DB to Firestore.

---

This file is intended as a comprehensive reference when auditing the feature set or extending the project.