# Bryl Lim Portfolio on Cloud Run

Plain HTML/CSS/JavaScript portfolio served by Cloud Run, with public media assets in Cloud Storage and an embedding-based chatbot endpoint.

## Architecture

- **Cloud Run** serves the portfolio and owns `/api/chat`.
- **Cloud Storage** stores public media assets from `public/assets`.
- **Secret Manager** stores `GEMINI_API_KEY`.
- **Cloud Build** builds and pushes the container image to Artifact Registry.
- **Gemini API** embeds the visitor question and the Markdown knowledge base for semantic matching. The bot returns matched Markdown context without using a generative LLM.
- **Markdown knowledge base** lives at `content/portfolio.md`.

## Deploy From Google Cloud Console

Use this path when deploying from the GCP Console browser UI.

Deployment has two parts:

1. **Clone or upload the repo into Cloud Shell.** This gives Cloud Shell the source code.
2. **Run the deploy script.** This configures Google Cloud resources and deploys Cloud Run.

Cloning the repo alone does not create Cloud Run, Cloud Storage, Secret Manager, or Gemini configuration.

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

### 2. Clone The Repo In Cloud Shell

Cloud Shell needs a copy of this project before it can deploy.

Recommended GitHub flow:

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

If you fork this portfolio, replace `YOUR_USERNAME/YOUR_REPO` with your fork URL.

Alternative ZIP upload flow:

1. In Cloud Shell, click **More** > **Upload**.
2. Upload the ZIP.
3. Run:

```bash
unzip portfolio.zip
cd portfolio
```

The folder should contain `Dockerfile`, `server.js`, `package.json`, `public/`, `content/`, and `deploy-cloudshell.sh`.

### 3. Configure The Portfolio Before Deploying

Before running the Cloud Run deploy, edit the repo files for your own portfolio:

- `content/portfolio.md`: chatbot knowledge base. The bot only answers from this file.
- `public/index.html`: visible portfolio content and links.
- `public/assets`: profile image, gallery images, favicons, and other public media.
- `public/styles.css`: visual styling.

In Cloud Shell, you can use the built-in editor:

```bash
cloudshell edit content/portfolio.md
```

Do not put secrets in repo files. The Gemini API key is entered during deploy and stored in Secret Manager.

### 4. Configure And Deploy Cloud Run With One Command

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
export CHAT_MIN_ANSWER_SCORE="0.16"

chmod +x ./deploy-cloudshell.sh && ./deploy-cloudshell.sh \
  --project "your-project-id" \
  --region "asia-southeast1" \
  --service "bryllim-site" \
  --bucket "your-project-id-bryllim-assets"
```

This command does the Cloud Run/GCP configuration. It is not just a local build command.

### 5. What The Script Configures In GCP

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

### 6. Verify Deployment

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
- chat replies from matched sections in `content/portfolio.md` when a valid Gemini key is configured
- chatbot uses `GEMINI_EMBEDDING_MODEL` for semantic matching only; it does not call a generative LLM

You can also check from Cloud Shell:

```bash
curl "$(gcloud run services describe bryllim-site --region asia-southeast1 --format='value(status.url)')/healthz"
```

Expected response:

```json
{"ok":true}
```

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
- `GEMINI_EMBEDDING_MODEL`: embedding model used to select relevant portfolio context. Defaults to `gemini-embedding-2`.
- `ASSET_BASE_URL`: public Cloud Storage asset URL. Defaults to `/assets` locally.
- `GLOBAL_RATE_LIMIT`: requests per visitor window across the site. Defaults to `500`.
- `GLOBAL_RATE_LIMIT_WINDOW_MS`: global limiter window. Defaults to `900000`.
- `CHAT_RATE_LIMIT`: chat messages per visitor window. Defaults to `10`.
- `CHAT_RATE_LIMIT_WINDOW_MS`: chat limiter window. Defaults to `60000`.
- `CHAT_MAX_MESSAGES`: max recent chat messages forwarded to Gemini. Defaults to `8`.
- `CHAT_MAX_MESSAGE_LENGTH`: max characters per chat message. Defaults to `800`.
- `CHAT_MIN_ANSWER_SCORE`: minimum embedding similarity needed before returning a matched answer. Defaults to `0.16`.
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
- `gemini-embedding-2` is used for semantic matching. No generative Gemini model is used for chatbot replies.
- `/api/chat` is protected by same-origin checks, JSON body size limits, global rate limiting, and chat-specific rate limiting.
- Rate limiting is in Cloud Run instance memory. For stronger multi-instance abuse protection, add Cloud Armor, reCAPTCHA/Turnstile, or a shared Redis-backed limiter.
- Cloud Storage is public only for media assets. Do not upload private files or secrets to the asset bucket.
- For stricter production IAM, replace the default Cloud Run runtime service account with a dedicated service account that can access only the Gemini secret.

## Troubleshooting

### Browser Console: Content Security Policy blocks inline script

The app uses a strict CSP with per-request nonces. If you see this after deployment, redeploy the latest code so Cloud Run serves `index.html` through `server.js`; opening `public/index.html` directly or serving it from a plain static host will leave the `__CSP_NONCE__` placeholder unresolved.

### Chat returns `500`

Check Cloud Run logs first:

```bash
gcloud run services logs read bryllim-site --region asia-southeast1 --limit 50
```

Common causes:

- `GEMINI_API_KEY` is missing, invalid, or has no Gemini API access.
- `content/portfolio.md` is missing from the deployed container.
- The selected embedding model is unavailable for the API key/project.
- Gemini quota or rate limits were exceeded.

### Update chatbot knowledge

Edit `content/portfolio.md`, then redeploy:

```bash
./deploy-cloudshell.sh --project "your-project-id"
```

The chatbot does not invent answers. It returns the best matching sections from this Markdown file or a contact fallback when there is no good match.

## Local Windows Deployment

This is optional. Prefer Cloud Shell for GCP Console deployment.

```powershell
$env:GEMINI_API_KEY="your-gemini-api-key"
.\deploy-cloudrun.ps1 -ProjectId "your-project-id"
```
