# Portfolio Template on Cloud Run

Plain HTML/CSS/JavaScript portfolio template served by Cloud Run, with private media assets stored in Cloud Storage and served through the Cloud Run domain, plus a Gemini 2.5 Flash-Lite chatbot endpoint.

## Architecture

- **Cloud Run** serves the portfolio, proxies `/assets`, and owns `/api/chat`.
- **Cloud Storage** stores the media assets privately; Cloud CDN can be added in front of `/assets` later if you front the bucket with an HTTPS load balancer.
- **Secret Manager** stores `GEMINI_API_KEY`.
- **Cloud Build** builds and pushes the container image to Artifact Registry.
- **Gemini API** uses `gemini-2.5-flash-lite` to answer from the Markdown knowledge base.
- **Markdown knowledge base** lives at `public/context.md`.

## GCP Deployment Guide

This is the recommended Cloud Shell workflow.

### 1. Prepare the GCP project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select or create a project.
3. Enable billing.
4. Open **Cloud Shell**.
5. Check the active project:

```bash
gcloud config get-value project
```

6. If needed, switch to the right project:

```bash
gcloud config set project "your-project-id"
```

### 2. Get the source code into Cloud Shell

Recommended GitHub flow:

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

Alternative ZIP upload flow:

1. In Cloud Shell, click **More** > **Upload**.
2. Upload the ZIP.
3. Run:

```bash
unzip portfolio.zip
cd portfolio
```

The repo should contain `Dockerfile`, `server.js`, `package.json`, `public/`, and `deploy-cloudshell.sh`.

### 3. Edit the template content

Before deploying, customize these files:

- `public/index.html`: visible page content
- `public/context.md`: chat knowledge base
- `public/assets`: profile image, gallery images, favicon files, and other public media
- `public/styles.css`: visual styling

Open the editor in Cloud Shell with:

```bash
cloudshell edit public/context.md
```

Do not place secrets in repo files. The Gemini API key should be stored in Secret Manager or entered at deploy time.

### 4. Deploy to Cloud Run

The deploy script creates or reuses the Google Cloud resources and deploys the service.

Interactive form:

```bash
chmod +x ./deploy-cloudshell.sh && ./deploy-cloudshell.sh --project "your-project-id"
```

Non-interactive form:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
chmod +x ./deploy-cloudshell.sh && ./deploy-cloudshell.sh --project "your-project-id"
```

With custom settings:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
export GEMINI_MODEL="gemini-2.5-flash-lite"
export CHAT_RATE_LIMIT="10"
export GLOBAL_RATE_LIMIT="500"

chmod +x ./deploy-cloudshell.sh && ./deploy-cloudshell.sh \
  --project "your-project-id" \
  --region "asia-southeast1" \
  --service "bryl" \
  --bucket "your-project-id-bryllim-assets"
```

### 5. What gets created

The deploy script creates or reuses:

- Cloud Run service: `bryl`
- Cloud Storage bucket: `<project-id>-bryllim-assets`
- Secret Manager secret: `gemini-api-key`
- Artifact Registry repository: `bryllim`
- Required APIs: Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Storage

It also:

- uploads `public/assets` to a private Cloud Storage bucket
- serves assets through Cloud Run at `/assets`
- sets long-lived cache headers on asset objects
- deploys Cloud Run with public access
- injects `GEMINI_API_KEY` from Secret Manager

### 6. Verify the deployment

The script prints:

```text
Service URL: https://...
Asset URL:   /assets
```

Check the service:

```bash
curl "$(gcloud run services describe bryl --region asia-southeast1 --format='value(status.url)')/healthz"
```

Expected:

```json
{"ok":true}
```

Open the service URL and verify the page, gallery, and chat.

### 7. Update later

After changes:

```bash
git pull
./deploy-cloudshell.sh --project "your-project-id"
```

To skip media re-upload:

```bash
./deploy-cloudshell.sh --project "your-project-id" --skip-assets
```

## Add Cloud CDN for assets

Use this if you want faster image delivery without exposing the bucket directly.

1. Keep Cloud Run serving the HTML and `/api/chat`.
2. Keep `public/assets` in the private Cloud Storage bucket.
3. Create an HTTPS load balancer with a **backend bucket** pointing to that bucket.
4. Enable **Cloud CDN** on the backend bucket.
5. Set `ASSET_BASE_URL` to the CDN hostname, for example `https://cdn.example.com`.
6. Redeploy so `public/index.html` and `/config.js` use the CDN URL for asset links.

