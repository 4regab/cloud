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
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;
const assetOrigin = assetBaseUrl.startsWith("http") ? new URL(assetBaseUrl).origin : null;
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
let knowledgeCache;
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
        systemInstruction:
          `You are Bryl Lim's portfolio assistant. Use only the Markdown knowledge base below as context.\n\nRules:\n- Answer naturally in 1-4 short sentences.\n- If the visitor greets you, briefly say what you can answer about.\n- If the visitor is angry, confused, or sends nonsense, politely say you can answer questions about Bryl's projects, skills, experience, availability, and contact details.\n- If asked about a person, company, or topic not present in the Markdown, say you do not have that information in Bryl's portfolio notes.\n- Do not invent facts. Do not mention implementation details.\n\nMarkdown knowledge base:\n${knowledge}`
      }
    });

    res.json({ reply: response.text || "I could not answer that from Bryl's portfolio notes." });
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
