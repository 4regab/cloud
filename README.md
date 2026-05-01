# Bryl Lim Portfolio on Cloud Run

Plain HTML/CSS/JavaScript portfolio served by Cloud Run, with media assets intended for a public Cloud Storage bucket and a Gemini-backed chat endpoint.

## Local Run

```powershell
npm install
$env:GEMINI_API_KEY="your-gemini-api-key"
npm run dev
```

Open `http://localhost:8080`.

Without `GEMINI_API_KEY`, the portfolio still works and `/api/chat` returns a setup message.

## Configuration

Environment variables:

- `GEMINI_API_KEY`: Gemini API key used only by the Cloud Run server.
- `GEMINI_MODEL`: optional model override. Defaults to `gemini-2.5-flash`.
- `ASSET_BASE_URL`: public base URL for Cloud Storage assets. Defaults to `/assets` for local development.
- `PORT`: Cloud Run supplies this automatically. Defaults to `8080`.

## Cloud Storage Assets

Replace `PROJECT_ID` with your Google Cloud project ID.

```powershell
$PROJECT_ID="your-project-id"
$BUCKET="$PROJECT_ID-bryllim-assets"

gcloud storage buckets create "gs://$BUCKET" --location=asia-southeast1 --uniform-bucket-level-access
gcloud storage cp --recursive public/assets/* "gs://$BUCKET"
gcloud storage objects update "gs://$BUCKET/**" --cache-control="public,max-age=31536000,immutable"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="allUsers" --role="roles/storage.objectViewer"
```

The public asset base URL will be:

```text
https://storage.googleapis.com/PROJECT_ID-bryllim-assets
```

## Cloud Run Deploy

### Google Cloud Console / Cloud Shell

Open Cloud Shell from the Google Cloud Console, go to this project folder, then run:

```bash
chmod +x ./deploy-cloudshell.sh
./deploy-cloudshell.sh --project "your-project-id"
```

The script prompts for the Gemini API key if `GEMINI_API_KEY` is not already set. It enables required APIs, creates/reuses the Artifact Registry repo, creates/reuses the asset bucket, uploads `public/assets`, creates/reuses the Secret Manager secret, builds the container with Cloud Build, and deploys Cloud Run.

Non-interactive Cloud Shell form:

```bash
export GEMINI_API_KEY="your-gemini-api-key"
./deploy-cloudshell.sh --project "your-project-id"
```

Optional flags:

```bash
./deploy-cloudshell.sh \
  --project "your-project-id" \
  --region "asia-southeast1" \
  --service "bryllim-site" \
  --bucket "your-project-id-bryllim-assets"
```

### Local PowerShell

```powershell
.\deploy-cloudrun.ps1 -ProjectId "your-project-id"
```

The PowerShell script is for local Windows deployment, not Google Cloud Console.

Optional non-interactive form:

```powershell
$env:GEMINI_API_KEY="your-gemini-api-key"
.\deploy-cloudrun.ps1 -ProjectId "your-project-id" -Region "asia-southeast1" -ServiceName "bryllim-site"
```

Manual deploy commands are below for troubleshooting or custom pipelines.

```powershell
$PROJECT_ID="your-project-id"
$REGION="asia-southeast1"
$SERVICE="bryllim-site"
$REPO="bryllim"
$BUCKET="$PROJECT_ID-bryllim-assets"
$ASSET_BASE_URL="https://storage.googleapis.com/$BUCKET"
$IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE"

gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud artifacts repositories create $REPO --repository-format=docker --location $REGION
gcloud builds submit --tag $IMAGE
gcloud run deploy $SERVICE `
  --image $IMAGE `
  --region $REGION `
  --allow-unauthenticated `
  --set-env-vars "ASSET_BASE_URL=$ASSET_BASE_URL,GEMINI_MODEL=gemini-2.5-flash" `
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest"
```

Create the `gemini-api-key` secret first:

```powershell
$env:GEMINI_KEY="your-gemini-api-key"
Set-Content -Path .gemini-key.tmp -Value $env:GEMINI_KEY -NoNewline
gcloud secrets create gemini-api-key --data-file=.gemini-key.tmp
Remove-Item .gemini-key.tmp
gcloud secrets add-iam-policy-binding gemini-api-key `
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" `
  --role="roles/secretmanager.secretAccessor"
```

Use your project number in the service account line, or deploy with a dedicated service account and grant that account secret access.
