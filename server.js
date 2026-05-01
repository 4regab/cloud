import express from "express";
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
const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
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
      chatEnabled: Boolean(genAI)
    })};`
  );
});

app.post("/api/chat", async (req, res) => {
  if (!genAI) {
    res.status(503).json({
      error: "Chat is not configured yet. Set GEMINI_API_KEY on Cloud Run."
    });
    return;
  }

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const cleanMessages = messages
    .slice(-8)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      text: String(message.text || "").trim().slice(0, 1000)
    }))
    .filter((message) => message.text.length > 0);

  if (cleanMessages.length === 0) {
    res.status(400).json({ error: "Message is required." });
    return;
  }

  const transcript = cleanMessages
    .map((message) => `${message.role === "assistant" ? "Assistant" : "Visitor"}: ${message.text}`)
    .join("\n");

  try {
    const response = await genAI.models.generateContent({
      model: geminiModel,
      contents: transcript,
      config: {
        temperature: 0.6,
        maxOutputTokens: 420,
        systemInstruction:
          "You are Bryl Lim's portfolio assistant. Answer briefly and helpfully using only the portfolio facts provided: Bryl Lim is a Metro Manila based AI, software engineer, and content creator. He works with JavaScript, TypeScript, React, Next.js, Vue.js, Tailwind CSS, Node.js, Python, PHP, Laravel, PostgreSQL, MongoDB, AWS, Docker, Kubernetes, and GitHub Actions. His recent projects include CodeCred, BASE404, DIIN.PH, and DYNAMIS Workout Tracker. He is available for software development, AI engineering, speaking, mentorship, and consulting. For bookings, point visitors to https://calendly.com/bryllim/consultation. For email, use bryllim@gmail.com. Do not invent unavailable private information."
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
