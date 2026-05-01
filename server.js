import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { GoogleGenAI } from "@google/genai";
import { access, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();
const port = process.env.PORT || 8080;
const assetBaseUrl = (process.env.ASSET_BASE_URL || "/assets").replace(/\/$/, "");
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;
const assetBucketName = process.env.ASSET_BUCKET_NAME || process.env.BUCKET_NAME || "";
const chatWindowMs = Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS || 60_000);
const chatLimit = Number(process.env.CHAT_RATE_LIMIT || 10);
const globalWindowMs = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 15 * 60_000);
const globalLimit = Number(process.env.GLOBAL_RATE_LIMIT || 500);
const maxChatMessages = Number(process.env.CHAT_MAX_MESSAGES || 8);
const maxChatMessageLength = Number(process.env.CHAT_MAX_MESSAGE_LENGTH || 800);
const allowedChatOrigins = (process.env.ALLOWED_CHAT_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const safetySettings = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
];
let knowledgeCache;
let gcsTokenCache = {
  token: null,
  expiresAt: 0
};
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.locals.cspNonce = randomBytes(16).toString("base64");
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);
app.use(
  rateLimit({
    windowMs: globalWindowMs,
    limit: globalLimit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." }
  })
);
app.use(express.json({ limit: "12kb", strict: true }));

function normalizeAssetPath(requestPath) {
  const cleaned = String(requestPath || "").replace(/^\/+/, "");
  const normalized = path.posix.normalize(cleaned);
  if (!normalized || normalized === "." || normalized.startsWith("..")) {
    return null;
  }

  return normalized;
}

async function getGcsAccessToken() {
  if (gcsTokenCache.token && Date.now() < gcsTokenCache.expiresAt - 30_000) {
    return gcsTokenCache.token;
  }

  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: {
      "Metadata-Flavor": "Google"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GCS access token: ${response.status}`);
  }

  const payload = await response.json();
  gcsTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 0) * 1000
  };

  return gcsTokenCache.token;
}

async function fetchGcsObjectMetadata(assetPath) {
  const token = await getGcsAccessToken();
  const objectName = encodeURIComponent(assetPath);
  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(assetBucketName)}/o/${objectName}?fields=contentType,cacheControl,etag,updated,name`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load asset metadata: ${response.status}`);
  }

  return response.json();
}

app.get("/assets/*", async (req, res, next) => {
  const assetPath = normalizeAssetPath(req.params[0]);
  if (!assetPath) {
    res.status(400).json({ error: "Invalid asset path." });
    return;
  }

  const localAssetPath = path.join(publicDir, "assets", assetPath);

  try {
    await access(localAssetPath);
    res.sendFile(localAssetPath);
    return;
  } catch {
    // Fall through to the private Cloud Storage bucket.
  }

  if (!assetBucketName) {
    res.status(404).json({ error: "Asset not found." });
    return;
  }

  try {
    const metadata = await fetchGcsObjectMetadata(assetPath);
    if (!metadata) {
      res.status(404).json({ error: "Asset not found." });
      return;
    }

    const token = await getGcsAccessToken();
    const objectName = encodeURIComponent(assetPath);
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(assetBucketName)}/o/${objectName}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (response.status === 404) {
      res.status(404).json({ error: "Asset not found." });
      return;
    }

    if (!response.ok) {
      throw new Error(`Failed to stream asset: ${response.status}`);
    }

    if (metadata.contentType) res.type(metadata.contentType);
    if (metadata.cacheControl) res.setHeader("Cache-Control", metadata.cacheControl);
    if (metadata.etag) res.setHeader("ETag", metadata.etag);
    if (metadata.updated) res.setHeader("Last-Modified", metadata.updated);

    if (!response.body) {
      throw new Error("Asset response body was empty.");
    }

    Readable.fromWeb(response.body).on("error", next).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.use(
  express.static(publicDir, {
    extensions: ["html"],
    index: false,
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
  })
);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(
    `window.BRYL_CONFIG=${JSON.stringify({
      assetBaseUrl,
      chatEnabled: Boolean(genAI),
      model: geminiModel,
      chatRateLimit: {
        limit: chatLimit,
        windowSeconds: Math.ceil(chatWindowMs / 1000)
      }
    })};`
  );
});

function isAllowedChatOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true;

  if (allowedChatOrigins.includes(origin)) return true;

  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  if (!host) return false;

  const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
  return origin === `${protocol}://${host}`;
}

function requireAllowedChatOrigin(req, res, next) {
  if (isAllowedChatOrigin(req)) {
    next();
    return;
  }

  res.status(403).json({ error: "Origin is not allowed." });
}

const chatLimiter = rateLimit({
  windowMs: chatWindowMs,
  limit: chatLimit,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many chat messages. Please wait a minute and try again." }
});

async function getKnowledgeBase() {
  if (knowledgeCache) return knowledgeCache;

  const markdown = await readFile(path.join(__dirname, "public", "context.md"), "utf8");
  knowledgeCache = markdown.trim();
  return knowledgeCache;
}

app.post("/api/chat", requireAllowedChatOrigin, chatLimiter, async (req, res) => {
  if (!genAI) {
    res.status(503).json({
      error: "Chat is not configured yet. Set GEMINI_API_KEY on Cloud Run."
    });
    return;
  }

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const cleanMessages = messages
    .slice(-maxChatMessages)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      text: String(message.text || "").trim().slice(0, maxChatMessageLength)
    }))
    .filter((message) => message.text.length > 0);

  if (cleanMessages.length === 0) {
    res.status(400).json({ error: "Message is required." });
    return;
  }

  const latestUserMessage = [...cleanMessages].reverse().find((message) => message.role === "user")?.text || "";

  try {
    const knowledge = await getKnowledgeBase();
    const response = await genAI.models.generateContent({
      model: geminiModel,
      contents: cleanMessages
        .map((message) => `${message.role === "assistant" ? "Assistant" : "Visitor"}: ${message.text}`)
        .join("\n"),
      config: {
        temperature: 0.2,
        maxOutputTokens: 220,
        thinkingConfig: {
          thinkingBudget: 0
        },
        safetySettings,
        systemInstruction:
          `You are the assistant for a portfolio template. Use only the Markdown knowledge base below as context.\n\nRules:\n- Answer naturally in 1-4 short sentences.\n- Only answer questions that are directly relevant to the template and its placeholder portfolio content.\n- If the visitor asks about anything outside the template, politely refuse and say you only answer questions about the template's portfolio, projects, skills, experience, availability, and contact details.\n- If the visitor greets you, briefly say what you can answer about.\n- Do not invent facts. Do not mention implementation details.\n\nMarkdown knowledge base:\n${knowledge}`
      }
    });

    res.json({ reply: response.text || "I could not answer that from the template notes." });
  } catch (error) {
    console.error("Gemini chat error", error);
    res.status(500).json({ error: "Chat failed. Please try again." });
  }
});

app.get("/", async (_req, res, next) => {
  try {
    const html = await readFile(path.join(publicDir, "index.html"), "utf8");
    res
      .type("html")
      .send(
        html
          .replaceAll("__ASSET_BASE_URL__", assetBaseUrl)
          .replaceAll("__CSP_NONCE__", res.locals.cspNonce)
      );
  } catch (error) {
    next(error);
  }
});

app.listen(port, () => {
  console.log(`Portfolio server listening on ${port}`);
});
