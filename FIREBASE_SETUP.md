# Firebase Setup for Persistent Score Storage

## Problem
Currently, scores are saved to a local file that gets **wiped when Render restarts**. This means all quiz scores are lost when the server restarts.

## Solution: Firebase Firestore
Firebase provides free, persistent cloud storage that will keep your scores safe even when the server restarts.

## Quick Setup (5 minutes)

### 1. Create Firebase Project
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project"
3. Enter project name (e.g., "quiz-app-scores")
4. Accept terms and click "Create project"

### 2. Enable Firestore
1. In your Firebase project, go to "Firestore Database" in the left menu
2. Click "Create database"
3. Choose "Start in test mode" (allows read/write during setup)
4. Select a location (choose closest to your users)
5. Click "Create"

### 3. Get Service Account Key
1. In Firebase project, click ⚙️ (Settings) > "Project settings"
2. Go to "Service accounts" tab
3. Click "Generate new private key"
4. Save the JSON file (keep it secure!)

### 4. Add to Render Environment
1. Open your Render dashboard
2. Go to your service > "Environment"
3. Add new environment variable:
   - **Key**: `FIREBASE_SERVICE_ACCOUNT`
   - **Value**: Copy the entire JSON content from the service account file

### 5. Redeploy
1. Push your code changes to GitHub
2. Render will automatically redeploy
3. Check logs for "✅ Firebase Admin initialized for persistent storage"

## Verification
After setup, visit: `https://your-app.onrender.com/api/diagnose`

You should see:
```json
{
  "storage": {
    "mode": "firestore",
    "persistent": true
  },
  "recommendations": ["✅ Firestore enabled - scores will persist across restarts"]
}
```

## Benefits
- ✅ **Persistent storage** - scores survive server restarts
- ✅ **Real-time updates** - instant score updates
- ✅ **Free tier** - 1GB storage, 50k reads/day
- ✅ **Global access** - fast worldwide access
- ✅ **Automatic backup** - Google's infrastructure

## Alternative Options
If you prefer not to use Firebase, you can also use:
- **PostgreSQL** (Render provides free PostgreSQL)
- **AWS S3** (if you have AWS account)

## Troubleshooting
- **"NOT_FOUND" errors**: Check that Firestore is enabled in your Firebase project
- **"PERMISSION_DENIED"**: Ensure service account has Firestore permissions
- **"UNAUTHENTICATED"**: Verify the FIREBASE_SERVICE_ACCOUNT JSON is correctly formatted

## Security Notes
- Keep your service account JSON private
- Never commit it to Git
- Use test mode only during development
- Consider production security rules later
