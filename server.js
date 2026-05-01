import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { GoogleGenAI } from "@google/genai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();
const port = process.env.PORT || 8080;
const assetBaseUrl = (process.env.ASSET_BASE_URL || "/assets").replace(/\/$/, "");
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
const allowedChatOrigins = (process.env.ALLOWED_CHAT_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const portfolioFacts = [
  "Bryl Lim is based in Metro Manila, Philippines.",
  "Bryl Lim works as an AI engineer, software engineer, and content creator.",
  "Bryl specializes in JavaScript, TypeScript, React, Next.js, Vue.js, Tailwind CSS, Node.js, Python, PHP, Laravel, PostgreSQL, MongoDB, AWS, Docker, Kubernetes, and GitHub Actions.",
  "Bryl builds modern web applications, mobile apps, SEO and digital marketing solutions, AI-powered products, and developer tutorials.",
  "Bryl has helped startups and MSMEs grow and streamline processes through software solutions.",
  "Bryl has built a developer community of over 200,000 developers through knowledge sharing and mentorship.",
  "Bryl's recent projects include CodeCred, BASE404, DIIN.PH, and DYNAMIS Workout Tracker.",
  "Bryl was recognized as DICT OpenGov Hackathon 2025 Champion.",
  "Bryl is available for software development, AI engineering, consulting, mentorship, and speaking engagements.",
  "Visitors can book Bryl through https://calendly.com/bryllim/consultation or email bryllim@gmail.com."
];

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
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

async function getRelevantPortfolioContext(query) {
  if (!genAI || !query) {
    return portfolioFacts.join("\n");
  }

  try {
    const response = await genAI.models.embedContent({
      model: geminiEmbeddingModel,
      contents: [query, ...portfolioFacts]
    });

    const embeddings = response.embeddings || [];
    const queryVector = getEmbeddingValues(embeddings[0]);

    if (!queryVector.length) {
      return portfolioFacts.join("\n");
    }

    return portfolioFacts
      .map((fact, index) => ({
        fact,
        score: cosineSimilarity(queryVector, getEmbeddingValues(embeddings[index + 1]))
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((item) => item.fact)
      .join("\n");
  } catch (error) {
    console.warn("Gemini embedding failed; falling back to full portfolio context", error);
    return portfolioFacts.join("\n");
  }
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

  const transcript = cleanMessages
    .map((message) => `${message.role === "assistant" ? "Assistant" : "Visitor"}: ${message.text}`)
    .join("\n");
  const latestUserMessage = [...cleanMessages].reverse().find((message) => message.role === "user")?.text || "";
  const relevantContext = await getRelevantPortfolioContext(latestUserMessage);

  try {
    const response = await genAI.models.generateContent({
      model: geminiModel,
      contents: transcript,
      config: {
        temperature: 0.6,
        maxOutputTokens: 420,
        systemInstruction:
          `You are Bryl Lim's portfolio assistant. Answer briefly and helpfully using only the portfolio facts below. If the answer is not covered, say you do not have that information and suggest emailing bryllim@gmail.com. Do not invent unavailable private information.\n\nRelevant portfolio facts:\n${relevantContext}`
      }
    });

    res.json({ reply: response.text || "I could not generate a response right now." });
  } catch (error) {
    console.error("Gemini chat error", error);
    res.status(500).json({ error: "Chat failed. Please try again." });
  }
});

app.get("/", async (_req, res, next) => {
  try {
    const html = await readFile(path.join(publicDir, "index.html"), "utf8");
    res.type("html").send(html.replaceAll("__ASSET_BASE_URL__", assetBaseUrl));
  } catch (error) {
    next(error);
  }
});

app.listen(port, () => {
  console.log(`Portfolio server listening on ${port}`);
});
