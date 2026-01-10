# My Quiz App

## Overview
My Quiz App is a local browser-based quiz application (Excel Quiz — Round 2). Recent updates add anti-cheat features, improved UI/UX, and optional webcam proctoring with multiple fallbacks.

## What's new (summary)
- Anti-cheat detection: selection, visibility/tab change, window blur (app focus loss), copy shortcuts, right-click/contextmenu, paste (including image paste), and PrintScreen key detection. Incidents are recorded with timestamps.
- Incident logging: recorded incidents are included in the payload sent to the server (or saved locally) and are shown on the results page.
- Results UI: prominent score circle, progress bar, percentage, and quick actions (`View Saved Scores`, `Review Answers`). Incidents are displayed in the results view.
- `scores.html`: responsive card-based display of saved scores, merged from server and local fallback; added `Clear Local Scores` action.
- Webcam proctoring (optional): user can enable on the start screen. The app attempts to load TF face-landmarks, falls back to BlazeFace, then to the browser `FaceDetector` API, and finally to a pixel-diff frame-comparison fallback when no ML model is available.
- Debug/tuning tools: threshold slider, frames-to-trigger input, and an overlay toggle to visualize landmarks/center/baseline during proctoring.

## Files of interest
- `index.html`: Main quiz UI, anti-cheat handlers, webcam proctoring and head-movement detection, results UI.
- `scores.html`: Improved list of saved scores (server + local fallback).
- `server.js` / `scores.json`: Minimal server and storage (optional — app works offline with `localStorage`).

## How detection works
- Head-movement detection attempts models in this order:
	1. `@tensorflow-models/face-landmarks-detection` (tfjs)
	2. `@tensorflow-models/blazeface` (tfjs)
	3. Browser `FaceDetector` (Shape Detection API)
	4. Pixel-diff fallback (frame-to-frame mean RGB difference)
- Detection computes a normalized movement value relative to video size and triggers termination when the configured threshold is exceeded for the configured number of consecutive checks.

## Run locally
1. Install dependencies (from PowerShell in the project folder):

```powershell
npm install
```

2. Start the server (optional — used to persist scores to disk):

```powershell
npm start
```

3. Open the app in your browser:

- With server: `http://localhost:3000/index.html`
- Without server: open `index.html` directly (features still work; scores save to browser `localStorage` under `localScores`).

Notes:
- Some browsers require HTTPS for camera access; localhost is typically allowed over HTTP. If you experience camera permission issues, try serving over HTTPS or use a Chromium-based browser.

## Deploy globally (free hosting options)

### Option 1: Deploy to Render (recommended, easy)
1. Push your code to GitHub
2. Visit [render.com](https://render.com) and sign up
3. Click "New +" → "Web Service"
4. Connect your GitHub repository
5. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
6. Click "Create Web Service"
7. Your app will be live at `https://your-app-name.onrender.com`

**Note**: Render's free tier may spin down after inactivity; first request takes ~30s to wake up.

### Option 2: Deploy to Railway
1. Push your code to GitHub
2. Visit [railway.app](https://railway.app) and sign up
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repository
5. Railway auto-detects Node.js and deploys
6. Your app will be live at the provided URL

### Option 3: Deploy to Vercel (serverless)
1. Push your code to GitHub
2. Visit [vercel.com](https://vercel.com) and sign up
3. Click "Add New" → "Project"
4. Import your GitHub repository
5. Vercel will auto-detect and deploy
6. Your app will be live at `https://your-app-name.vercel.app`

**Note**: For Vercel, you may need to convert `server.js` to serverless functions. Simpler to use Render or Railway for this app.

### Option 4: Deploy to Netlify (static + functions)
Good for the frontend, but requires converting server to Netlify Functions.

### Important for deployment:
- The server tracks completed users **in memory** — resets when the server restarts
- For persistent user tracking across restarts, you'd need to store completed users in the database or `scores.json`
- Webcam proctoring requires **HTTPS** (all hosting platforms provide this automatically)
- If using a custom domain, configure DNS to point to your hosting platform

## Quick test steps for proctoring and tuning
1. Open Developer Tools (F12) and the Console.
2. On the start screen: enter your name, check `Enable webcam proctoring`, enable `Overlay`, set `Threshold` low (e.g., `0.05`) and `Frames` to `1` or `2` for testing.
3. Start the quiz; the browser will request camera permission. Watch console logs for model selection and per-frame values (`head norm` or `pixel-diff mean`).
4. Move your head to trigger detections. The quiz will terminate when configured limits are exceeded and an incident is recorded.

## Notes & privacy
- No snapshots are uploaded by default — only incident metadata is recorded. If you want snapshots or uploads, that requires explicit server-side support and consent.
- Detection may be sensitive to lighting and camera quality; tune thresholds via the provided controls.

## Troubleshooting
- If the console prints `No face detection model available` the app will use a pixel-diff fallback (frame difference). Lower the threshold for testing.
- If models fail to load due to CDN/version issues, try a Chromium-based browser or ensure network access to jsDelivr.

## Preparing for deployment

Before deploying, ensure:
1. Your `package.json` has the correct start script:
   ```json
   "scripts": {
     "start": "node server.js"
   }
   ```

2. Create a `.gitignore` file if you don't have one:
   ```
   node_modules/
   scores.json
   .env
   ```

3. (Optional) Add a `PORT` environment variable handler — already done in `server.js`:
   ```javascript
   const PORT = process.env.PORT || 3000;
   ```

4. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

## Contributing
Improvements, bug reports and PRs are welcome.

## License
MIT
## Contributing
Pull requests and suggestions welcome.

## License
MIT