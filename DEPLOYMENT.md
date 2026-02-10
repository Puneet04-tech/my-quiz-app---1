# Render Deployment Guide

## Fixed Issues
✅ **Authentication**: Now properly prompts for credentials instead of showing generic error
✅ **Server Availability**: Added health check endpoint for Render monitoring
✅ **Error Handling**: Better error messages for authentication and server issues

## Environment Variables Required

In your Render service dashboard, set these environment variables:

### Required for Authentication
```
ADMIN_USER=faculty
ADMIN_PASS=your_strong_password_here
```

### Required for Data Persistence (Choose ONE)
**Option 1: Firebase (Recommended)**
```
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"your-project-id",...}
```

**Option 2: S3**
```
S3_BUCKET=your-unique-bucket-name
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key_id
AWS_SECRET_ACCESS_KEY=your_secret
```

**Option 3: PostgreSQL**
```
DATABASE_URL=postgres://user:pass@host:5432/dbname
```

### Optional
```
NODE_ENV=production
PORT=3000
```

## Deployment Steps

1. **Push to GitHub** (if not already done)
2. **Create Render Web Service**
   - Connect your GitHub repository
   - Select "Node" as runtime
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/health`

3. **Set Environment Variables** in Render dashboard
4. **Deploy** - Render will automatically deploy

## Accessing Scores Page

After deployment:
1. Go to `https://your-app.onrender.com/scores.html`
2. Browser will show Basic Auth dialog
3. Enter the ADMIN_USER and ADMIN_PASS you set
4. You should now see the scores page

## Troubleshooting

### "Authentication required" but no prompt
- Clear browser cache and cookies
- Try incognito/private window
- Ensure ADMIN_USER and ADMIN_PASS are set in Render environment

### "Server not available"
- Check Render service logs
- Ensure health check is passing
- Verify environment variables are correctly set

### Firestore NOT_FOUND Error (Code 5)
This is the most common issue with Firebase deployment:

**Symptoms:**
- Server logs show "Failed to write score to Firestore: 5 NOT_FOUND"
- App still works but uses file storage fallback

**Solutions:**
1. **Check Service Account JSON:**
   - Ensure `FIREBASE_SERVICE_ACCOUNT` is valid JSON
   - Verify `project_id` matches your actual GCP project
   - Make sure there are no extra quotes or formatting issues

2. **Enable Firestore:**
   - Go to Google Cloud Console
   - Select your project
   - Go to Firestore Database
   - Click "Create database" if not enabled

3. **Service Account Permissions:**
   - Go to IAM & Admin → Service Accounts
   - Ensure your service account has "Cloud Datastore User" role
   - Or grant "Firestore Admin" for full access

4. **Format Check:**
   - If using multiline JSON in Render, ensure proper formatting
   - Consider base64 encoding if Render has issues with multiline values

**Quick Fix:**
The app now automatically falls back to file storage when Firestore fails, so your app will continue working even with Firebase configuration issues.

### Data not persisting
- Ensure one persistence option is configured (Firebase/S3/PostgreSQL)
- Check service account permissions
- Verify environment variables are correctly formatted
- Check Render logs for specific error messages

## Health Check

The app now includes `/health` endpoint that returns:
```json
{
  "status": "ok",
  "timestamp": "2026-02-10T...",
  "port": 3000,
  "mode": "firestore" // or "s3", "postgres", "file"
}
```

Render will use this for service monitoring.
