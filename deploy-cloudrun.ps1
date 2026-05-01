param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "asia-southeast1",
  [string]$ServiceName = "bryllim-site",
  [string]$BucketName = "",
  [string]$ArtifactRepo = "bryllim",
  [string]$GeminiModel = "gemini-2.5-flash",
  [string]$GeminiEmbeddingModel = "gemini-embedding-2",
  [string]$SecretName = "gemini-api-key",
  [string]$GeminiApiKey = "",
  [int]$GlobalRateLimit = 500,
  [int]$GlobalRateLimitWindowMs = 900000,
  [int]$ChatRateLimit = 10,
  [int]$ChatRateLimitWindowMs = 60000,
  [int]$ChatMaxMessages = 8,
  [int]$ChatMaxMessageLength = 800,
  [switch]$SkipAssetUpload
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found in PATH."
  }
}

function Run {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [string[]]$Command
  )

  Write-Host ""
  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Command[0] @($Command | Select-Object -Skip 1)
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $($Command -join ' ')"
  }
}

function Command-Succeeds {
  param([string[]]$Command)
  & $Command[0] @($Command | Select-Object -Skip 1) *> $null
  return $LASTEXITCODE -eq 0
}

function Read-SecretPlainText {
  $secure = Read-Host "Gemini API key" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

Require-Command "gcloud"

if (-not $BucketName) {
  $BucketName = "$ProjectId-bryllim-assets"
}

if (-not $GeminiApiKey -and $env:GEMINI_API_KEY) {
  $GeminiApiKey = $env:GEMINI_API_KEY
}

if (-not $GeminiApiKey) {
  $GeminiApiKey = Read-SecretPlainText
}

if (-not $GeminiApiKey) {
  throw "Gemini API key is required. Pass -GeminiApiKey or set GEMINI_API_KEY."
}

$AssetBaseUrl = "https://storage.googleapis.com/$BucketName"
$Image = "$Region-docker.pkg.dev/$ProjectId/$ArtifactRepo/$ServiceName"
$TempSecretFile = Join-Path $PSScriptRoot ".gemini-key.tmp"

Run "Set active gcloud project" @("gcloud", "config", "set", "project", $ProjectId)

Run "Enable required Google Cloud APIs" @(
  "gcloud",
  "services",
  "enable",
  "run.googleapis.com",
  "cloudbuild.googleapis.com",
  "artifactregistry.googleapis.com",
  "secretmanager.googleapis.com",
  "storage.googleapis.com"
)

if (-not (Command-Succeeds @("gcloud", "artifacts", "repositories", "describe", $ArtifactRepo, "--location", $Region))) {
  Run "Create Artifact Registry repository" @(
    "gcloud",
    "artifacts",
    "repositories",
    "create",
    $ArtifactRepo,
    "--repository-format=docker",
    "--location",
    $Region,
    "--description",
    "Docker images for Bryl Lim portfolio"
  )
} else {
  Write-Host "Artifact Registry repository exists: $ArtifactRepo" -ForegroundColor DarkGray
}

if (-not (Command-Succeeds @("gcloud", "storage", "buckets", "describe", "gs://$BucketName"))) {
  Run "Create Cloud Storage asset bucket" @(
    "gcloud",
    "storage",
    "buckets",
    "create",
    "gs://$BucketName",
    "--location",
    $Region,
    "--uniform-bucket-level-access"
  )
} else {
  Write-Host "Cloud Storage bucket exists: gs://$BucketName" -ForegroundColor DarkGray
}

Run "Allow public reads for portfolio media assets" @(
  "gcloud",
  "storage",
  "buckets",
  "add-iam-policy-binding",
  "gs://$BucketName",
  "--member=allUsers",
  "--role=roles/storage.objectViewer"
)

if (-not $SkipAssetUpload) {
  Run "Upload media assets to Cloud Storage" @(
    "gcloud",
    "storage",
    "cp",
    "--recursive",
    (Join-Path $PSScriptRoot "public/assets/*"),
    "gs://$BucketName"
  )

  Run "Set long-lived cache headers on media assets" @(
    "gcloud",
    "storage",
    "objects",
    "update",
    "gs://$BucketName/**",
    "--cache-control=public,max-age=31536000,immutable"
  )
}

try {
  Set-Content -Path $TempSecretFile -Value $GeminiApiKey -NoNewline

  if (-not (Command-Succeeds @("gcloud", "secrets", "describe", $SecretName))) {
    Run "Create Gemini API key secret" @(
      "gcloud",
      "secrets",
      "create",
      $SecretName,
      "--data-file",
      $TempSecretFile
    )
  } else {
    Run "Add new Gemini API key secret version" @(
      "gcloud",
      "secrets",
      "versions",
      "add",
      $SecretName,
      "--data-file",
      $TempSecretFile
    )
  }
} finally {
  if (Test-Path $TempSecretFile) {
    Remove-Item -LiteralPath $TempSecretFile -Force
  }
}

$ProjectNumber = (& gcloud projects describe $ProjectId --format="value(projectNumber)").Trim()
if (-not $ProjectNumber) {
  throw "Could not resolve project number for $ProjectId."
}

$RuntimeServiceAccount = "$ProjectNumber-compute@developer.gserviceaccount.com"

Run "Grant Cloud Run runtime access to Gemini secret" @(
  "gcloud",
  "secrets",
  "add-iam-policy-binding",
  $SecretName,
  "--member=serviceAccount:$RuntimeServiceAccount",
  "--role=roles/secretmanager.secretAccessor"
)

Run "Build and push container with Cloud Build" @(
  "gcloud",
  "builds",
  "submit",
  "--tag",
  $Image,
  $PSScriptRoot
)

Run "Deploy Cloud Run service" @(
  "gcloud",
  "run",
  "deploy",
  $ServiceName,
  "--image",
  $Image,
  "--region",
  $Region,
  "--allow-unauthenticated",
  "--set-env-vars",
  "ASSET_BASE_URL=$AssetBaseUrl,GEMINI_MODEL=$GeminiModel,GEMINI_EMBEDDING_MODEL=$GeminiEmbeddingModel,GLOBAL_RATE_LIMIT=$GlobalRateLimit,GLOBAL_RATE_LIMIT_WINDOW_MS=$GlobalRateLimitWindowMs,CHAT_RATE_LIMIT=$ChatRateLimit,CHAT_RATE_LIMIT_WINDOW_MS=$ChatRateLimitWindowMs,CHAT_MAX_MESSAGES=$ChatMaxMessages,CHAT_MAX_MESSAGE_LENGTH=$ChatMaxMessageLength",
  "--set-secrets",
  "GEMINI_API_KEY=$SecretName`:latest"
)

$ServiceUrl = (& gcloud run services describe $ServiceName --region $Region --format="value(status.url)").Trim()

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
Write-Host "Service URL: $ServiceUrl"
Write-Host "Asset URL:   $AssetBaseUrl"