Notes:
- Keep `Cache-Control` headers long-lived on asset objects.
- Do not make the bucket public if you want the CDN to remain the only public path.
- If you change asset URLs later, invalidate the CDN cache for the affected paths.

## Updating The Site

After changing repo files, redeploy from Cloud Shell:

```bash
./deploy-cloudshell.sh --project "your-project-id"
```

The script is idempotent. It reuses existing GCP resources, uploads the latest assets, creates a new Gemini secret version if `GEMINI_API_KEY` is provided, rebuilds the image, and deploys a new Cloud Run revision.

If your code lives in GitHub, the normal update flow is:

```bash
git pull
./deploy-cloudshell.sh --project "your-project-id"
```

To skip re-uploading assets:

```bash
./deploy-cloudshell.sh --project "your-project-id" --skip-assets
```

## Configuration

Runtime environment variables:

- `GEMINI_API_KEY`: Gemini API key. Set through Secret Manager by the deploy script.
- `GEMINI_MODEL`: Gemini chat model. Defaults to `gemini-2.5-flash-lite`.
- `ASSET_BASE_URL`: asset path. Defaults to `/assets`.
- `ASSET_BUCKET_NAME`: private Cloud Storage bucket used by Cloud Run to serve media.
- `GLOBAL_RATE_LIMIT`: requests per visitor window across the site. Defaults to `500`.
- `GLOBAL_RATE_LIMIT_WINDOW_MS`: global limiter window. Defaults to `900000`.
- `CHAT_RATE_LIMIT`: chat messages per visitor window. Defaults to `10`.
- `CHAT_RATE_LIMIT_WINDOW_MS`: chat limiter window. Defaults to `60000`.
- `CHAT_MAX_MESSAGES`: max recent chat messages forwarded to Gemini. Defaults to `8`.
- `CHAT_MAX_MESSAGE_LENGTH`: max characters per chat message. Defaults to `800`.
- `ALLOWED_CHAT_ORIGINS`: optional comma-separated list of allowed browser origins for `/api/chat`; same-origin is allowed automatically.
- `PORT`: supplied automatically by Cloud Run. Defaults to `8080` locally.

## Local Development

```powershell
npm install
$env:GEMINI_API_KEY="your-gemini-api-key"
npm run dev
```

Open `http://localhost:8080`.

Without `GEMINI_API_KEY`, the portfolio still works and `/api/chat` returns a setup message.

## Security Notes

- Gemini API keys are stored in Secret Manager and injected into Cloud Run only at runtime.
- Chat uses `gemini-2.5-flash-lite` with `public/context.md` as strict context.
- Chat also applies Gemini safety settings for harassment, hate speech, sexual content, and dangerous content.
- `/api/chat` is protected by same-origin checks, JSON body size limits, global rate limiting, and chat-specific rate limiting.
- Rate limiting is in Cloud Run instance memory. For stronger multi-instance abuse protection, add Cloud Armor, reCAPTCHA/Turnstile, or a shared Redis-backed limiter.
- Cloud Storage is private; Cloud Run reads media from it and serves the files from the app domain.
- For stricter production IAM, replace the default Cloud Run runtime service account with a dedicated service account that can access only the Gemini secret.

## Troubleshooting

### Browser Console: Content Security Policy blocks inline script

The app uses a strict CSP with per-request nonces. If you see this after deployment, redeploy the latest code so Cloud Run serves `index.html` through `server.js`; opening `public/index.html` directly or serving it from a plain static host will leave the `__CSP_NONCE__` placeholder unresolved.

### Chat returns `500`

Check Cloud Run logs first:

```bash
gcloud run services logs read bryl --region asia-southeast1 --limit 50
```

Common causes:

- `GEMINI_API_KEY` is missing, invalid, or has no Gemini API access.
- `public/context.md` is missing from the deployed container.
- The selected Gemini model is unavailable for the API key/project. Default is `gemini-2.5-flash-lite`.
- Gemini quota or rate limits were exceeded.

### Update chatbot knowledge

Edit `public/context.md`, then redeploy:

```bash
./deploy-cloudshell.sh --project "your-project-id"
```

The chatbot is instructed to answer only from this Markdown file and refuse unknown topics instead of inventing facts.

## Convert Images To WebP

Most portfolio media should be WebP before deployment:

```bash
npm install
npm run assets:webp
```

The script converts PNG files under `public/assets` to WebP and skips `public/assets/favicons`.

