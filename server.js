import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { GoogleGenAI } from "@google/genai";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();
const port = process.env.PORT || 8080;
const assetBaseUrl = (process.env.ASSET_BASE_URL || "/assets").replace(/\/$/, "");
const geminiEmbeddingModel = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2";
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;
const assetOrigin = assetBaseUrl.startsWith("http") ? new URL(assetBaseUrl).origin : null;
const chatWindowMs = Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS || 60_000);
const chatLimit = Number(process.env.CHAT_RATE_LIMIT || 10);
const globalWindowMs = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || 15 * 60_000);
const globalLimit = Number(process.env.GLOBAL_RATE_LIMIT || 500);
const maxChatMessages = Number(process.env.CHAT_MAX_MESSAGES || 8);
const maxChatMessageLength = Number(process.env.CHAT_MAX_MESSAGE_LENGTH || 800);
const minAnswerScore = Number(process.env.CHAT_MIN_ANSWER_SCORE || 0.16);
const allowedChatOrigins = (process.env.ALLOWED_CHAT_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
let knowledgeCache;
const keywordStopwords = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "who",
  "how",
  "does",
  "have",
  "has",
  "his",
  "her",
  "bryl",
  "lim",
  "about",
  "tell",
  "show",
  "give",
  "you",
  "your"
]);

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
        imgSrc: ["'self'", "data:", "https://storage.googleapis.com", assetOrigin].filter(Boolean),
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
      embeddingModel: geminiEmbeddingModel,
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

function getEmbeddingValues(embedding) {
  if (!embedding) return [];
  if (Array.isArray(embedding.embedding?.values)) return embedding.embedding.values;
  if (Array.isArray(embedding.values)) return embedding.values;
  if (Array.isArray(embedding.value)) return embedding.value;
  if (Array.isArray(embedding)) return embedding;
  return [];
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    aMagnitude += a[index] * a[index];
    bMagnitude += b[index] * b[index];
  }

  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function splitMarkdownKnowledge(markdown) {
  return markdown
    .split(/\n(?=## )/g)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("## "))
    .map((section) => {
      const [headingLine, ...bodyLines] = section.split("\n");
      return {
        title: headingLine.replace(/^##\s*/, "").trim(),
        text: bodyLines.join("\n").trim().replace(/\n{2,}/g, "\n")
      };
    })
    .filter((section) => section.text.length > 0);
}

function keywordScore(query, section) {
  const queryTerms = new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s.]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 2 && !keywordStopwords.has(term))
  );

  if (queryTerms.size === 0) return 0;

  const normalizedTitle = section.title.toLowerCase();
  const normalizedText = `${section.title}\n${section.text}`.toLowerCase();
  let score = 0;
  queryTerms.forEach((term) => {
    if (normalizedTitle.includes(term)) score += 2;
    else if (normalizedText.includes(term)) score += 1;
  });

  return score / queryTerms.size;
}

function formatAnswer(matches, usedFallback = false) {
  if (matches.length === 0) {
    return "I don't have that information in Bryl's portfolio notes yet. You can email Bryl at bryllim@gmail.com or schedule a consultation at https://calendly.com/bryllim/consultation.";
  }

  const answer = matches
    .map((match) => {
      const lines = match.text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 5);
      return `${match.title}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  if (!usedFallback) return answer;

  return `${answer}\n\nI matched this from Bryl's portfolio notes without generating new content.`;
}

async function getKnowledgeBase() {
  if (knowledgeCache) return knowledgeCache;

  const markdown = await readFile(path.join(__dirname, "content", "portfolio.md"), "utf8");
  const sections = splitMarkdownKnowledge(markdown);

  knowledgeCache = { sections, embedded: false };

  if (!genAI) return knowledgeCache;

  try {
    const response = await genAI.models.embedContent({
      model: geminiEmbeddingModel,
      contents: sections.map((section) => `${section.title}\n${section.text}`)
    });

    const embeddings = response.embeddings || [];
    knowledgeCache.sections = sections.map((section, index) => ({
      ...section,
      vector: getEmbeddingValues(embeddings[index])
    }));
    knowledgeCache.embedded = knowledgeCache.sections.some((section) => section.vector?.length);
  } catch (error) {
    console.warn("Gemini knowledge embedding failed; keyword fallback will be used", error);
  }

  return knowledgeCache;
}

async function searchKnowledge(query) {
  const knowledgeBase = await getKnowledgeBase();

  if (!genAI || !query || !knowledgeBase.embedded) {
    return {
      usedFallback: true,
      matches: knowledgeBase.sections
        .map((section) => ({
          ...section,
          score: keywordScore(query, section)
        }))
        .filter((section) => section.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
    };
  }

  let queryVector = [];
  try {
    const response = await genAI.models.embedContent({
      model: geminiEmbeddingModel,
      contents: [query]
    });
    queryVector = getEmbeddingValues(response.embeddings?.[0]);
  } catch (error) {
    console.warn("Gemini query embedding failed; keyword fallback will be used", error);
  }

  if (!queryVector.length) {
    return {
      usedFallback: true,
      matches: knowledgeBase.sections
        .map((section) => ({
          ...section,
          score: keywordScore(query, section)
        }))
        .filter((section) => section.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
    };
  }

  const matches = knowledgeBase.sections
    .map((section) => ({
      ...section,
      score: cosineSimilarity(queryVector, section.vector || [])
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return {
    usedFallback: false,
    matches: matches[0]?.score >= minAnswerScore ? matches : []
  };
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
    const result = await searchKnowledge(latestUserMessage);
    res.json({ reply: formatAnswer(result.matches, result.usedFallback) });
  } catch (error) {
    console.error("Gemini embedding chat error", error);
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
