# Bryl Lim Portfolio on Cloud Run

Plain HTML/CSS/JavaScript portfolio served by Cloud Run, with public media assets in Cloud Storage and a Gemini-backed chatbot endpoint.

## Architecture

- **Cloud Run** serves the portfolio and owns `/api/chat`.
- **Cloud Storage** stores public media assets from `public/assets`.
- **Secret Manager** stores `GEMINI_API_KEY`.
- **Cloud Build** builds and pushes the container image to Artifact Registry.
- **Gemini API** embeds the visitor question for context selection, then generates the chat response from the server only. The browser never receives the API key.

## Deploy From Google Cloud Console

Use this path when deploying from the GCP Console browser UI.

### 1. Prepare Your GCP Project

In [Google Cloud Console](https://console.cloud.google.com/):

1. Select or create a project.
2. Make sure billing is enabled.
3. Open **Cloud Shell** from the top-right terminal icon.
4. Confirm the active project:

```bash
gcloud config get-value project
```

If it is not the right project:

```bash
gcloud config set project "your-project-id"
```

### 2. Put The Code In Cloud Shell

Cloud Shell needs a copy of this project before it can deploy.

If the project is in GitHub:

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

If you have a ZIP file instead:

1. In Cloud Shell, click **More** > **Upload**.
2. Upload the ZIP.
3. Run:

```bash
unzip portfolio.zip
cd portfolio
```

The folder should contain `Dockerfile`, `server.js`, `package.json`, `public/`, and `deploy-cloudshell.sh`.

### 3. Deploy With One Command

Interactive form, safest for manual use:

```bash
chmod +x ./deploy-cloudshell.sh && ./deploy-cloudshell.sh --project "your-project-id"
```

The script will prompt for your Gemini API key without printing it to the terminal.

Non-interactive form:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
chmod +x ./deploy-cloudshell.sh && ./deploy-cloudshell.sh --project "your-project-id"
```

Optional custom settings:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
export GEMINI_EMBEDDING_MODEL="gemini-embedding-2"
export CHAT_RATE_LIMIT="10"
export GLOBAL_RATE_LIMIT="500"

chmod +x ./deploy-cloudshell.sh && ./deploy-cloudshell.sh \
  --project "your-project-id" \
  --region "asia-southeast1" \
  --service "bryllim-site" \
  --bucket "your-project-id-bryllim-assets"
```

### 4. What The Script Creates

The Cloud Shell deploy script creates or reuses:

- required APIs: Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Storage
- Artifact Registry Docker repository: `bryllim`
- Cloud Storage bucket: `<project-id>-bryllim-assets`
- Secret Manager secret: `gemini-api-key`
- Cloud Run service: `bryllim-site`

It also:

- uploads `public/assets` to Cloud Storage
- makes the media bucket publicly readable
- sets long-lived cache headers on media assets
- builds the container with Cloud Build
- deploys Cloud Run with unauthenticated public access
- injects `GEMINI_API_KEY` into Cloud Run from Secret Manager
- configures default rate limits for the chat endpoint

### 5. Verify Deployment

At the end, the script prints:

```text
Service URL: https://...
Asset URL:   https://storage.googleapis.com/...
```

Open the **Service URL** and verify:

- the portfolio loads
- profile and gallery images load
- theme toggle works
- gallery controls work
- chat opens
- chat replies when a valid Gemini key is configured
- chatbot uses `GEMINI_EMBEDDING_MODEL` for relevant portfolio context selection before generating the answer

You can also check from Cloud Shell:

```bash
curl "$(gcloud run services describe bryllim-site --region asia-southeast1 --format='value(status.url)')/healthz"
```

Expected response:

```json
{"ok":true}
```

## Updating The Site

After changing files, redeploy from Cloud Shell:

```bash
./deploy-cloudshell.sh --project "your-project-id"
```

The script is idempotent. It reuses existing GCP resources, uploads the latest assets, creates a new Gemini secret version if `GEMINI_API_KEY` is provided, rebuilds the image, and deploys a new Cloud Run revision.

To skip re-uploading assets:

```bash
./deploy-cloudshell.sh --project "your-project-id" --skip-assets
```

## Configuration

Runtime environment variables:

- `GEMINI_API_KEY`: Gemini API key. Set through Secret Manager by the deploy script.
- `GEMINI_MODEL`: Gemini model. Defaults to `gemini-2.5-flash`.
- `GEMINI_EMBEDDING_MODEL`: embedding model used to select relevant portfolio context before chat generation. Defaults to `gemini-embedding-2`.
- `ASSET_BASE_URL`: public Cloud Storage asset URL. Defaults to `/assets` locally.
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
- `gemini-embedding-2` is used for embeddings/context selection. A generative Gemini model is still required for final chatbot replies.
- `/api/chat` is protected by same-origin checks, JSON body size limits, global rate limiting, and chat-specific rate limiting.
- Rate limiting is in Cloud Run instance memory. For stronger multi-instance abuse protection, add Cloud Armor, reCAPTCHA/Turnstile, or a shared Redis-backed limiter.
- Cloud Storage is public only for media assets. Do not upload private files or secrets to the asset bucket.
- For stricter production IAM, replace the default Cloud Run runtime service account with a dedicated service account that can access only the Gemini secret.

## Local Windows Deployment

This is optional. Prefer Cloud Shell for GCP Console deployment.

```powershell
$env:GEMINI_API_KEY="your-gemini-api-key"
.\deploy-cloudrun.ps1 -ProjectId "your-project-id"
```
