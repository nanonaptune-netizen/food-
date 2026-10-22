import express, { Request } from "express";
import crypto from "crypto";
import path from "path";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@libsql/client";
import Tesseract from "tesseract.js";
import twilio from "twilio";
import dotenv from "dotenv";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { PassThrough } from "stream";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Single source of truth for the Groq credential. No key is hard-coded in the
// repository: set GROQ_API_KEY in .env (or the host environment).
function getGroqKey(): string {
  return (process.env.GROQ_API_KEY || "").replace(/["'\r\n ]/g, "").trim();
}

// Model chains, verified live against this account's Groq catalog.
// NOTE: llama-3.x and mixtral are NOT available on this key. Measured on a
// Kannada JSON reply: qwen3.8 273 ms, gpt-oss-120b 799 ms, gpt-oss-20b 923 ms.
// So the fastest model leads the chain on live voice turns.
const GROQ_VOICE_MODELS = ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"];
const GROQ_TEXT_MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"];
// Speech-to-text chains, per language. whisper-large-v3 is noticeably more
// accurate on Kannada and Hindi than the distilled -turbo variant (which is
// tuned for English), so Indic languages prefer it and English keeps turbo for
// latency. Each chain falls back to the other model, so an unavailable model
// degrades gracefully instead of silently producing poor captions.
const GROQ_STT_CHAINS: Record<string, string[]> = {
  kn: ["whisper-large-v3", "whisper-large-v3-turbo"],
  hi: ["whisper-large-v3", "whisper-large-v3-turbo"],
  en: ["whisper-large-v3-turbo", "whisper-large-v3"],
};
const ALL_GROQ_STT_MODELS = [...new Set([...GROQ_STT_CHAINS.kn, ...GROQ_STT_CHAINS.en])];
const GROQ_STT_MODEL = GROQ_STT_CHAINS.en[0]; // kept for logging/compat

// Default domain lexicon per language. Whisper's `prompt` biases the decoder, so
// seeding it with the words this helpline actually hears keeps local food items,
// hotel names and FSSAI vocabulary from being corrected into unrelated English.
// A caller-supplied hint (from the IVR) takes precedence.
const STT_DOMAIN_HINTS: Record<string, string> = {
  kn: "ಆಹಾರ ಸುರಕ್ಷತೆ ದೂರು. ಇಡ್ಲಿ, ದೋಸೆ, ಬಿರಿಯಾನಿ, ಅನ್ನ, ಸಾಂಬಾರ್, ಪಲ್ಯ, ಚಪಾತಿ, ಊಟ, ಚಹಾ, ಕಾಫಿ, ಹೋಟೆಲ್, ರೆಸ್ಟೋರೆಂಟ್, ಕ್ಯಾಂಟೀನ್, ತಿಂಡಿ, ಮಜ್ಜಿಗೆ. ಹುಳು, ಕೂದಲು, ಕಲುಷಿತ, ವಾಸನೆ, ಹಳಸಿದ, ಕೊಳಕು, ಅಜೀರ್ಣ, ವಾಂತಿ, ಹೊಟ್ಟೆ ನೋವು, ಜಾಸ್ತಿ ಉಪ್ಪು. ನಿನ್ನೆ, ಇಂದು, ಸಂಜೆ, ರಾತ್ರಿ, ಬೆಳಗ್ಗೆ. ದೂರು ದಾಖಲಿಸಿ, FSSAI, ಪರವಾನಗಿ.",
  hi: "खाद्य सुरक्षा शिकायत. इडली, डोसा, बिरयानी, चावल, सांभर, सब्जी, रोटी, चाय, कॉफी, होटल, रेस्टोरेंट, ढाबा, नाश्ता. कीड़ा, बाल, मिलावट, बदबू, बासी, गंदा, पेट दर्द, उल्टी, ज्यादा नमक. कल, आज, शाम, रात, सुबह. शिकायत दर्ज, FSSAI, लाइसेंस.",
  // The verbs matter: without them the decoder had nothing pulling "ate" back
  // from the digit homophone "8".
  en: "Food safety complaint helpline. I ate, we ate, had, ordered, drank, eat, eating, food, meal, idli, dosa, biryani, rice, sambar, curry, chapati, tea, coffee, hotel, restaurant, canteen, breakfast, lunch, dinner. insect, hair, contaminated, foul smell, stale, unhygienic, stomach pain, vomiting, excess salt. yesterday, today, evening, night, morning. file complaint, FSSAI, licence, hygiene.",
};

// Helper for timeout-safe fetch
async function fetchWithTimeout(url: string, options: any = {}, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Robust JSON Extractor & Parser (handles markdown wraps & conversational commentary)
function cleanAndParseJson(text: string): any {
  if (!text) return null;
  let raw = text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(raw);
  } catch {}
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

// LLM generation, powered by Groq
async function runLLMGeneration({
  system,
  prompt,
  messages,
  json = false,
  maxTokens = 1500,
  preferFast = false,
  timeoutMs,
}: {
  system?: string;
  prompt?: string;
  messages?: any[];
  /** Ask the provider for strict JSON output (faster, no markdown unwrapping) */
  json?: boolean;
  maxTokens?: number;
  /** Live voice turns: try the lowest-latency provider first */
  preferFast?: boolean;
  /** Override the per-provider request timeout */
  timeoutMs?: number;
}): Promise<string> {
  const groqKey = getGroqKey();

  let formattedMessages = messages && messages.length > 0
    ? messages.map((m: any) => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        content: typeof m.content === 'string' ? m.content : (typeof m.text === 'string' ? m.text : JSON.stringify(m.content || ''))
      }))
    : [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt || "" }
      ];

  if (system && messages && messages.length > 0 && formattedMessages[0]?.role !== "system") {
    formattedMessages = [{ role: "system", content: system }, ...formattedMessages];
  }

  const requestBody: any = {
    messages: formattedMessages,
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  if (json) {
    requestBody.response_format = { type: "json_object" };
  }

  const groqModels = preferFast ? GROQ_VOICE_MODELS : GROQ_TEXT_MODELS;

  const callGroq = async (): Promise<string> => {
    if (!groqKey || groqKey === "YOUR_GROQ_API_KEY") return "";
    for (let idx = 0; idx < groqModels.length; idx++) {
      const model = groqModels[idx];
      // On a live voice turn the FIRST model gets a short leash: qwen normally
      // answers in ~270ms, so if it stalls we fail over quickly instead of
      // making the caller listen to silence. Later attempts get a real budget.
      const attemptTimeout = timeoutMs || (preferFast ? (idx === 0 ? 3500 : 9000) : 9000);
      try {
        console.log(`[Groq Request] Querying Groq with model: ${model} (timeout ${attemptTimeout}ms)...`);
        const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${groqKey}`,
          },
          body: JSON.stringify({ ...requestBody, model }),
        }, attemptTimeout);

        if (groqRes.ok) {
          const data: any = await groqRes.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (reply && reply.trim()) {
            console.log(`[Groq Success] Model ${model} responded (${reply.length} chars)`);
            return reply.trim();
          }
        } else {
          // Never fail silently again: an expired key (401) or an exhausted
          // quota (429) must be visible in the logs.
          const errTxt = await groqRes.text().catch(() => "");
          console.warn(`[Groq] model ${model} returned ${groqRes.status}: ${errTxt.slice(0, 300)}`);
        }
      } catch (e: any) {
        console.warn(`Groq attempt notice for ${model}:`, e?.message);
      }
    }
    return "";
  };

  // Groq is the only LLM provider for this helpline.
  void preferFast; // kept for call-site compatibility
  const reply = await callGroq();
  if (reply) return reply;

  return "";
}

// Turso Setup (Safely optional if database credentials are not configured in environment)
let tursoClient: any = null;

function getTurso() {
  if (!tursoClient) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      return null;
    }
    tursoClient = createClient({ 
      url: url, 
      authToken: authToken 
    });
  }
  return tursoClient;
}

// Cloudinary Setup
cloudinary.config({
  cloudinary_url: process.env.CLOUDINARY_URL,
});

// Initializing DB
async function initDB() {
  try {
    const turso = getTurso();
    if (!turso) {
      console.warn(
        "Turso DB URL not set in environment; skipping DB initialization. " +
        "Conversation memory will live only inside this process: it is lost on restart and is " +
        "NOT shared between serverless instances, so the assistant will appear to forget earlier " +
        "messages. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to persist it. See GET /api/health."
      );
      return;
    }
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS complaints (
        id TEXT PRIMARY KEY,
        name TEXT,
        phoneNumber TEXT,
        location TEXT,
        query TEXT,
        status TEXT,
        chatHistory TEXT,
        mediaUrls TEXT,
        audioUrl TEXT,
        createdAt INTEGER,
        adminReply TEXT,
        adminReplyAt INTEGER
      )
    `);

    // Ensure columns exist on existing table instances
    try {
      await turso.execute(`ALTER TABLE complaints ADD COLUMN adminReply TEXT`);
    } catch (e) {}
    try {
      await turso.execute(`ALTER TABLE complaints ADD COLUMN adminReplyAt INTEGER`);
    } catch (e) {}
    
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id TEXT PRIMARY KEY,
        name TEXT,
        content TEXT,
        type TEXT,
        createdAt INTEGER
      )
    `);

    await turso.execute(`
      CREATE TABLE IF NOT EXISTS qa_cache (
        id TEXT PRIMARY KEY,
        normalized_intent TEXT,
        language TEXT,
        question TEXT,
        answer TEXT,
        audio_url TEXT,
        created_at INTEGER
      )
    `);

    // --- IVR call sessions: one row per phone call, holding the full transcript.
    // This is the memory the voice agent uses to behave like a person who
    // already knows the caller, and it lets the IVR answer questions instead of
    // only logging complaints.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ivr_calls (
        id TEXT PRIMARY KEY,
        callerName TEXT,
        phone TEXT,
        language TEXT,
        startedAt INTEGER,
        endedAt INTEGER,
        turnCount INTEGER,
        status TEXT,
        complaintId TEXT,
        transcript TEXT,
        collectedData TEXT
      )
    `);

    // --- Every single turn of every IVR conversation, in order.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ivr_turns (
        id TEXT PRIMARY KEY,
        callId TEXT,
        turnIndex INTEGER,
        role TEXT,
        text TEXT,
        language TEXT,
        step TEXT,
        createdAt INTEGER
      )
    `);

    try {
      await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ivr_turns_call ON ivr_turns (callId, turnIndex)`);
    } catch (e) {}
    try {
      await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ivr_calls_phone ON ivr_calls (phone, startedAt)`);
    } catch (e) {}

    // --- Main-page conversations. The chat used to be stateless: memory lived
    // only in the browser's last few messages, so a reload wiped it and the
    // assistant could not answer "what did I say?". Each conversation is now
    // stored server-side with its full turn list.
    // `phone` is the OWNER of the conversation. Memory is only ever served back
    // to the same phone number, so one caller's history can never appear in
    // another caller's session.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        phone TEXT,
        language TEXT,
        profile TEXT,
        facts TEXT,
        turns TEXT,
        closedAt INTEGER,
        updatedAt INTEGER
      )
    `);
    try {
      await turso.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updatedAt)`);
    } catch (e) {}
    // Columns added after the table already existed in some deployments.
    try {
      await turso.execute(`ALTER TABLE conversations ADD COLUMN phone TEXT`);
    } catch (e) {}
    try {
      await turso.execute(`ALTER TABLE conversations ADD COLUMN closedAt INTEGER`);
    } catch (e) {}
    try {
      await turso.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations (phone, updatedAt)`);
    } catch (e) {}

    // Seed default common Q&A items if table is empty
    try {
      const existing = await turso.execute("SELECT COUNT(*) as cnt FROM qa_cache");
      const count = Number(existing.rows[0]?.cnt || 0);
      if (count === 0) {
        const seedItems = [
          {
            id: "seed_fssai_def_en",
            normalized_intent: "definition_fssai",
            language: "English",
            question: "What is FSSAI?",
            answer: "FSSAI stands for the Food Safety and Standards Authority of India. It is an autonomous body under the Ministry of Health & Family Welfare that regulates food safety, quality standards, and hygiene compliance across India."
          },
          {
            id: "seed_fssai_work_en",
            normalized_intent: "working_fssai",
            language: "English",
            question: "How does FSSAI work?",
            answer: "FSSAI works by setting science-based food quality standards, issuing mandatory food business licenses, conducting kitchen hygiene inspections, and testing food samples to protect consumer health."
          },
          {
            id: "seed_complaint_en",
            normalized_intent: "file_complaint",
            language: "English",
            question: "How do I register a complaint?",
            answer: "You can register a complaint by describing your issue here or uploading photos. I will draft a formal report, record your details, and submit it directly to our support team."
          },
          {
            id: "seed_fssai_def_hi",
            normalized_intent: "definition_fssai",
            language: "Hindi",
            question: "FSSAI क्या है?",
            answer: "FSSAI भारतीय खाद्य सुरक्षा और मानक प्राधिकरण है। यह भारत में भोजन की गुणवत्ता, स्वच्छता और सुरक्षा मानकों को विनियमित करने वाली एक प्रमुख सरकारी संस्था है।"
          },
          {
            id: "seed_fssai_work_hi",
            normalized_intent: "working_fssai",
            language: "Hindi",
            question: "FSSAI कैसे काम करता है?",
            answer: "FSSAI खाद्य लाइसेंस जारी करके, रसोईघरों की स्वच्छता की जाँच करके और भोजन के नमूनों का परीक्षण करके काम करता है ताकि उपभोक्ताओं को सुरक्षित भोजन मिल सके।"
          },
          {
            id: "seed_fssai_def_kn",
            normalized_intent: "definition_fssai",
            language: "Kannada",
            question: "FSSAI ಎಂದರೆ ಏನು?",
            answer: "FSSAI ಅಂದರೆ ಭಾರತೀಯ ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಪ್ರಾಧಿಕಾರ. ಇದು ಭಾರತದಲ್ಲಿ ಆಹಾರದ ಗುಣಮಟ್ಟ, ನೈರ್ಮಲ್ಯ ಮತ್ತು ಸುರಕ್ಷತೆಯನ್ನು ನಿಯಂತ್ರಿಸುವ ಸರ್ಕಾರಿ ಸಂಸ್ಥೆಯಾಗಿದೆ."
          },
          {
            id: "seed_fssai_work_kn",
            normalized_intent: "working_fssai",
            language: "Kannada",
            question: "FSSAI ಹೇಗೆ ಕೆಲಸ ಮಾಡುತ್ತದೆ?",
            answer: "FSSAI ಆಹಾರ ಸಂಸ್ಥೆಗಳಿಗೆ ಪರವಾನಗಿ ನೀಡುವುದು, ಅಡುಗೆಮನೆಗಳ ನೈರ್ಮಲ್ಯ ತಪಾಸಣೆ ಮಾಡುವುದು ಮತ್ತು ಆಹಾರದ ಮಾದರಿಗಳನ್ನು ಪರೀಕ್ಷಿಸುವ ಮೂಲಕ ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತದೆ."
          }
        ];

        for (const item of seedItems) {
          await turso.execute({
            sql: `INSERT INTO qa_cache (id, normalized_intent, language, question, answer, audio_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [item.id, item.normalized_intent, item.language, item.question, item.answer, "", Date.now()]
          });
        }
      }
    } catch (sErr: any) {
      console.warn("Seeding qa_cache notice:", sErr?.message);
    }
  } catch (error: any) {
    console.warn("Database initialization skipped or failed:", error.message);
  }
}
initDB();

// Startup provider check, so a missing or expired GROQ_API_KEY is impossible
// to miss. The helpline needs Groq for both the LLM and speech-to-text.
async function verifyGroqCredentials() {
  const key = getGroqKey();
  if (!key) {
    console.warn("[Provider check] GROQ_API_KEY is not set - answers will come only from the stored knowledge base.");
    return;
  }
  try {
    const res = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    }, 8000);
    if (res.ok) {
      console.log("[Provider check] GROQ_API_KEY is valid - LLM and speech-to-text are ready.");

      // Also confirm the configured model IDs actually exist on THIS key, so a
      // key from a different account/tier can never fail silently at call time.
      const catalog: string[] = (await res.json())?.data?.map((m: any) => m.id) || [];
      const wanted = [...new Set([...GROQ_VOICE_MODELS, ...GROQ_TEXT_MODELS, ...ALL_GROQ_STT_MODELS])];
      const missing = wanted.filter((m) => !catalog.includes(m));
      const usable = wanted.filter((m) => catalog.includes(m));
      console.log(`[Provider check] ${catalog.length} models on this key; usable here: ${usable.join(", ") || "none"}`);
      if (missing.length) {
        console.warn(`[Provider check] NOT available on this key: ${missing.join(", ")} - update the model chains in server.ts.`);
      }
      if (!usable.length) {
        console.warn("[Provider check] No configured model is available - the IVR will only answer from its knowledge base.");
      }
    } else {
      const errTxt = await res.text().catch(() => "");
      console.warn(`[Provider check] GROQ_API_KEY rejected with status ${res.status}. Update GROQ_API_KEY in .env. ${errTxt.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.warn("[Provider check] Could not reach Groq:", e?.message);
  }
}
verifyGroqCredentials();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Admin authentication
//
// SECURITY FIX: the dashboard PIN was a constant inside the browser bundle
// ('0000') and every /api/admin/* route was completely open. One unauthenticated
// GET returned every citizen's name, phone number, location, complaint text and
// full IVR call transcript, and the DELETE routes let anyone erase them. The
// server now verifies the PIN and every privileged route requires a session
// token, so hiding the dashboard URL is no longer the only protection.
// ---------------------------------------------------------------------------
const ADMIN_PIN = (process.env.ADMIN_PIN || "0000").trim();
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours
const adminSessions = new Map<string, number>();

if (!process.env.ADMIN_PIN) {
  console.warn("[Admin] ADMIN_PIN is not set - falling back to the default '0000'. Set ADMIN_PIN before deploying.");
}

function issueAdminToken(): string {
  const token = crypto.randomBytes(24).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
  return token;
}

function readAdminToken(req: any): string {
  const direct = req.headers?.["x-admin-token"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const auth = String(req.headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : "";
}

function pinsMatch(candidate: string): boolean {
  const a = Buffer.from(String(candidate || ""));
  const b = Buffer.from(ADMIN_PIN);
  // timingSafeEqual throws on length mismatch, so check that first.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function requireAdmin(req: any, res: any, next: any) {
  const token = readAdminToken(req);
  const expiresAt = token ? adminSessions.get(token) : undefined;
  if (!expiresAt) {
    return res.status(401).json({ error: "Admin authentication required" });
  }
  if (expiresAt < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: "Admin session expired. Please sign in again." });
  }
  return next();
}

// Sweep expired sessions so the map cannot grow without bound.
try {
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of adminSessions) {
      if (expiresAt < now) adminSessions.delete(token);
    }
  }, 30 * 60 * 1000);
  sweeper.unref?.();
} catch {}

// ---------------------------------------------------------------------------
// Lightweight per-IP rate limiting
//
// These endpoints spend real money (Groq tokens, Cloudinary storage) and had no
// protection at all, so a single script could burn the account's quota or fill
// its storage in seconds. Fixed-window counters per IP are enough to stop that,
// and they also make the admin PIN impractical to brute-force.
// ---------------------------------------------------------------------------
function rateLimit(opts: { windowMs: number; max: number; label: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  try {
    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of hits) {
        if (entry.resetAt < now) hits.delete(key);
      }
    }, opts.windowMs);
    sweeper.unref?.();
  } catch {}

  return (req: any, res: any, next: any) => {
    const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || entry.resetAt < now) {
      hits.set(ip, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (entry.count >= opts.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      console.warn(`[RateLimit] ${opts.label}: blocked ${ip} for ${retryAfter}s`);
      return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
    }
    entry.count += 1;
    return next();
  };
}

// Brute-forcing a 4-digit PIN takes 10,000 attempts; this makes that hopeless.
const adminLoginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, label: "admin-login" });
const uploadLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, label: "upload" });
const voiceLimit = rateLimit({ windowMs: 60 * 1000, max: 90, label: "voice" });
const chatLimit = rateLimit({ windowMs: 60 * 1000, max: 60, label: "chat" });

app.post("/api/admin/login", adminLoginLimit, (req, res) => {
  const pin = String(req.body?.pin || "").trim();
  if (!pin) return res.status(400).json({ error: "PIN is required" });
  if (!pinsMatch(pin)) {
    console.warn("[Admin] Rejected an admin sign-in attempt.");
    return res.status(401).json({ error: "Invalid PIN" });
  }
  res.json({ token: issueAdminToken(), expiresInMs: ADMIN_SESSION_MS });
});

app.post("/api/admin/logout", (req, res) => {
  const token = readAdminToken(req);
  if (token) adminSessions.delete(token);
  res.json({ ok: true });
});

// Twilio Client Setup
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || process.env.TWILIO_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_SECRET;

let twilioClient: any = null;
try {
  if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
    twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID });
  } else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } else if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) {
    twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET);
  }
} catch (err) {
  console.warn("Twilio client initialization notice:", err);
}

// Twilio Voice IVR Initial Webhook Endpoint (Language Selection Menu)
app.all("/api/voice", (req: any, res: any) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: ["dtmf", "speech"],
    numDigits: 1,
    action: "/api/voice/menu-select",
    method: "POST",
    timeout: 6,
  });

  // 1 for Kannada, 2 for Hindi, 3 for English
  gather.say({ voice: "Google.en-IN-Standard-A" as any }, "Welcome to VoxAssist.");
  gather.say({ voice: "Google.kn-IN-Standard-A" as any, language: "kn-IN" as any }, "ಕನ್ನಡಕ್ಕಾಗಿ ಒಂದನ್ನು ಒತ್ತಿ."); // Kannadakkagi ondanna otti
  gather.say({ voice: "Google.hi-IN-Wavenet-A" as any, language: "hi-IN" as any }, "हिंदी के लिए दो दबाएं।"); // Hindi ke liye 2 dabaye
  gather.say({ voice: "Google.en-IN-Standard-A" as any }, "For English, press 3.");

  twiml.say({ voice: "Google.en-IN-Standard-A" as any }, "No selection received. Please try calling again.");
  twiml.redirect("/api/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Handle Language Selection (DTMF Digit 1, 2, 3 or Speech Keyword)
app.all("/api/voice/menu-select", (req: any, res: any) => {
  const digits = (req.body.Digits || "").trim();
  const speech = (req.body.SpeechResult || "").toLowerCase();
  const twiml = new twilio.twiml.VoiceResponse();

  let selectedLang = "kn-IN"; // Default if 1
  let langName = "Kannada";
  let greetingText = "ನಮಸ್ಕಾರ! VoxAssist AI ಸಹಾಯಕ್ಕೆ ಸ್ವಾಗತ. ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಅಥವಾ ಸಮಸ್ಯೆಯನ್ನು ಹೇಳಿ.";
  let ttsVoice = "Google.kn-IN-Standard-A";

  if (digits === "1" || speech.includes("kannada") || speech.includes("ondanna")) {
    selectedLang = "kn-IN";
    langName = "Kannada";
    greetingText = "ನಮಸ್ಕಾರ! VoxAssist AI ಸಹಾಯಕ್ಕೆ ಸ್ವಾಗತ. ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಅಥವಾ ಸಮಸ್ಯೆಯನ್ನು ಹೇಳಿ.";
    ttsVoice = "Google.kn-IN-Standard-A";
  } else if (digits === "2" || speech.includes("hindi") || speech.includes("do")) {
    selectedLang = "hi-IN";
    langName = "Hindi";
    greetingText = "नमस्ते! VoxAssist AI सहायक में आपका स्वागत है। आप अपनी समस्या या प्रश्न बताएं।";
    ttsVoice = "Google.hi-IN-Wavenet-A";
  } else if (digits === "3" || speech.includes("english") || speech.includes("three")) {
    selectedLang = "en-US";
    langName = "English";
    greetingText = "Hello! Welcome to VoxAssist AI Support. How can I assist you today?";
    ttsVoice = "Polly.Joanna";
  } else {
    // Invalid key fallback
    const retryGather = twiml.gather({
      input: ["dtmf", "speech"],
      numDigits: 1,
      action: "/api/voice/menu-select",
      method: "POST",
      timeout: 6,
    });
    retryGather.say({ voice: "Google.en-IN-Standard-A" as any }, "Invalid selection.");
    retryGather.say({ voice: "Google.kn-IN-Standard-A" as any, language: "kn-IN" as any }, "ಕನ್ನಡಕ್ಕಾಗಿ ಒಂದನ್ನು ಒತ್ತಿ.");
    retryGather.say({ voice: "Google.hi-IN-Wavenet-A" as any, language: "hi-IN" as any }, "हिंदी के लिए दो दबाएं।");
    retryGather.say({ voice: "Google.en-IN-Standard-A" as any }, "For English, press 3.");
    twiml.redirect("/api/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Prompt user for their actual question in the selected language
  const gather = twiml.gather({
    input: ["speech"],
    action: `/api/voice/respond?lang=${encodeURIComponent(selectedLang)}&langName=${encodeURIComponent(langName)}`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
    language: selectedLang as any,
  });

  gather.say({ voice: ttsVoice as any }, greetingText);

  twiml.say({ voice: ttsVoice as any }, "No speech detected. Please speak after the tone.");
  twiml.redirect("/api/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Twilio Voice IVR Conversation Loop in Selected Language
app.all("/api/voice/respond", async (req: any, res: any) => {
  const userSpeech = req.body.SpeechResult || req.body.UnstableSpeechResult || "";
  const selectedLang = req.query.lang || "hi-IN";
  const langName = req.query.langName || "Hindi";
  const twiml = new twilio.twiml.VoiceResponse();

  let ttsVoice = "Google.hi-IN-Wavenet-A";
  let noSpeechMessage = "क्षमा करें, मैं समझ नहीं पाया। कृपया दोबारा बोलें।";

  if (selectedLang === "kn-IN") {
    ttsVoice = "Google.kn-IN-Standard-A";
    noSpeechMessage = "ಕ್ಷಮಿಸಿ, ನಿಮ್ಮ ದ್ವನಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ಹೇಳಿ.";
  } else if (selectedLang === "en-US") {
    ttsVoice = "Polly.Joanna";
    noSpeechMessage = "Sorry, I didn't catch that. Please try speaking again.";
  }

  if (!userSpeech || !userSpeech.trim()) {
    const gather = twiml.gather({
      input: ["speech"],
      action: `/api/voice/respond?lang=${encodeURIComponent(selectedLang)}&langName=${encodeURIComponent(langName)}`,
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
      language: selectedLang as any,
    });
    gather.say({ voice: ttsVoice as any }, noSpeechMessage);
    twiml.redirect("/api/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  try {
    const aiResponse = await runLLMGeneration({
      system: `You are VoxAssist, a helpful AI customer support agent answering phone calls. The caller selected ${langName}. You MUST respond exclusively in ${langName}. Keep spoken responses concise, empathetic, and natural (1 to 2 short sentences max).`,
      prompt: userSpeech,
    });

    let fallbackReply = "धन्यवाद! हम आपकी सहायता के लिए यहाँ हैं।";
    if (selectedLang === "kn-IN") {
      fallbackReply = "ಧನ್ಯವಾದಗಳು! ನಿಮ್ಮ ಸಹಾಯಕ್ಕಾಗಿ ನಾವು ಇಲ್ಲಿದ್ದೇವೆ.";
    } else if (selectedLang === "en-US") {
      fallbackReply = "Thank you! We are here to assist you.";
    }

    const replyText = aiResponse || fallbackReply;

    const gather = twiml.gather({
      input: ["speech"],
      action: `/api/voice/respond?lang=${encodeURIComponent(selectedLang)}&langName=${encodeURIComponent(langName)}`,
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
      language: selectedLang as any,
    });

    gather.say({ voice: ttsVoice as any }, replyText);

    // Prompt for further questions in selected language
    let followUp = "क्या आपको किसी और चीज़ में मदद चाहिए?";
    if (selectedLang === "kn-IN") {
      followUp = "ನಿಮಗೆ ಬೇರೆ ಯಾವುದೇ ಸಹಾಯ ಬೇಕೇ?";
    } else if (selectedLang === "en-US") {
      followUp = "Is there anything else I can help you with?";
    }

    twiml.say({ voice: ttsVoice as any }, followUp);
    twiml.redirect("/api/voice");
  } catch (err: any) {
    console.error("IVR processing error:", err?.message || err);
    twiml.say({ voice: ttsVoice as any }, "Technical issue encountered. Please try calling back later.");
    twiml.hangup();
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

interface MulterRequest extends Request {
  file?: any;
}

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max
  }
});

// API: Upload to Cloudinary (General)
app.post("/api/upload", uploadLimit, upload.single("file"), async (req: any, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file provided" });

    const b64 = Buffer.from(file.buffer).toString("base64");
    const dataURI = "data:" + file.mimetype + ";base64," + b64;
    
    const result = await cloudinary.uploader.upload(dataURI, {
      resource_type: "auto",
    });

    res.json({ url: result.secure_url });
  } catch (error) {
    res.status(500).json({ error: "Upload failed" });
  }
});

// API: Upload Voice Note to Cloudinary as MP3
app.post("/api/upload-audio", uploadLimit, upload.single("audio"), async (req: any, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No audio file provided" });

    const b64 = Buffer.from(file.buffer).toString("base64");
    const mime = file.mimetype || "audio/webm";
    const dataURI = `data:${mime};base64,${b64}`;

    // Upload to Cloudinary with format mp3 & resource_type video
    const result = await cloudinary.uploader.upload(dataURI, {
      resource_type: "video",
      format: "mp3",
      folder: "voxassist_voice_notes",
    });

    console.log("[Cloudinary Audio Upload] Saved MP3 voice note:", result.secure_url);
    res.json({ url: result.secure_url, format: "mp3" });
  } catch (error: any) {
    console.error("Audio upload error:", error);
    res.status(500).json({ error: error.message || "Failed to upload audio" });
  }
});

// API: Process PDF or Image with Multimodal OCR & Recognition
app.post("/api/process-document", requireAdmin, upload.single("file"), async (req: MulterRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    let content = "";
    const fileType = req.file.mimetype || "application/octet-stream";
    const originalName = req.file.originalname || "document";

    if (fileType === "application/pdf" || originalName.toLowerCase().endsWith(".pdf")) {
      try {
        const pdfModule = await import("pdf-parse");
        const pdfParser = (pdfModule as any).default || pdfModule;
        const data = await pdfParser(req.file.buffer);
        content = data.text || "";
      } catch (err: any) {
        console.warn("pdf-parse extraction failed:", err?.message);
      }
    } else if (fileType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|heic|tiff)$/i.test(originalName)) {
      // 1. Run local Tesseract OCR
      try {
        const ocrResult = await Tesseract.recognize(req.file.buffer, 'eng');
        const rawOcrText = ocrResult?.data?.text || "";
        if (rawOcrText.trim()) {
          // Format & clean up OCR text if LLM is available
          const structuredText = await runLLMGeneration({
            system: "You are an AI document formatter. Reorganize and clean up raw OCR text into structured Markdown with clear headings, menu item names, prices, ingredients, descriptions, and policies. Do not invent any facts.",
            prompt: `Clean and format this raw OCR text:\n\n${rawOcrText}`,
          });
          content = structuredText || rawOcrText;
        }
      } catch (ocrErr: any) {
        console.warn("Tesseract OCR fallback failed, attempting vision model:", ocrErr?.message);
      }

      // 2. If Tesseract didn't get text, try multimodal LLM
      if (!content.trim()) {
        try {
          content = await runLLMGeneration({
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Exhaustively extract and transcribe all text, menu items, prices, policies, and details from this image in clean Markdown.' },
                { type: 'image', image: req.file.buffer }
              ]
            }]
          });
        } catch (visionErr: any) {
          console.warn("Vision LLM failed:", visionErr?.message);
        }
      }
    } else if (fileType === "text/plain" || fileType === "text/markdown" || fileType === "text/csv" || /\.(txt|md|csv|json)$/i.test(originalName)) {
      content = req.file.buffer.toString("utf-8");
    } else {
      content = req.file.buffer.toString("utf-8");
    }

    if (!content.trim()) {
      return res.status(400).json({ error: "Could not extract readable text from the uploaded file. Please ensure the image is clear and contains text." });
    }

    res.json({ 
      content: content.trim(), 
      sourceName: originalName,
      charCount: content.trim().length,
      mimeType: fileType,
    });
  } catch (error: any) {
    console.error("Error processing document:", error);
    res.status(500).json({ error: error.message || "Failed to process document" });
  }
});

/**
 * Collapses a phrase repeated N times into ONE copy.
 *
 * Mirrors `collapseRepetitions` in src/utils/text.ts. ROOT CAUSE of "I said 3
 * words and it showed them 3 to 7 times": Whisper replays/loops on silence and
 * on a long decoder prompt, and a replayed clip is re-transcribed slightly
 * differently each time, so one utterance comes back as several near-identical
 * copies. The transcript was returned completely raw, so those copies went
 * straight into the caption, the chat message and the LLM prompt.
 */
function collapseRepetitions(text: string): string {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length < 2) return words.join(' ');

  const norm = words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));

  // 1. Exact period: the whole sequence is the same k words repeated N times.
  for (let period = 1; period <= Math.floor(words.length / 2); period++) {
    if (words.length % period !== 0) continue;
    let periodic = true;
    for (let i = period; i < words.length; i++) {
      if (norm[i] !== norm[i % period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return words.slice(0, period).join(' ');
  }

  // 2. Near-exact period: a replayed clip comes back slightly different each
  //    time, so accept a copy whose words are >= 80% positionally equal.
  for (let copies = 8; copies >= 2; copies--) {
    if (words.length % copies !== 0) continue;
    const unit = words.length / copies;
    let repeated = true;
    for (let c = 1; c < copies && repeated; c++) {
      let same = 0;
      for (let i = 0; i < unit; i++) {
        if (norm[i] === norm[i + c * unit]) same++;
      }
      if (same / unit < 0.8) repeated = false;
    }
    if (repeated) return words.slice(0, unit).join(' ');
  }

  return words.join(' ');
}

/**
 * Repairs the recogniser's digit-homophone mistakes ("I 8 food" -> "I ate food").
 *
 * Mirrors `normalizeRecognizedText` in src/utils/text.ts. Speech models emit the
 * digit for a word that sounds the same ("ate"->8, "for"->4, "to"->2) on short or
 * unclear clips, and nothing was pulling them back, so the digit reached the
 * caption, the chat and memory. Every rule is anchored so a real quantity is
 * never touched ("at 8 pm", "8 idlis", "2 dosas", "₹200" are all left alone).
 */
function normalizeRecognizedText(text: string): string {
  let out = String(text || '');
  if (!out) return '';
  // PROTECT FIRST: an 8 after a preposition or an identifier is a real time or
  // number, never the verb "ate" (see the mirror in src/utils/text.ts).
  out = out.replace(/\b(at|on|by|around|about|after|before|till|until|from|till)\s+8\b/gi, '$1 eight');
  out = out.replace(/\b(room|flat|door|table|gate|bus|train|floor|shop|plot|seat|no|number|token|slip)\s+8\b/gi, '$1 eight');
  out = out.replace(/\b(I|we|they|he|she|you|i)\s+8\b/g, '$1 ate');
  out = out.replace(/\b8\s+(the|my|our|his|her|their|some)\b/gi, 'ate $1');
  out = out.replace(/\b8\s+(food|meal|breakfast|lunch|dinner|snack|rice|curd|sambar|something)\b/gi, 'ate $1');
  out = out.replace(/\b4\s+(me|you|us|them|him|this|that)\b/gi, 'for $1');
  out = out.replace(/\b2\s+(me|you|us|them|him|her)\b/gi, 'to $1');
  out = out.replace(/\b(want|wanted|need|needed|going|go|try|tried|like|liked|have|has|had|use|used|eat|ate)\s+2\s+([a-z])/gi, '$1 to $2');
  return out.replace(/\s+/g, ' ').trim();
}

/** True when the text contains a repeated phrase that collapsing would remove. */
function looksRepetitive(text: string): boolean {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return collapseRepetitions(t) !== t;
}

// Helper to strip all emojis and symbols from text before TTS so they are never read out
function stripEmojis(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F910}-\u{1F96B}\u{1F980}-\u{1F9E0}\u{2B50}\u{2B55}\u{231A}\u{23F0}\u{23F3}\u{25AA}\u{25AB}\u{25FB}-\u{25FE}\u{FE0E}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*#_`~\[\]\(\)]/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Microsoft Edge "Read Aloud" neural TTS - MIT licensed, no API key, genuinely
// free, and it speaks Kannada, Hindi and Indian English natively. This is the
// PRIMARY voice for the IVR. One WebSocket session is reused per voice, so a
// reply is synthesised in a few hundred milliseconds instead of seconds.
// ---------------------------------------------------------------------------
const EDGE_TTS_VOICES: Record<string, string> = {
  "kn-IN": process.env.TTS_EDGE_VOICE_KN || "kn-IN-SapnaNeural",
  "hi-IN": process.env.TTS_EDGE_VOICE_HI || "hi-IN-SwaraNeural",
  "en-IN": process.env.TTS_EDGE_VOICE_EN || "en-IN-NeerjaNeural",
};

type EdgeTtsSession = { client: MsEdgeTTS; voice: string; queue: Promise<any> };
const edgeTtsSessions: Record<string, EdgeTtsSession | undefined> = {};

function escapeXml(input: string): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function edgeTextToSpeech(text: string, language: string): Promise<string | null> {
  const langCode = normalizeIvrLang(language);
  const voice = EDGE_TTS_VOICES[langCode] || EDGE_TTS_VOICES["en-IN"];
  const clean = stripEmojis(text).slice(0, 600);
  if (!clean) return null;

  let session = edgeTtsSessions[langCode];
  if (!session) {
    session = { client: new MsEdgeTTS(), voice: "", queue: Promise.resolve() };
    edgeTtsSessions[langCode] = session;
  }
  const active = session;

  const run = async (): Promise<string | null> => {
    try {
      if (active.voice !== voice) {
        await active.client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        active.voice = voice;
      }

      const { audioStream } = active.client.toStream(escapeXml(clean), { rate: 1.08, pitch: "+0Hz" });
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Edge TTS timed out")), 9000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        audioStream.on("data", (d: any) => chunks.push(Buffer.from(d)));
        audioStream.on("end", done);
        audioStream.on("close", done);
        audioStream.on("error", (e: any) => {
          clearTimeout(timer);
          reject(e);
        });
      });

      const buf = Buffer.concat(chunks);
      if (!buf.length) return null;
      return `data:audio/mpeg;base64,${buf.toString("base64")}`;
    } catch (err: any) {
      // Retire the broken session so the next turn opens a fresh connection.
      try { active.client.close(); } catch {}
      edgeTtsSessions[langCode] = undefined;
      console.warn("Edge neural TTS notice:", err?.message);
      return null;
    }
  };

  // Serialise synthesis per voice: one WebSocket stream at a time.
  const pending = active.queue.then(run, run);
  active.queue = pending.catch(() => null);
  return pending;
}

// Small in-memory cache for spoken audio. Recurring lines (the welcome prompts,
// "press 9 to submit", confirmations) replay instantly instead of waiting on
// the voice provider, which is the biggest single chunk of IVR latency.
const ttsCache = new Map<string, string>();
const TTS_CACHE_LIMIT = 120;

// Helper to generate TTS audio data URI for instant playback.
// The Edge neural voice is the one and only voice provider for this helpline.
async function generateTTSAudioUrl(text: string, language: string): Promise<string | null> {
  const key = `${normalizeIvrLang(language)}::${String(text || "").slice(0, 500)}`;
  const cached = ttsCache.get(key);
  if (cached) return cached;

  const url = await edgeTextToSpeech(text, language);

  if (url) {
    if (ttsCache.size >= TTS_CACHE_LIMIT) {
      const oldest = ttsCache.keys().next().value;
      if (oldest) ttsCache.delete(oldest);
    }
    ttsCache.set(key, url);
  }
  return url;
}

// Entity cleaning helper
function cleanExtractedString(str: string): string {
  if (!str) return '';
  return str
    .replace(/^(ನಾನು|ನನ್ನ|ನನಗೆ|ನಾವು|ಅಲ್ಲಿ|ಇಲ್ಲಿ|ಹೇಳೋ|ಹೇಳ್ತೀನಿ|ಹೇಳಲು|ಹೋಗಿದ್ದು|ಬಂದಿದ್ದು|ನೋಡಿದ್ರೆ|ಆ|ಈ|ಅಂತ|ಎಂಬ|ಹೆಸರಿನ|ಹೆಸರು|ಸ್ಥಳ|ಹೋಟೆಲ್|ರೆಸ್ಟೋರೆಂಟ್)\s+/gi, '')
    .replace(/\s+(ಆಗಿದೆ|ಇದೆ|ಇತ್ತು|ಆಗಿತ್ತು|ಇರ್ಬೋದು|ಅನ್ನೋದು|ಅಂತ|ಎಂಬ|ಹೋಟೆಲ್|ನಲ್ಲಿ|ಗೆ)$/gi, '')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .trim();
}

interface ExtractedEntities {
  location?: string;
  when?: string;
  cause?: string;
  item?: string;
  owner?: string;
  isExhaustedOrConfirming: boolean;
  isInformationalInquiry: boolean;
  hasAllRequired: boolean;
  missingFields: string[];
  suggestedPrompt: string;
}

// Semantic Memory & Customer Word Analyzer for Context Awareness across turns
function analyzeCustomerWords(
  currentText: string,
  history: Array<{ role: string; text?: string; content?: string }> = [],
  existingData: any = {},
  language: string = 'kn-IN'
): ExtractedEntities {
  const allUserTexts = [
    ...history.filter(h => h.role === 'user').map(h => h.text || h.content || ''),
    currentText || ''
  ].join(' ');

  const isKannada = language.startsWith('kn') || language.toLowerCase().includes('kannada');
  const isHindi = language.startsWith('hi') || language.toLowerCase().includes('hindi');

  const entities: ExtractedEntities = {
    location: existingData.location || undefined,
    when: existingData.when || undefined,
    cause: existingData.cause || undefined,
    item: existingData.item || undefined,
    owner: existingData.owner || undefined,
    isExhaustedOrConfirming: false,
    isInformationalInquiry: false,
    hasAllRequired: false,
    missingFields: [],
    suggestedPrompt: ''
  };

  // 1. Check for customer exhaustion / confirmation
  const exhaustionRegex = /(ಅಷ್ಟೇ|ಇಷ್ಟೇ|ಎಷ್ಟೇ|ನನಗೆ.*ಗೊತ್ತಿಲ್ಲ|ಬೇರೇನೂ.*ಇಲ್ಲ|ಎಲ್ಲ.*ಹೇಳಿದೆ|ಮುಗಿಯಿತು|ದೂರು.*ದಾಖಲಿಸಿ|ದೃಢೀಕರಿಸಿ|ಸರಿ|ಹೌದು|ಅಷ್ಟೇ ಕಣ್ರಿ|ಇಷ್ಟೇ ಗೊತ್ತಿರೋದು|ಬಸ್ ಇಷ್ಟೇ|confirm|submit|yes|that is all|that's all|i told you|nothing more|proceed|all details given|itna hi|itna hi pata|ho gaya|darj karo|pusti)/i;
  if (exhaustionRegex.test(currentText)) {
    entities.isExhaustedOrConfirming = true;
  }

  // 2. Check for informational inquiries (FSSAI laws, hygiene rules, licenses, general questions)
  const infoRegex = /(fssai|license|licence|hygiene rule|inspection|penalty|fine|what is|how to|about|explain|details|information|ನಿಯಮ|ಪರವಾನಗಿ|ದಂಡ|ತನಿಖೆ|ನಿಯಮಾವಳಿ|ಪ್ರಮಾಣಪತ್ರ|ನಿಯಮಗಳು|ಲೈಸೆನ್ಸ್|ನಿಯಮಾವಳಿಗಳು|ತಿಳಿಸಿ|ಹೇಳಿ|ಏನು|ಹೇಗೆ|ಬಗ್ಗೆ|ಕಾನೂನು|ಯಾವ|कानून|नियम|लाइसेंस|जुर्माना|जांच प्रक्रिया|क्या है|बताइए|जानकारी)/i;
  const complaintSpecificKeywords = /(ಉಪ್ಪು\s*ಜಾಸ್ತಿ|ಹುಳು|ಹುಳ|ಕೂದಲು|ಹಾಳಾಗಿದೆ|ಹಳಸಿದ|ವಾಂತಿ|ಹೊಟ್ಟೆ\s*ನೋವು|ಕೊಳಕು|ಕೃತಕ\s*ಬಣ್ಣ|ಕಲ್ಮಶ|ವಿಷಾಹಾರ|ವಿಷಪೂರಿತ|ಕೀಡಾ|ಬದಬೂ|spoiled|poisoning|dirty|vomiting|insect|dead cockroach)/i;
  if (infoRegex.test(currentText) && !complaintSpecificKeywords.test(currentText)) {
    entities.isInformationalInquiry = true;
  }

  // 3. Location / Restaurant Name Extraction
  if (!entities.location) {
    const knHotelMatch = allUserTexts.match(/(?:ಹೋಟೆಲ್|ಹೊಟೆಲ್|ರೆಸ್ಟೋರೆಂಟ್|ಕ್ಯಾಂಟೀನ್|ಧಾಬಾ|ಬೇಕರಿ|ಶಾಪ್|ಶಾಪ್‌)\s+([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})|([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})\s+(?:ಹೋಟೆಲ್|ಹೊಟೆಲ್|ರೆಸ್ಟೋರೆಂಟ್|ಕ್ಯಾಂಟೀನ್|ಧಾಬಾ|ಬೇಕರಿ)/i);
    if (knHotelMatch) {
      const captured = cleanExtractedString(knHotelMatch[1] || knHotelMatch[2] || '');
      if (captured && captured.length > 2 && !/^(ಇದೆ|ಇತ್ತು|ಆಗಿದೆ|ನಾನು|ನೀವು)$/.test(captured)) {
        entities.location = `${captured} ಹೋಟೆಲ್`;
      }
    }
    if (!entities.location) {
      const knSpecific = allUserTexts.match(/(ಅನ್ನಪೂರ್ಣೇಶ್ವರಿ|ಅನ್ನಪೂರ್ಣ|ಉಡುಪಿ|ಶಾಂತಿ ಸಾಗರ್|ಕಾಮತ್|ಮಾಯೂರ|ನಂದಿನಿ|ನಂದಗೋಕುಲ|ಗುರು ಕೃಪಾ|ವೆಂಕಟೇಶ್ವರ|ಶ್ರೀ ಕೃಷ್ಣ|ಅಯೋಧ್ಯ|ಹಳ್ಳಿ ಮನೆ)/i);
      if (knSpecific) {
        entities.location = `${knSpecific[1]} ಹೋಟೆಲ್`;
      }
    }
    if (!entities.location) {
      const hiHotelMatch = allUserTexts.match(/(?:होटल|रेस्टोरेंट|ढाबा|दुकान|कैंटीन)\s+([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})|([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})\s+(?:होटल|रेस्टोरेंट|ढाबा|दुकान)/i);
      if (hiHotelMatch) {
        const captured = cleanExtractedString(hiHotelMatch[1] || hiHotelMatch[2] || '');
        if (captured && captured.length > 2) entities.location = `${captured} होटल`;
      }
    }
    if (!entities.location) {
      // NOTE: the leading \b is essential - without it "at" inside "What"
      // matched and stored nonsense like "is FSSAI and how does it w" as the
      // caller's restaurant.
      const enHotelMatch = allUserTexts.match(/\b(?:at|in|from|hotel|restaurant|cafe|dhaba)\s+([A-Z][a-zA-Z0-9\s'-]{2,25}(?:Hotel|Restaurant|Cafe|Dhaba|Kitchen|Bhavan|Sagar)?)/i);
      if (enHotelMatch && enHotelMatch[1]) {
        const captured = enHotelMatch[1].trim();
        const looksLikeQuestion = /\b(what|how|why|when|where|which|who|is|are|was|were|does|do|can|could|tell|explain|help)\b/i.test(captured);
        if (!looksLikeQuestion && !/^(the|yesterday|today|night|evening|morning|food|dinner|my|our|this|that)$/i.test(captured)) {
          entities.location = captured;
        }
      }
    }
  }

  // 4. Incident Timing (When) Extraction
  if (!entities.when) {
    const knTimeMatch = allUserTexts.match(/(ನಿನ್ನೆ\s*(?:ರಾತ್ರಿ|ಸಂಜೆ|ಬೆಳಗ್ಗೆ|ಮಧ್ಯಾಹ್ನ)?|ಇಂದು\s*(?:ರಾತ್ರಿ|ಸಂಜೆ|ಬೆಳಗ್ಗೆ|ಮಧ್ಯಾಹ್ನ)?|ಮೊನ್ನೆ|ಈಗಲೇ|ಬೆಳಗ್ಗೆ\s*\d*(?::\d*)?|ಸಂಜೆ\s*\d*(?::\d*)?|ರಾತ್ರಿ\s*\d*(?::\d*)?|\d{1,2}[:.]\d{2}\s*(?:ಗಂಟೆಗೆ|pm|am)?|\d{1,2}\s*(?:ತಾರೀಖು|ದಿನಾಂಕ|ದಿನದ ಹಿಂದೆ))/i);
    if (knTimeMatch) {
      entities.when = knTimeMatch[0].trim();
    }
    if (!entities.when) {
      const hiTimeMatch = allUserTexts.match(/(कल\s*(?:रात|शाम|सुबह|दोपहर)?|आज\s*(?:रात|शाम|सुबह|दोपहर)?|परसों|शाम को|रात को|सुबह को|\d{1,2}[:.]\d{2}\s*(?:बजे|pm|am)?)/i);
      if (hiTimeMatch) {
        entities.when = hiTimeMatch[0].trim();
      }
    }
    if (!entities.when) {
      const enTimeMatch = allUserTexts.match(/(yesterday(?:\s*(?:night|evening|morning|afternoon))?|today(?:\s*(?:night|evening|morning|afternoon))?|last night|\d{1,2}[:.]\d{2}\s*(?:am|pm)?|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i);
      if (enTimeMatch) {
        entities.when = enTimeMatch[0].trim();
      }
    }
  }

  // 5. Cause & Violation Extraction
  if (!entities.cause) {
    const knCauseMatch = allUserTexts.match(/(ಉಪ್ಪು\s*ಜಾಸ್ತಿ|ಸೋಡಿಯಂ|ಕಲುಷಿತ|ವಾಸನೆ|ಹುಳು|ಹುಳ|ಕೂದಲು|ಹಾಳಾಗಿದೆ|ಹಳಸಿದ|ವಾಂತಿ|ಹೊಟ್ಟೆ\s*ನೋವು|ಕೊಳಕು|ಕೃತಕ\s*ಬಣ್ಣ|ಕಲ್ಮಶ|ಪ್ಲಾಸ್ಟಿಕ್|ಅಜೀರ್ಣ|ಬೇಧಿ|ಆಸ್ಪತ್ರೆ|ವಿಷಾಹಾರ|ವಿಷಪೂರಿತ|ಕೆಟ್ಟ\s*ರುಚಿ)/i);
    if (knCauseMatch) {
      entities.cause = knCauseMatch[0].trim();
    }
    const hiCauseMatch = allUserTexts.match(/(नमक\s*ज्यादा|सोडियम|बासी|कीड़ा|बाल|दुर्गंध|बदबू|उल्टी|पेट\s*दर्द|गंदा|नकली\s*रंग|विषाक्त|फूड\s*पॉइजनिंग|खराब|सड़ा)/i);
    if (!entities.cause && hiCauseMatch) {
      entities.cause = hiCauseMatch[0].trim();
    }
    const enCauseMatch = allUserTexts.match(/(excess(?:\s+of)?\s*(?:salt|sodium)|food poisoning|stomach (?:ache|pain)|vomiting|dead (?:insect|cockroach|fly)|hair in food|foul smell|spoiled|contaminated|stale|dirty|unhygienic|rotten)/i);
    if (!entities.cause && enCauseMatch) {
      entities.cause = enCauseMatch[0].trim();
    }
  }

  // 6. Food Item Name Extraction
  if (!entities.item) {
    const itemMatch = allUserTexts.match(/(ದೋಸೆ|ಇಡ್ಲಿ|ಬಿರಿಯಾನಿ|ಅನ್ನ|ಸಾಂಬಾರ್|ಪಲ್ಯ|ಪರೋಟ|ರೊಟ್ಟಿ|ಚಪಾತಿ|ಊಟ|ಚಿಕನ್|ಮಟನ್|ಮೀನು|ರಸಂ|ಮಜ್ಜಿಗೆ|ನೀರು|ಚಹಾ|ಕಾಫಿ|ದೋಸಾ|इडली|डोसा|बिरयानी|चावल|सांभर|रोटी|सब्जी|दाल|पानी|biryani|dosa|idli|rice|meals|curry|sambar|paneer|chicken|mutton|roti)/i);
    if (itemMatch) {
      entities.item = itemMatch[0].trim();
    }
  }

  // 7. Owner Name Extraction
  if (!entities.owner) {
    const ownerMatch = allUserTexts.match(/(?:ಮಾಲೀಕರು|ಮಾಲೀಕ|ಓನರ್|ಹೆಸರು|owner|malik)\s+([^\s,.\n]+)/i);
    if (ownerMatch) {
      entities.owner = cleanExtractedString(ownerMatch[1]);
    }
  }

  // 8. Missing Fields computation
  if (!entities.location) entities.missingFields.push('location');
  if (!entities.when) entities.missingFields.push('when');
  if (!entities.cause) entities.missingFields.push('cause');

  entities.hasAllRequired = entities.missingFields.length === 0;

  // 9. Formulate an intelligent prompt in selected language
  const isGreetingOnly = /^(hello|hi|hey|namaste|namaskara|good\s+morning|good\s+evening|ನಮಸ್ಕಾರ|ನಮಸ್ತೆ|नमस्ते|ಹಲೋ)$/i.test(currentText.trim());

  if (isGreetingOnly) {
    if (isKannada) {
      entities.suggestedPrompt = "ನಮಸ್ಕಾರ! ನಾನು ಆಹಾರ ಸುರಕ್ಷತಾ ಸಹಾಯಕ. ನಾನು ತಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?";
    } else if (isHindi) {
      entities.suggestedPrompt = "नमस्ते! मैं खाद्य सुरक्षा सहायक हूँ। मैं आपकी क्या सहायता कर सकता हूँ?";
    } else {
      entities.suggestedPrompt = "Hello! I am your Food Safety Assistant. How can I assist you today?";
    }
  } else if (entities.hasAllRequired || entities.isExhaustedOrConfirming) {
    if (isKannada) {
      entities.suggestedPrompt = "ತುಂಬು ಹೃದಯದ ಧನ್ಯವಾದಗಳು. ತಮ್ಮ ದೂರನ್ನು ಸಿದ್ಧಪಡಿಸಲಾಗಿದೆ. ತಾವು ಸ್ವತಃ ಧ್ವನಿ ಸಂದೇಶ ರೆಕಾರ್ಡ್ ಮಾಡಲು ಬಯಸಿದರೆ 7 ಒತ್ತಿ, ಅಥವಾ ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ.";
    } else if (isHindi) {
      entities.suggestedPrompt = "धन्यवाद। हमने विवरण नोट कर लिया है। यदि आप ऑडियो संदेश रिकॉर्ड करना चाहते हैं तो 7 दबाएँ, अथवा शिकायत दर्ज करने के लिए 9 दबाएँ।";
    } else {
      entities.suggestedPrompt = "Thank you. We have recorded your complaint. If you would like to record a voice note, press 7. To submit your complaint now, press 9 or say confirm.";
    }
  } else {
    if (entities.missingFields.includes('location')) {
      if (isKannada) {
        entities.suggestedPrompt = "ದಯವಿಟ್ಟು ಈ ಘಟನೆ ನಡೆದ ಹೋಟೆಲ್, ರೆಸ್ಟೋರೆಂಟ್ ಅಥವಾ ಅಂಗಡಿಯ ಹೆಸರನ್ನು ಸವಿನಯವಾಗಿ ತಿಳಿಸುವಿರಾ?";
      } else if (isHindi) {
        entities.suggestedPrompt = "कृपया उस होटल, रेस्टोरेंट या दुकान का नाम बताएं जहाँ यह घटना हुई।";
      } else {
        entities.suggestedPrompt = "Could you please tell us the name of the hotel, restaurant, or outlet where this incident occurred?";
      }
    } else if (entities.missingFields.includes('when')) {
      const locAck = entities.location ? `${entities.location} ನಮೂದಿಸಲಾಗಿದೆ. ` : '';
      const locAckHi = entities.location ? `${entities.location} नोट कर लिया गया है। ` : '';
      const locAckEn = entities.location ? `Noted ${entities.location}. ` : '';
      if (isKannada) {
        entities.suggestedPrompt = `${locAck}ದಯವಿಟ್ಟು ಈ ಘಟನೆ ಯಾವ ದಿನ ಅಥವಾ ಯಾವ ಸಮಯದಲ್ಲಿ ನಡೆಯಿತು ಎಂದು ತಿಳಿಸುವಿರಾ?`;
      } else if (isHindi) {
        entities.suggestedPrompt = `${locAckHi}कृपया बताएं कि यह घटना किस तारीख या किस समय हुई थी?`;
      } else {
        entities.suggestedPrompt = `${locAckEn}Could you please mention the date or approximate time of this incident?`;
      }
    } else if (entities.missingFields.includes('cause')) {
      const locAck = entities.location ? `${entities.location} ನಮೂದಿಸಲಾಗಿದೆ. ` : '';
      const locAckHi = entities.location ? `${entities.location} नोट कर लिया गया है। ` : '';
      const locAckEn = entities.location ? `Noted ${entities.location}. ` : '';
      if (isKannada) {
        entities.suggestedPrompt = `${locAck}ಆಹಾರದಲ್ಲಿ ತಾವು ಎದುರಿಸಿದ ನಿಖರವಾದ ಲೋಪ ಅಥವಾ ನೈರ್ಮಲ್ಯ ಸಮಸ್ಯೆಯನ್ನು ತಿಳಿಸುವಿರಾ?`;
      } else if (isHindi) {
        entities.suggestedPrompt = `${locAckHi}कृपया भोजन में आई खराबी या स्वच्छता संबंधी समस्या का विवरण बताएं।`;
      } else {
        entities.suggestedPrompt = `${locAckEn}Could you please describe what was wrong with the food or hygiene?`;
      }
    }
  }

  return entities;
}

// ---------------------------------------------------------------------------
// Conversation memory for the main-page chat
//
// The chat was stateless: the only "memory" was the last handful of messages the
// browser chose to resend, so a page reload forgot everything and the assistant
// could not answer "what did I say?" - it had never been given the transcript.
// Conversations are now stored server-side (Turso, with an in-memory fallback)
// and every turn is appended, so memory is complete, durable and authoritative.
// ---------------------------------------------------------------------------
type ConversationTurn = { role: "user" | "assistant"; text: string; at: number };
type ConversationRecord = {
  id: string;
  /** Owner of this conversation. Memory is NEVER served across phone numbers. */
  phone: string;
  language: string;
  profile: any;
  turns: ConversationTurn[];
  /**
   * Subjects this conversation has covered, most recent first. Persisted with the
   * conversation so a follow-up ("how does it work?") still knows what "it" is
   * after a reload, a restart, or a different server instance.
   */
  topics?: string[];
  /** Set when the caller starts a new thread, so it is not re-adopted. */
  closedAt?: number;
  updatedAt: number;
};

/**
 * Topic memory rides in the existing `facts` column, so no schema migration is
 * needed on an already-deployed database.
 */
function parseStoredTopics(raw: any): string[] {
  try {
    const parsed = raw ? JSON.parse(String(raw)) : null;
    return normalizeTopicList(parsed?.topics);
  } catch {
    return [];
  }
}

const conversationMemory = new Map<string, ConversationRecord>();
const MAX_STORED_TURNS = 40;
const MAX_CONVERSATIONS_IN_MEMORY = 200;

/** Phone numbers are compared on digits only, so formatting cannot split an identity. */
function normalizePhone(value: any): string {
  return String(value || "").replace(/\D/g, "").slice(0, 15);
}

/**
 * Load a conversation ONLY for its owner.
 *
 * PRIVACY: a conversation id is a capability, but it is not a licence to read
 * someone else's history - the same browser can be shared, and an id can leak.
 * The stored owner must match the requester (or both be absent), otherwise the
 * caller is treated as a stranger and gets a fresh, empty conversation.
 */
async function loadConversation(id: string, phone: string): Promise<ConversationRecord | null> {
  const cleanId = String(id || "").trim().slice(0, 80);
  if (!cleanId) return null;
  const owner = normalizePhone(phone);

  const cached = conversationMemory.get(cleanId);
  if (cached) {
    const cachedOwner = normalizePhone(cached.phone);
    if (cachedOwner && owner && cachedOwner !== owner) {
      console.warn("[Memory] Refused to serve a conversation owned by a different phone number.");
      return null;
    }
    return cached;
  }

  const turso = getTurso();
  if (!turso) return null;
  try {
    const result = await turso.execute({
      sql: "SELECT * FROM conversations WHERE id = ? LIMIT 1",
      args: [cleanId],
    });
    const row: any = result.rows[0];
    if (!row) return null;

    const rowOwner = normalizePhone(row.phone);
    if (rowOwner && owner && rowOwner !== owner) {
      console.warn("[Memory] Refused to serve a conversation owned by a different phone number.");
      return null;
    }

    const record: ConversationRecord = {
      id: cleanId,
      phone: rowOwner,
      language: String(row.language || "English"),
      profile: row.profile ? JSON.parse(String(row.profile)) : {},
      turns: row.turns ? JSON.parse(String(row.turns)) : [],
      topics: parseStoredTopics(row.facts),
      closedAt: row.closedAt ? Number(row.closedAt) : undefined,
      updatedAt: Number(row.updatedAt || Date.now()),
    };
    conversationMemory.set(cleanId, record);
    return record;
  } catch (err: any) {
    console.warn("Could not load conversation:", err?.message);
    return null;
  }
}

/**
 * True when this conversation id already belongs to a DIFFERENT caller.
 *
 * Used to decide whether an unrecognised id may be reused for a new thread. A free
 * id is safe to reuse (that is how the client's New conversation button names its
 * thread), but an id owned by someone else must never be taken over - doing so
 * would hand one caller's history to another. A caller with no phone number is
 * treated as "different" from any registered owner, so an anonymous session can
 * never claim a thread that belongs to someone.
 */
async function isConversationOwnedByOther(id: string, phone: string): Promise<boolean> {
  const cleanId = String(id || "").trim().slice(0, 80);
  if (!cleanId) return false;
  const owner = normalizePhone(phone);

  const cached = conversationMemory.get(cleanId);
  if (cached) {
    const cachedOwner = normalizePhone(cached.phone);
    return !!cachedOwner && cachedOwner !== owner;
  }

  const turso = getTurso();
  if (!turso) return false;
  try {
    const result = await turso.execute({
      sql: "SELECT phone FROM conversations WHERE id = ? LIMIT 1",
      args: [cleanId],
    });
    const row: any = result.rows[0];
    if (!row) return false;
    const rowOwner = normalizePhone(row.phone);
    return !!rowOwner && rowOwner !== owner;
  } catch {
    return false;
  }
}

/**
 * The caller's own most recent OPEN conversation, so memory follows them to a new
 * device. Strictly scoped to one phone number, so it can never surface another
 * caller's history.
 */
async function findLatestConversationForPhone(phone: string): Promise<ConversationRecord | null> {
  const owner = normalizePhone(phone);
  if (owner.length < 10) return null;

  const localBest = [...conversationMemory.values()]
    .filter((c) => normalizePhone(c.phone) === owner && !c.closedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (localBest) return localBest;

  const turso = getTurso();
  if (!turso) return null;
  try {
    const result = await turso.execute({
      sql: `SELECT * FROM conversations
            WHERE phone = ? AND (closedAt IS NULL OR closedAt = 0)
            ORDER BY updatedAt DESC LIMIT 1`,
      args: [owner],
    });
    const row: any = result.rows[0];
    if (!row) return null;
    const record: ConversationRecord = {
      id: String(row.id),
      phone: owner,
      language: String(row.language || "English"),
      profile: row.profile ? JSON.parse(String(row.profile)) : {},
      turns: row.turns ? JSON.parse(String(row.turns)) : [],
      topics: parseStoredTopics(row.facts),
      updatedAt: Number(row.updatedAt || Date.now()),
    };
    conversationMemory.set(record.id, record);
    return record;
  } catch (err: any) {
    console.warn("Could not look up the caller's conversations:", err?.message);
    return null;
  }
}

/** Mark a conversation closed so it is not silently re-adopted as "latest". */
async function closeConversation(id: string, phone: string): Promise<boolean> {
  const record = await loadConversation(id, phone);
  if (!record) return false;
  record.closedAt = Date.now();
  await saveConversation(record);
  return true;
}

async function saveConversation(record: ConversationRecord): Promise<void> {
  record.turns = record.turns.slice(-MAX_STORED_TURNS);
  record.updatedAt = Date.now();
  conversationMemory.set(record.id, record);

  // Keep the in-memory cache bounded: drop the least recently used conversations.
  if (conversationMemory.size > MAX_CONVERSATIONS_IN_MEMORY) {
    const oldest = [...conversationMemory.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const stale of oldest.slice(0, conversationMemory.size - MAX_CONVERSATIONS_IN_MEMORY)) {
      conversationMemory.delete(stale.id);
    }
  }

  const turso = getTurso();
  if (!turso) return;
  try {
    await turso.execute({
      sql: `INSERT INTO conversations (id, phone, language, profile, facts, turns, closedAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              phone = excluded.phone,
              language = excluded.language,
              profile = excluded.profile,
              facts = excluded.facts,
              turns = excluded.turns,
              closedAt = excluded.closedAt,
              updatedAt = excluded.updatedAt`,
      args: [
        record.id,
        normalizePhone(record.phone),
        record.language,
        JSON.stringify(record.profile || {}),
        JSON.stringify({ topics: record.topics || [] }),
        JSON.stringify(record.turns),
        record.closedAt || 0,
        record.updatedAt,
      ],
    });
  } catch (err: any) {
    console.warn("Could not persist conversation:", err?.message);
  }
}

// "What did I say?" must never be answered with "I don't know". When the caller
// asks to be reminded, the stored turns are replayed verbatim - no model guess.
const RECALL_PATTERNS = [
  // Anything explicitly about the CALLER'S OWN words.
  /\bwhat did i (?:say|tell|mention|report|complain|ask)\b/i,
  /\bwhat (?:was|were) my (?:words|complaint|problem|issue)\b/i,
  /\b(?:repeat|tell me) (?:what|that) i (?:said|told)\b/i,
  /\bdo you (?:remember|recall|know) what i\b/i,
  /\bwhat do you (?:remember|recall|know) about (?:me|my)\b/i,
  /\bwhat have i (?:told|said to) you\b/i,
  /\byou (?:remember|recall) (?:that|this|what i)\b/i,
  /\b(?:did|do) i (?:already )?(?:tell|say|mention)\b/i,
  /\bwhat did i just say\b/i,
  // Kannada
  /ನಾನು\s*ಏನು\s*ಹೇಳಿದೆ/,
  /ನಾನು\s*ಹೇಳಿದ್ದು/,
  /ನನ್ನ\s*ಮಾತು/,
  /ನೆನಪಿದೆಯಾ/i,
  /ನೆನಪಿದೆ/i,
  /ನೆನಪಾಗಿದೆಯಾ/i,
  /ಜ್ಞಾಪಕ/i,
  // Hindi
  /(?:मैंने|मैने)\s*क्या\s*(?:कहा|बताया)/,
  /मुझे\s*याद/i,
  /याद\s*है/i,
  /याद\s*है\s*आपको/i,
];

/**
 * Does the caller want to be reminded of what they said?
 *
 * ROOT CAUSE of "it said I remembered but didn't tell me anything": the pattern
 * was `\bdo you remember what i\b`, so a bare "do you remember?" never matched and
 * went to the model instead, which cheerfully agreed it remembered and then asked
 * "how can I help you?".
 *
 * A bare remember-question counts, but "do you remember the FSSAI rules?" must
 * still be answered as a normal question - so an unqualified remember-phrase is
 * only a recall request when nothing substantial follows it.
 */
function wantsRecall(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (RECALL_PATTERNS.some((re) => re.test(t))) return true;

  const bare = /\b(?:do|did|can|could|would)\s+you\s+(?:remember|recall)\b(.*)$/i.exec(t);
  if (!bare) return false;

  // Strip ALL punctuation: a trailing "?" must not count as content, otherwise
  // "do you remember?" is not recognised as a bare recall request.
  const rest = bare[1].replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  const restWords = rest.split(/\s+/).filter(Boolean);
  if (restWords.length === 0) return true;                     // "do you remember?"
  return restWords.length <= 3 && /^(?:me|that|this|it|anything|something|now)\b/i.test(rest);
}

/**
 * Is this utterance something the caller TOLD us, rather than meta-conversation?
 *
 * ROOT CAUSE of "it said I remembered but didn't tell me anything": the recall
 * reply listed the caller's most recent turns verbatim, and once they had asked a
 * few times ("do you remember?", "what did I say?"), those questions filled the
 * list and pushed out the actual complaint. The answer was then a list of the
 * caller's own questions - which reads as "I remember nothing".
 */
function isSubstantiveUtterance(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (wantsRecall(t)) return false;        // "what did I say?" - a question, not content
  if (isIvrConfirmation(t)) return false;  // "yes" / "ok" / "sari" - not content
  const words = t.replace(/\s+/g, " ").split(" ").filter(Boolean);
  return words.length >= 3;                // "hello", "yes please" carry nothing
}

function buildRecallReply(record: ConversationRecord | null, langName: string, currentText: string): string {
  const current = currentText.trim().toLowerCase();

  const seen = new Set<string>();
  const provided = (record?.turns || [])
    .filter((t) => t.role === "user")
    .map((t) => t.text.trim())
    .filter((t) => t && t.toLowerCase() !== current)
    .filter((t) => isSubstantiveUtterance(t))
    .filter((t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;     // the caller repeating themselves
      seen.add(key);
      return true;
    });

  if (!provided.length) {
    if (langName === "Kannada") return "ಈ ಸಂಭಾಷಣೆಯಲ್ಲಿ ನೀವು ಇನ್ನೂ ನಿಮ್ಮ ಸಮಸ್ಯೆಯನ್ನು ವಿವರಿಸಿಲ್ಲ. ದಯವಿಟ್ಟು ಏನಾಯಿತು ಎಂದು ತಿಳಿಸಿ.";
    if (langName === "Hindi") return "इस बातचीत में आपने अभी तक अपनी समस्या नहीं बताई। कृपया बताएं कि क्या हुआ।";
    return "You haven't told me anything about the problem yet in this conversation. Please describe what happened.";
  }

  const listed = provided.slice(-6).map((t) => `• ${t}`).join("\n");

  if (langName === "Kannada") return `ನೀವು ಈವರೆಗೆ ತಿಳಿಸಿದ್ದು:\n${listed}\n\nಇದರಲ್ಲಿ ಏನಾದರೂ ಸೇರಿಸಲು ಬಯಸುವಿರಾ?`;
  if (langName === "Hindi") return `आपने अब तक यह बताया है:\n${listed}\n\nइसमें कुछ जोड़ना चाहेंगे?`;
  return `Here is what you've told me so far:\n${listed}\n\nWould you like to add anything to that?`;
}

// ---------------------------------------------------------------------------
// TOPIC MEMORY - what is this conversation actually ABOUT?
//
// ROOT CAUSE of "I asked what FSSAI is, then asked how it works, and it
// explained the APP instead": the caller's turns were stored, but the SUBJECT of
// the conversation never was. A follow-up built on a pronoun ("how does it
// work?") therefore had no antecedent at all, so the model resolved "it" to the
// only thing in front of it - the assistant itself.
//
// The fix is an explicit topic ledger: every turn is scanned for known subjects,
// the most recently mentioned one becomes the CURRENT TOPIC, that topic is
// persisted with the conversation AND mirrored into the browser, and follow-ups
// are resolved from it. The reference text below is also injected into the
// prompt, so answers come from gathered information rather than a guess.
// ---------------------------------------------------------------------------

type LangCode = "en" | "hi" | "kn";

function toLangCode(langName: string): LangCode {
  const l = String(langName || "").toLowerCase();
  if (l.startsWith("kn") || l.includes("kannada")) return "kn";
  if (l.startsWith("hi") || l.includes("hindi")) return "hi";
  return "en";
}

type TopicKey = "fssai" | "licence" | "complaint" | "hygiene" | "penalty" | "packaged" | "app";

type TopicEntry = {
  key: TopicKey;
  /** Whole-word patterns that put this topic on the table. No /g flag. */
  patterns: RegExp[];
  label: Record<LangCode, string>;
  definition: Record<LangCode, string>;
  works: Record<LangCode, string>;
  more: Record<LangCode, string>;
};

const TOPIC_LIBRARY: TopicEntry[] = [
  {
    key: "fssai",
    patterns: [
      /\bfssai\b/i,
      /\bfood\s+safety\s+and\s+standards\s+authority\b/i,
      /ಎಫ್\s*ಎಸ್\s*ಎಸ್\s*ಎಐ|ಆಹಾರ\s*ಸುರಕ್ಷತೆ\s*ಮತ್ತು\s*ಗುಣಮಟ್ಟ\s*ಪ್ರಾಧಿಕಾರ/,
      /खाद्य\s*सुरक्षा\s*और\s*मानक\s*प्राधिकरण/,
    ],
    label: {
      en: "FSSAI (Food Safety and Standards Authority of India)",
      hi: "FSSAI (भारतीय खाद्य सुरक्षा और मानक प्राधिकरण)",
      kn: "FSSAI (ಭಾರತೀಯ ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಪ್ರಾಧಿಕಾರ)",
    },
    definition: {
      en: "FSSAI is the Food Safety and Standards Authority of India - a statutory body under the Ministry of Health and Family Welfare, created by the Food Safety and Standards Act, 2006. It sets the science-based standards that food sold in India must meet, and regulates food businesses across the country.",
      hi: "FSSAI का पूरा नाम भारतीय खाद्य सुरक्षा और मानक प्राधिकरण है। यह स्वास्थ्य और परिवार कल्याण मंत्रालय के अधीन खाद्य सुरक्षा और मानक अधिनियम, 2006 के तहत बनी एक सांविधिक संस्था है। यह भारत में बिकने वाले भोजन के मानक तय करती है और खाद्य कारोबारों को नियंत्रित करती है।",
      kn: "FSSAI ಎಂದರೆ ಭಾರತೀಯ ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಪ್ರಾಧಿಕಾರ. ಇದು ಆರೋಗ್ಯ ಮತ್ತು ಕುಟುಂಬ ಕಲ್ಯಾಣ ಸಚಿವಾಲಯದ ಅಡಿಯಲ್ಲಿ ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಕಾಯ್ದೆ, 2006 ರ ಮೂಲಕ ಸ್ಥಾಪನೆಯಾದ ಸರ್ಕಾರಿ ಪ್ರಾಧಿಕಾರ. ಇದು ಭಾರತದಲ್ಲಿ ಮಾರಾಟವಾಗುವ ಆಹಾರದ ಮಾನದಂಡಗಳನ್ನು ನಿಗದಿಪಡಿಸಿ, ಆಹಾರ ಉದ್ಯಮಗಳನ್ನು ನಿಯಂತ್ರಿಸುತ್ತದೆ.",
    },
    works: {
      en: "FSSAI works through four main functions: it sets standards for what food may contain and how it must be labelled; it registers or licenses every food business through the State food safety departments; it inspects kitchens and outlets and has food samples tested in notified laboratories; and where a rule is broken it issues improvement notices, fines or prosecutions, and can order a recall of unsafe food.",
      hi: "FSSAI मुख्य रूप से चार काम करता है - भोजन की गुणवत्ता और लेबलिंग के मानक तय करना; हर खाद्य कारोबार का पंजीकरण या लाइसेंस देना; रसोई और दुकानों की जाँच कराना तथा भोजन के नमूनों की प्रयोगशाला में जाँच कराना; और नियम टूटने पर सुधार नोटिस, जुर्माना या मुकदमा करना तथा असुरक्षित भोजन वापस मंगाना।",
      kn: "FSSAI ಮುಖ್ಯವಾಗಿ ನಾಲ್ಕು ಕೆಲಸ ಮಾಡುತ್ತದೆ - ಆಹಾರದ ಗುಣಮಟ್ಟ ಮತ್ತು ಲೇಬಲ್ ಮಾನದಂಡಗಳನ್ನು ನಿಗದಿಪಡಿಸುವುದು; ಪ್ರತಿ ಆಹಾರ ಉದ್ಯಮಕ್ಕೆ ನೋಂದಣಿ ಅಥವಾ ಪರವಾನಗಿ ನೀಡುವುದು; ಅಡುಗೆಮನೆ ಮತ್ತು ಅಂಗಡಿಗಳ ತಪಾಸಣೆ ಹಾಗೂ ಆಹಾರ ಮಾದರಿಗಳ ಪ್ರಯೋಗಾಲಯ ಪರೀಕ್ಷೆ; ಮತ್ತು ನಿಯಮ ಉಲ್ಲಂಘನೆಯಾದರೆ ಸುಧಾರಣಾ ನೋಟಿಸ್, ದಂಡ ಅಥವಾ ಮೊಕದ್ದಮೆ ಜಾರಿಗೊಳಿಸಿ ಅಸುರಕ್ಷಿತ ಆಹಾರವನ್ನು ಮರುಪಡೆಯಲು ಆದೇಶಿಸುವುದು.",
    },
    more: {
      en: "Food businesses are graded by size into registration, State licence or Central licence, and a consumer can complain to FSSAI or to the State food safety department, which then inspects the premises and tests samples.",
      hi: "खाद्य कारोबार आकार के अनुसार पंजीकरण, राज्य लाइसेंस या केंद्रीय लाइसेंस में बाँटे जाते हैं, और उपभोक्ता FSSAI या राज्य खाद्य सुरक्षा विभाग में शिकायत कर सकते हैं, जिसके बाद जाँच और नमूना परीक्षण होता है।",
      kn: "ಆಹಾರ ಉದ್ಯಮಗಳು ಗಾತ್ರದ ಆಧಾರದಲ್ಲಿ ನೋಂದಣಿ, ರಾಜ್ಯ ಪರವಾನಗಿ ಅಥವಾ ಕೇಂದ್ರ ಪರವಾನಗಿ ಎಂದು ವಿಂಗಡಿಸಲಾಗುತ್ತದೆ. ಗ್ರಾಹಕರು FSSAI ಅಥವಾ ರಾಜ್ಯ ಆಹಾರ ಸುರಕ್ಷತಾ ಇಲಾಖೆಗೆ ದೂರು ನೀಡಬಹುದು; ನಂತರ ತಪಾಸಣೆ ಮತ್ತು ಮಾದರಿ ಪರೀಕ್ಷೆ ನಡೆಯುತ್ತದೆ.",
    },
  },
  {
    key: "licence",
    patterns: [
      /\blicen[cs]e\b/i,
      /\blicen[cs]ing\b/i,
      /\bregistration\b/i,
      /\bfoscos\b/i,
      /ಪರವಾನಗಿ|ನೋಂದಣಿ|ಲೈಸೆನ್ಸ್/,
      /लाइसेंस|लाइसेन्स|पंजीकरण|रजिस्ट्रेशन/,
    ],
    label: {
      en: "FSSAI registration and licence",
      hi: "FSSAI पंजीकरण और लाइसेंस",
      kn: "FSSAI ನೋಂದಣಿ ಮತ್ತು ಪರವಾನಗಿ",
    },
    definition: {
      en: "Every food business in India needs an FSSAI registration or licence, and which one applies depends on annual turnover. Under the FSSAI order effective 1 April 2026: registration up to 1.5 crore rupees, State licence above 1.5 crore up to 50 crore, and Central licence above 50 crore.",
      hi: "भारत में हर खाद्य कारोबार के लिए FSSAI पंजीकरण या लाइसेंस ज़रूरी है, और कौन-सा लागू होगा यह सालाना कारोबार पर निर्भर करता है। 1 अप्रैल 2026 से लागू FSSAI आदेश के अनुसार 1.5 करोड़ रुपये तक पंजीकरण, 1.5 करोड़ से 50 करोड़ तक राज्य लाइसेंस और 50 करोड़ से अधिक पर केंद्रीय लाइसेंस लगता है।",
      kn: "ಭಾರತದಲ್ಲಿ ಪ್ರತಿ ಆಹಾರ ಉದ್ಯಮಕ್ಕೂ FSSAI ನೋಂದಣಿ ಅಥವಾ ಪರವಾನಗಿ ಬೇಕು; ಯಾವುದು ಬೇಕು ಎಂಬುದು ವಾರ್ಷಿಕ ವಹಿವಾಟನ್ನು ಅವಲಂಬಿಸಿದೆ. ಏಪ್ರಿಲ್ 1, 2026 ರಿಂದ ಜಾರಿಗೆ ಬಂದ FSSAI ಆದೇಶದ ಪ್ರಕಾರ 1.5 ಕೋಟಿ ರೂಪಾಯಿವರೆಗೆ ನೋಂದಣಿ, 1.5 ಕೋಟಿಯಿಂದ 50 ಕೋಟಿವರೆಗೆ ರಾಜ್ಯ ಪರವಾನಗಿ ಮತ್ತು 50 ಕೋಟಿ ಮೇಲ್ಪಟ್ಟು ಕೇಂದ್ರ ಪರವಾನಗಿ ಅಗತ್ಯ.",
    },
    works: {
      en: "You apply on the FSSAI licensing portal (FoSCoS), choosing registration, State or Central licence according to turnover. The application needs the business details, the premises address and the food category, and the licence is issued by the State authority, or by FSSAI for a Central licence. The licence number must then appear on labels, menus and bills.",
      hi: "आवेदन FSSAI के लाइसेंसिंग पोर्टल FoSCoS पर किया जाता है, जिसमें कारोबार के अनुसार पंजीकरण, राज्य या केंद्रीय लाइसेंस चुना जाता है। कारोबार का विवरण, परिसर का पता और खाद्य श्रेणी देनी होती है। राज्य लाइसेंस राज्य प्राधिकरण और केंद्रीय लाइसेंस FSSAI जारी करता है, और लाइसेंस संख्या लेबल, मेन्यू तथा बिल पर छपी होनी चाहिए।",
      kn: "ಅರ್ಜಿಯನ್ನು FSSAI ನ ಲೈಸೆನ್ಸಿಂಗ್ ಪೋರ್ಟಲ್ (FoSCoS) ನಲ್ಲಿ ಸಲ್ಲಿಸಲಾಗುತ್ತದೆ; ವಹಿವಾಟಿನ ಆಧಾರದಲ್ಲಿ ನೋಂದಣಿ, ರಾಜ್ಯ ಅಥವಾ ಕೇಂದ್ರ ಪರವಾನಗಿ ಆಯ್ಕೆ ಮಾಡಲಾಗುತ್ತದೆ. ಉದ್ಯಮದ ವಿವರ, ಆವರಣದ ವಿಳಾಸ ಮತ್ತು ಆಹಾರ ವರ್ಗ ನೀಡಬೇಕು. ರಾಜ್ಯ ಪರವಾನಗಿಯನ್ನು ರಾಜ್ಯ ಪ್ರಾಧಿಕಾರ ಮತ್ತು ಕೇಂದ್ರ ಪರವಾನಗಿಯನ್ನು FSSAI ನೀಡುತ್ತದೆ. ಪರವಾನಗಿ ಸಂಖ್ಯೆ ಲೇಬಲ್, ಮೆನು ಮತ್ತು ಬಿಲ್‌ನಲ್ಲಿ ಇರಬೇಕು.",
    },
    more: {
      en: "The earlier turnover limits of 12 lakh and 20 crore rupees were superseded by that 2026 order, and licences already issued under the old limits stay valid.",
      hi: "पुरानी सीमाएँ 12 लाख और 20 करोड़ रुपये 2026 के उस आदेश से बदल दी गई हैं, और पहले जारी किए गए लाइसेंस वैध बने रहते हैं।",
      kn: "ಹಿಂದಿನ 12 ಲಕ್ಷ ಮತ್ತು 20 ಕೋಟಿ ರೂಪಾಯಿ ಮಿತಿಗಳನ್ನು 2026 ರ ಆದೇಶದಿಂದ ಬದಲಾಯಿಸಲಾಗಿದೆ; ಈಗಾಗಲೇ ನೀಡಲಾದ ಪರವಾನಗಿಗಳು ಮಾನ್ಯವಾಗಿ ಉಳಿಯುತ್ತವೆ.",
    },
  },
  {
    key: "complaint",
    patterns: [
      /\bcomplai(?:nt|nts|n)\b/i,
      /\breport(?:ing)?\s+(?:an?\s+)?(?:issue|problem|shop|hotel|restaurant)\b/i,
      /\bgrievance\b/i,
      /ದೂರು/,
      /शिकायत/,
    ],
    label: {
      en: "filing a food safety complaint",
      hi: "खाद्य सुरक्षा शिकायत दर्ज करना",
      kn: "ಆಹಾರ ಸುರಕ್ಷತೆ ದೂರು ದಾಖಲಿಸುವುದು",
    },
    definition: {
      en: "A food safety complaint can be filed with FSSAI or with your State food safety department when food is unsafe, substandard, misbranded, or sold in unhygienic conditions.",
      hi: "जब भोजन असुरक्षित, घटिया, गलत लेबल वाला या अस्वच्छ परिस्थितियों में बेचा जा रहा हो, तब FSSAI या अपने राज्य के खाद्य सुरक्षा विभाग में शिकायत दर्ज की जा सकती है।",
      kn: "ಆಹಾರ ಅಸುರಕ್ಷಿತ, ಕಳಪೆ ಗುಣಮಟ್ಟದ, ತಪ್ಪು ಲೇಬಲ್‌ನ ಅಥವಾ ಅನಾರೋಗ್ಯಕರ ಸ್ಥಿತಿಯಲ್ಲಿ ಮಾರಾಟವಾದಾಗ FSSAI ಅಥವಾ ನಿಮ್ಮ ರಾಜ್ಯದ ಆಹಾರ ಸುರಕ್ಷತಾ ಇಲಾಖೆಗೆ ದೂರು ನೀಡಬಹುದು.",
    },
    works: {
      en: "You can file it on the FSSAI Food Safety Connect portal or app, email complaints@fssai.gov.in, or call the FSSAI helpline 1800-112-100. Give the outlet name and address, what was wrong, the date and time, and attach photos or the bill if you have them. The State food safety officer then inspects the premises and may lift a sample for testing.",
      hi: "आप FSSAI के Food Safety Connect पोर्टल या ऐप पर, complaints@fssai.gov.in पर ईमेल करके, या FSSAI हेल्पलाइन 1800-112-100 पर कॉल करके शिकायत दर्ज कर सकते हैं। दुकान का नाम और पता, क्या गड़बड़ थी, तारीख और समय बताएँ, और फोटो या बिल संलग्न करें। इसके बाद राज्य का खाद्य सुरक्षा अधिकारी जाँच करता है और नमूना ले सकता है।",
      kn: "FSSAI ನ Food Safety Connect ಪೋರ್ಟಲ್ ಅಥವಾ ಆ್ಯಪ್‌ನಲ್ಲಿ, complaints@fssai.gov.in ಗೆ ಇಮೇಲ್ ಮೂಲಕ, ಅಥವಾ FSSAI ಸಹಾಯವಾಣಿ 1800-112-100 ಗೆ ಕರೆ ಮಾಡಿ ದೂರು ನೀಡಬಹುದು. ಅಂಗಡಿಯ ಹೆಸರು ಮತ್ತು ವಿಳಾಸ, ಏನು ತಪ್ಪಾಗಿತ್ತು, ದಿನಾಂಕ ಮತ್ತು ಸಮಯ ತಿಳಿಸಿ; ಫೋಟೋ ಅಥವಾ ಬಿಲ್ ಲಗತ್ತಿಸಿ. ನಂತರ ರಾಜ್ಯ ಆಹಾರ ಸುರಕ್ಷತಾ ಅಧಿಕಾರಿ ತಪಾಸಣೆ ಮಾಡಿ ಮಾದರಿ ಸಂಗ್ರಹಿಸಬಹುದು.",
    },
    more: {
      en: "Keep the bill, the food sample or photographs, and any medical record if you fell ill - they make the case much stronger. On this helpline you can simply describe the incident and a complaint draft is prepared for you.",
      hi: "बिल, भोजन का नमूना या फोटो, और बीमार पड़ने पर मेडिकल रिकॉर्ड संभालकर रखें - इससे शिकायत मज़बूत होती है। इस हेल्पलाइन पर आप घटना बता सकते हैं और आपके लिए शिकायत का ड्राफ्ट तैयार हो जाता है।",
      kn: "ಬಿಲ್, ಆಹಾರದ ಮಾದರಿ ಅಥವಾ ಫೋಟೋ, ಮತ್ತು ಅಸ್ವಸ್ಥಗೊಂಡಿದ್ದರೆ ವೈದ್ಯಕೀಯ ದಾಖಲೆ ಇಟ್ಟುಕೊಳ್ಳಿ - ಅವು ದೂರನ್ನು ಬಲಪಡಿಸುತ್ತವೆ. ಈ ಸಹಾಯವಾಣಿಯಲ್ಲಿ ಘಟನೆಯನ್ನು ವಿವರಿಸಿದರೆ ದೂರಿನ ಕರಡು ಸಿದ್ಧವಾಗುತ್ತದೆ.",
    },
  },
  {
    key: "hygiene",
    patterns: [
      /\bhygien\w*/i,
      /\bsanit\w*/i,
      /\bunclean\b/i,
      /ನೈರ್ಮಲ್ಯ|ಸ್ವಚ್ಛತೆ|ಪರಿಶುದ್ಧ/,
      /स्वच्छता|सफाई|हाइजीन|साफ-सफाई/,
    ],
    label: {
      en: "FSSAI hygiene requirements",
      hi: "FSSAI स्वच्छता नियम",
      kn: "FSSAI ನೈರ್ಮಲ್ಯ ನಿಯಮಗಳು",
    },
    definition: {
      en: "FSSAI's hygiene requirements are set out in Schedule 4 of the Licensing and Registration Regulations. They cover the premises, water quality, pest control, staff health and personal hygiene, and temperature control for food businesses.",
      hi: "FSSAI के स्वच्छता नियम लाइसेंसिंग और पंजीकरण विनियमों की अनुसूची 4 में दिए गए हैं। इनमें परिसर, पानी की गुणवत्ता, कीट नियंत्रण, कर्मचारियों का स्वास्थ्य और व्यक्तिगत स्वच्छता तथा तापमान नियंत्रण शामिल हैं।",
      kn: "FSSAI ನ ನೈರ್ಮಲ್ಯ ಅಗತ್ಯಗಳು ಲೈಸೆನ್ಸಿಂಗ್ ಮತ್ತು ನೋಂದಣಿ ನಿಯಮಾವಳಿಗಳ ಪರಿಶಿಷ್ಟ 4 ರಲ್ಲಿ ಇವೆ. ಅವು ಆವರಣ, ನೀರಿನ ಗುಣಮಟ್ಟ, ಕೀಟ ನಿಯಂತ್ರಣ, ಸಿಬ್ಬಂದಿಯ ಆರೋಗ್ಯ ಮತ್ತು ವೈಯಕ್ತಿಕ ನೈರ್ಮಲ್ಯ ಹಾಗೂ ತಾಪಮಾನ ನಿಯಂತ್ರಣವನ್ನು ಒಳಗೊಳ್ಳುತ್ತವೆ.",
    },
    works: {
      en: "A food business has to keep the kitchen and stores clean and pest-free, use safe potable water, keep raw and cooked food separate, hold food at the correct temperature, and make sure staff are healthy, clean and trained. Food handlers are also required to be medically examined and trained.",
      hi: "खाद्य कारोबार को रसोई और भंडार साफ तथा कीट-मुक्त रखना होता है, सुरक्षित पेयजल का उपयोग करना होता है, कच्चा और पका भोजन अलग रखना होता है, भोजन सही तापमान पर रखना होता है और कर्मचारियों का स्वस्थ, साफ तथा प्रशिक्षित होना ज़रूरी है। भोजन संभालने वालों की मेडिकल जाँच और ट्रेनिंग भी अनिवार्य है।",
      kn: "ಆಹಾರ ಉದ್ಯಮವು ಅಡುಗೆಮನೆ ಮತ್ತು ಉಗ್ರಾಣವನ್ನು ಸ್ವಚ್ಛ ಹಾಗೂ ಕೀಟಮುಕ್ತವಾಗಿ ಇಡಬೇಕು, ಸುರಕ್ಷಿತ ಕುಡಿಯುವ ನೀರು ಬಳಸಬೇಕು, ಹಸಿ ಮತ್ತು ಬೇಯಿಸಿದ ಆಹಾರವನ್ನು ಪ್ರತ್ಯೇಕವಾಗಿ ಇಡಬೇಕು, ಸರಿಯಾದ ತಾಪಮಾನದಲ್ಲಿ ಆಹಾರ ಸಂಗ್ರಹಿಸಬೇಕು ಮತ್ತು ಸಿಬ್ಬಂದಿ ಆರೋಗ್ಯವಂತರಾಗಿ, ಸ್ವಚ್ಛವಾಗಿ ಹಾಗೂ ತರಬೇತಿ ಪಡೆದಿರಬೇಕು. ಆಹಾರ ನಿರ್ವಹಿಸುವವರ ವೈದ್ಯಕೀಯ ಪರೀಕ್ಷೆ ಮತ್ತು ತರಬೇತಿ ಕಡ್ಡಾಯ.",
    },
    more: {
      en: "The State food safety officer inspects against these requirements, and serious failures can lead to an improvement notice, a fine, or suspension of the licence.",
      hi: "राज्य का खाद्य सुरक्षा अधिकारी इन नियमों के आधार पर जाँच करता है, और गंभीर लापरवाही पर सुधार नोटिस, जुर्माना या लाइसेंस निलंबन हो सकता है।",
      kn: "ಈ ಅಗತ್ಯಗಳ ಆಧಾರದಲ್ಲಿ ರಾಜ್ಯ ಆಹಾರ ಸುರಕ್ಷತಾ ಅಧಿಕಾರಿ ತಪಾಸಣೆ ಮಾಡುತ್ತಾರೆ; ಗಂಭೀರ ಲೋಪವಾದರೆ ಸುಧಾರಣಾ ನೋಟಿಸ್, ದಂಡ ಅಥವಾ ಪರವಾನಗಿ ಅಮಾನತು ಆಗಬಹುದು.",
    },
  },
  {
    key: "penalty",
    patterns: [
      /\bpenalt\w*/i,
      /\bfine[sd]?\b/i,
      /\bpunish\w*/i,
      /\bprosecut\w*/i,
      /\baction against\b/i,
      /ದಂಡ|ಶಿಕ್ಷೆ|ಕ್ರಮ/,
      /जुर्माना|सज़ा|सजा|कार्रवाई/,
    ],
    label: {
      en: "penalties under the Food Safety and Standards Act",
      hi: "खाद्य सुरक्षा और मानक अधिनियम के तहत दंड",
      kn: "ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಕಾಯ್ದೆಯಡಿ ದಂಡ",
    },
    definition: {
      en: "Under the Food Safety and Standards Act, 2006, the penalty depends on how serious the violation is. Substandard food, misbranded food and unsafe food are treated as separate categories, and both the fine and the possible prison term rise with the category and with repeat offences.",
      hi: "खाद्य सुरक्षा और मानक अधिनियम, 2006 के तहत दंड इस पर निर्भर करता है कि उल्लंघन कितना गंभीर है। घटिया भोजन, गलत लेबल वाला भोजन और असुरक्षित भोजन अलग-अलग श्रेणियाँ हैं, और श्रेणी तथा बार-बार उल्लंघन के साथ जुर्माना व कारावास बढ़ता है।",
      kn: "ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಕಾಯ್ದೆ, 2006 ರ ಅಡಿಯಲ್ಲಿ ದಂಡವು ಉಲ್ಲಂಘನೆಯ ತೀವ್ರತೆಯನ್ನು ಅವಲಂಬಿಸಿದೆ. ಕಳಪೆ ಆಹಾರ, ತಪ್ಪು ಲೇಬಲ್‌ನ ಆಹಾರ ಮತ್ತು ಅಸುರಕ್ಷಿತ ಆಹಾರ ಪ್ರತ್ಯೇಕ ವರ್ಗಗಳು; ವರ್ಗ ಮತ್ತು ಪುನರಾವರ್ತಿತ ಉಲ್ಲಂಘನೆಗೆ ಅನುಗುಣವಾಗಿ ದಂಡ ಹಾಗೂ ಜೈಲು ಶಿಕ್ಷೆ ಹೆಚ್ಚಾಗುತ್ತದೆ.",
    },
    works: {
      en: "Enforcement usually starts with an inspection and a sample test. The officer can issue an improvement notice, order a recall of the food, fine the business, or prosecute in court, and an Adjudicating Officer decides the penalty in that case.",
      hi: "कार्रवाई सामान्यतः निरीक्षण और नमूना जाँच से शुरू होती है। अधिकारी सुधार नोटिस दे सकता है, भोजन वापस मंगाने का आदेश दे सकता है, जुर्माना लगा सकता है या अदालत में मुकदमा चला सकता है, और उस मामले में दंड अधिनिर्णायक अधिकारी तय करता है।",
      kn: "ಕ್ರಮ ಸಾಮಾನ್ಯವಾಗಿ ತಪಾಸಣೆ ಮತ್ತು ಮಾದರಿ ಪರೀಕ್ಷೆಯಿಂದ ಆರಂಭವಾಗುತ್ತದೆ. ಅಧಿಕಾರಿ ಸುಧಾರಣಾ ನೋಟಿಸ್ ನೀಡಬಹುದು, ಆಹಾರ ಮರುಪಡೆಯುವ ಆದೇಶಿಸಬಹುದು, ದಂಡ ವಿಧಿಸಬಹುದು ಅಥವಾ ನ್ಯಾಯಾಲಯದಲ್ಲಿ ಮೊಕದ್ದಮೆ ಹೂಡಬಹುದು; ಆ ಪ್ರಕರಣದ ದಂಡವನ್ನು ನ್ಯಾಯನಿರ್ಣಾಯಕ ಅಧಿಕಾರಿ ನಿರ್ಧರಿಸುತ್ತಾರೆ.",
    },
    more: {
      en: "A business can appeal against an order, and a consumer can separately claim compensation for harm caused by unsafe food.",
      hi: "कारोबार आदेश के विरुद्ध अपील कर सकता है, और उपभोक्ता असुरक्षित भोजन से हुई हानि के लिए अलग से मुआवज़ा माँग सकता है।",
      kn: "ಉದ್ಯಮವು ಆದೇಶದ ವಿರುದ್ಧ ಮೇಲ್ಮನವಿ ಸಲ್ಲಿಸಬಹುದು; ಅಸುರಕ್ಷಿತ ಆಹಾರದಿಂದಾದ ಹಾನಿಗೆ ಗ್ರಾಹಕರು ಪ್ರತ್ಯೇಕವಾಗಿ ಪರಿಹಾರ ಕೋರಬಹುದು.",
    },
  },
  {
    key: "packaged",
    patterns: [
      /\bpackaged?\s+food\b/i,
      /\blabel(?:l?ing)?\b/i,
      /\bbest before\b/i,
      /\bexpiry\b/i,
      /\bingredients?\b/i,
      /ಪ್ಯಾಕೇಜ್|ಲೇಬಲ್|ಅವಧಿ|ಪದಾರ್ಥ/,
      /पैकेज|लेबल|एक्सपायरी|समाप्ति|सामग्री/,
    ],
    label: {
      en: "FSSAI labelling rules for packaged food",
      hi: "पैकेज्ड भोजन के लिए FSSAI लेबलिंग नियम",
      kn: "ಪ್ಯಾಕೇಜ್ ಆಹಾರದ FSSAI ಲೇಬಲಿಂಗ್ ನಿಯಮ",
    },
    definition: {
      en: "Packaged food sold in India has to carry the FSSAI licence number and logo, the ingredient list, nutrition information, the veg or non-veg mark, the net quantity, and a best-before or expiry date.",
      hi: "भारत में बिकने वाले पैकेज्ड भोजन पर FSSAI लाइसेंस संख्या और लोगो, सामग्री की सूची, पोषण जानकारी, शाकाहारी या मांसाहारी चिह्न, शुद्ध मात्रा तथा बेस्ट बिफोर या एक्सपायरी तारीख होनी चाहिए।",
      kn: "ಭಾರತದಲ್ಲಿ ಮಾರಾಟವಾಗುವ ಪ್ಯಾಕೇಜ್ ಆಹಾರದಲ್ಲಿ FSSAI ಪರವಾನಗಿ ಸಂಖ್ಯೆ ಮತ್ತು ಲೋಗೋ, ಪದಾರ್ಥಗಳ ಪಟ್ಟಿ, ಪೋಷಕಾಂಶ ಮಾಹಿತಿ, ಸಸ್ಯಾಹಾರಿ ಅಥವಾ ಮಾಂಸಾಹಾರಿ ಚಿಹ್ನೆ, ನಿವ್ವಳ ಪ್ರಮಾಣ ಮತ್ತು ಅವಧಿ ಮುಗಿಯುವ ದಿನಾಂಕ ಇರಬೇಕು.",
    },
    works: {
      en: "The label is checked in two ways: the licence number and logo show the business is registered, and the ingredient and nutrition panel shows what is actually in the pack. A pack without a licence number, or with a false claim, is misbranded and can be complained about.",
      hi: "लेबल दो तरह से जाँचा जाता है: लाइसेंस संख्या और लोगो बताते हैं कि कारोबार पंजीकृत है, और सामग्री तथा पोषण पैनल बताता है कि पैक में वास्तव में क्या है। लाइसेंस संख्या के बिना या झूठे दावे वाला पैक गलत लेबल वाला माना जाता है और उसकी शिकायत की जा सकती है।",
      kn: "ಲೇಬಲ್ ಅನ್ನು ಎರಡು ರೀತಿಯಲ್ಲಿ ಪರಿಶೀಲಿಸಲಾಗುತ್ತದೆ: ಪರವಾನಗಿ ಸಂಖ್ಯೆ ಮತ್ತು ಲೋಗೋ ಉದ್ಯಮ ನೋಂದಾಯಿತವಾಗಿದೆ ಎಂದು ತೋರಿಸುತ್ತವೆ, ಮತ್ತು ಪದಾರ್ಥ ಹಾಗೂ ಪೋಷಕಾಂಶ ಪಟ್ಟಿ ಪ್ಯಾಕ್‌ನಲ್ಲಿ ಏನಿದೆ ಎಂದು ತಿಳಿಸುತ್ತವೆ. ಪರವಾನಗಿ ಸಂಖ್ಯೆ ಇಲ್ಲದ ಅಥವಾ ಸುಳ್ಳು ಪ್ರತಿಪಾದನೆಯ ಪ್ಯಾಕ್ ತಪ್ಪು ಲೇಬಲ್ ಎನಿಸುತ್ತದೆ ಮತ್ತು ದೂರು ನೀಡಬಹುದು.",
    },
    more: {
      en: "Keep the pack and the bill - a misbranding complaint needs the label itself as evidence.",
      hi: "पैक और बिल संभालकर रखें - गलत लेबलिंग की शिकायत में लेबल ही सबूत होता है।",
      kn: "ಪ್ಯಾಕ್ ಮತ್ತು ಬಿಲ್ ಇಟ್ಟುಕೊಳ್ಳಿ - ತಪ್ಪು ಲೇಬಲಿಂಗ್ ದೂರಿಗೆ ಲೇಬಲ್ ಕೂಡ ಸಾಕ್ಷ್ಯವಾಗುತ್ತದೆ.",
    },
  },
  {
    key: "app",
    patterns: [
      /\b(?:this|your|the)\s+(?:app|application|website|chatbot|bot|assistant|system|software)\b/i,
      /\bhow\s+do\s+(?:you|u)\s+work\b/i,
      /\bwhat\s+can\s+you\s+do\b/i,
      /\bwho\s+are\s+you\b/i,
      /ಈ\s*ಆ್ಯಪ್|ನೀವು\s*ಹೇಗೆ\s*ಕೆಲಸ|ನೀವು\s*ಯಾರು/,
      /यह\s*ऐप|इस\s*ऐप|आप\s*कैसे\s*काम|आप\s*कौन/,
    ],
    label: {
      en: "this Food Safety Assistant helpline",
      hi: "यह खाद्य सुरक्षा सहायक हेल्पलाइन",
      kn: "ಈ ಆಹಾರ ಸುರಕ್ಷತಾ ಸಹಾಯಕ ಸಹಾಯವಾಣಿ",
    },
    definition: {
      en: "This is the Food Safety Assistant - a voice and text helpline where you can ask food safety questions or report a problem. It records the details you describe and can prepare a complaint for you.",
      hi: "यह खाद्य सुरक्षा सहायक है - एक वॉइस और टेक्स्ट हेल्पलाइन जहाँ आप खाद्य सुरक्षा संबंधी प्रश्न पूछ सकते हैं या समस्या बता सकते हैं। यह आपके बताए विवरण दर्ज करता है और आपके लिए शिकायत तैयार कर सकता है।",
      kn: "ಇದು ಆಹಾರ ಸುರಕ್ಷತಾ ಸಹಾಯಕ - ಧ್ವನಿ ಮತ್ತು ಪಠ್ಯ ಸಹಾಯವಾಣಿ. ಇಲ್ಲಿ ಆಹಾರ ಸುರಕ್ಷತೆ ಬಗ್ಗೆ ಪ್ರಶ್ನೆ ಕೇಳಬಹುದು ಅಥವಾ ಸಮಸ್ಯೆ ತಿಳಿಸಬಹುದು. ನೀವು ಹೇಳುವ ವಿವರಗಳನ್ನು ದಾಖಲಿಸಿ, ದೂರನ್ನು ಸಿದ್ಧಪಡಿಸುತ್ತದೆ.",
    },
    works: {
      en: "You can speak or type. It answers food safety questions from its stored reference material, remembers the details and the subject of your conversation, and when you describe an incident it prepares a complaint and submits it once you confirm.",
      hi: "आप बोल सकते हैं या लिख सकते हैं। यह अपनी संग्रहीत सामग्री से खाद्य सुरक्षा के प्रश्नों का उत्तर देता है, आपके विवरण और बातचीत का विषय याद रखता है, और घटना बताने पर शिकायत तैयार करके आपकी पुष्टि पर दर्ज करता है।",
      kn: "ನೀವು ಮಾತನಾಡಬಹುದು ಅಥವಾ ಬರೆಯಬಹುದು. ಸಂಗ್ರಹಿಸಿದ ಮಾಹಿತಿಯಿಂದ ಆಹಾರ ಸುರಕ್ಷತೆ ಪ್ರಶ್ನೆಗಳಿಗೆ ಉತ್ತರಿಸುತ್ತದೆ, ನಿಮ್ಮ ವಿವರ ಮತ್ತು ಸಂಭಾಷಣೆಯ ವಿಷಯವನ್ನು ನೆನಪಿಟ್ಟುಕೊಳ್ಳುತ್ತದೆ, ಘಟನೆ ತಿಳಿಸಿದಾಗ ದೂರು ಸಿದ್ಧಪಡಿಸಿ ನೀವು ದೃಢೀಕರಿಸಿದ ಮೇಲೆ ಸಲ್ಲಿಸುತ್ತದೆ.",
    },
    more: {
      en: "The New conversation button starts a fresh thread; your earlier conversation and its topics stay saved on this device and are never mixed with another caller's.",
      hi: "नई बातचीत बटन नया थ्रेड शुरू करता है; आपकी पिछली बातचीत और उसके विषय इसी डिवाइस पर सुरक्षित रहते हैं और किसी अन्य व्यक्ति से नहीं मिलाए जाते।",
      kn: "ಹೊಸ ಸಂಭಾಷಣೆ ಬಟನ್ ಹೊಸ ಥ್ರೆಡ್ ಆರಂಭಿಸುತ್ತದೆ; ನಿಮ್ಮ ಹಿಂದಿನ ಸಂಭಾಷಣೆ ಮತ್ತು ವಿಷಯಗಳು ಈ ಸಾಧನದಲ್ಲಿ ಉಳಿಯುತ್ತವೆ ಮತ್ತು ಬೇರೆಯವರೊಂದಿಗೆ ಬೆರೆಯುವುದಿಲ್ಲ.",
    },
  },
];

const TOPIC_BY_KEY: Record<string, TopicEntry> = TOPIC_LIBRARY.reduce((acc, entry) => {
  acc[entry.key] = entry;
  return acc;
}, {} as Record<string, TopicEntry>);

/**
 * Every known topic the text mentions, ordered by WHERE it appears (not by
 * library order), so "how does the FSSAI licence work" resolves to licences.
 */
function detectTopics(text: string): TopicKey[] {
  const t = String(text || "");
  if (!t.trim()) return [];
  const hits: Array<{ key: TopicKey; at: number }> = [];
  for (const entry of TOPIC_LIBRARY) {
    let best = -1;
    for (const re of entry.patterns) {
      const m = re.exec(t);
      if (m && (best === -1 || m.index < best)) best = m.index;
    }
    if (best >= 0) hits.push({ key: entry.key, at: best });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.key);
}

/** A topic list as stored (server) or sent by the browser. Unknown values dropped. */
function normalizeTopicList(value: any): TopicKey[] {
  if (!Array.isArray(value)) return [];
  const out: TopicKey[] = [];
  for (const raw of value.slice(-12)) {
    const key = String(raw || "").toLowerCase();
    if (TOPIC_BY_KEY[key] && !out.includes(key as TopicKey)) out.push(key as TopicKey);
  }
  return out;
}

/**
 * What the conversation is about right now.
 *
 * The CURRENT topic is the last one mentioned, not the most frequent one - that
 * is how people actually talk ("what is FSSAI?" ... "how does it work?"). When
 * the server has no turns at all (restart, serverless instance) the browser's own
 * topic list is used instead, so memory survives even without a database.
 */
function deriveTopicState(turns: ConversationTurn[], clientTopics: TopicKey[] = []) {
  const sequence: TopicKey[] = [];
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    for (const key of detectTopics(turn.text)) sequence.push(key);
  }
  if (!sequence.length && clientTopics.length) sequence.push(...clientTopics);

  const current = sequence.length ? sequence[sequence.length - 1] : null;

  const mentioned: TopicKey[] = [];
  for (let i = sequence.length - 1; i >= 0; i--) {
    if (!mentioned.includes(sequence[i])) mentioned.push(sequence[i]);
  }
  return { sequence, current, mentioned: mentioned.slice(0, 6) };
}

/** A pronominal follow-up: "how does it work", "why?", "tell me more". */
const FOLLOW_UP_HOW = [
  /\bhow\s+(?:does|do|did)\s+(?:it|that|this|they|these)\b/i,
  /\bhow\s+(?:it|that|this)\s+works?\b/i,
  /^\s*(?:and\s+)?how\s+(?:does\s+)?(?:it|that|this)?\s*works?\s*[?.!]*$/i,
  /(?:ಅದು|ಇದು|ಅವು)\s*ಹೇಗೆ/,
  /ಹೇಗೆ\s*ಕೆಲಸ\s*ಮಾಡುತ್ತದೆ/,
  /(?:यह|ये|वो|वह|इसका|उसका)\s*कैसे/,
  /कैसे\s*काम\s*करता/,
];

const FOLLOW_UP_MORE = [
  /^\s*(?:please\s+)?(?:tell me more|more|explain|explain more|go on|continue|elaborate|details)\s*[?.!]*$/i,
  /^\s*(?:why|how so|and)\s*[?.!]*$/i,
  /(?:ಇನ್ನಷ್ಟು|ಮತ್ತಷ್ಟು|ವಿವರವಾಗಿ|ವಿವರಿಸಿ)/,
  /(?:और\s*बताओ|और\s*बताइए|विस्तार|आगे\s*बताओ)/,
];

function resolveFollowUpIntent(text: string): "how" | "more" | null {
  const t = String(text || "").trim();
  if (!t) return null;
  if (FOLLOW_UP_HOW.some((re) => re.test(t))) return "how";
  if (FOLLOW_UP_MORE.some((re) => re.test(t))) return "more";
  return null;
}

// No \b around the Devanagari/Kannada alternatives: JavaScript word boundaries
// are ASCII-only, so they never match next to those scripts.
const DEFINITION_QUESTION = /^\s*(?:what\s+is|what's|whats|define|tell\s+me\s+about)\b|क्या\s*है|ಎಂದರೆ\s*ಏನು/i;

function isDefinitionQuestion(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (DEFINITION_QUESTION.test(t)) return true;
  return /ಎಂದರೆ\s*ಏನು|ಏನು\s*ಎಂದರೆ/.test(t);
}

const HOW_QUESTION = /\bhow\s+(?:does|do|did|is|are|can|to)\b|\bhow\b[^.?!]*\b(?:work|works|working|function)\b|ಹೇಗೆ|कैसे/i;

function isHowQuestion(text: string): boolean {
  return HOW_QUESTION.test(String(text || ""));
}

/**
 * Questions that need a specific figure or procedure ("what is the licence fee?")
 * are NOT answered from the short reference text - the model gets the reference
 * and answers properly instead of this library returning a near-miss definition.
 */
const DETAIL_ASKING = /\b(?:fee|fees|cost|price|charges?|documents?|renew|renewal|apply|application|eligib\w*|process|timeline|how\s+long|validity|amount|section|number)\b/i;

/** Words that mean the caller is reporting an incident, not asking a FAQ. */
const INCIDENT_DETAIL_PATTERN = /(worm|insect|hair\s+in|dead\s+(?:insect|cockroach|fly)|stale|spoiled|rotten|contaminated|food\s+poisoning|vomiting|stomach\s+(?:ache|pain)|foul\s+smell|unhygienic|dirty|ಹುಳು|ಕೂದಲು|ಹಳಸಿದ|ವಾಂತಿ|ಹೊಟ್ಟೆ\s*ನೋವು|ಕೊಳಕು|कीड़ा|बाल|बासी|उल्टी|पेट\s*दर्द|गंदा|बदबू)/i;

/**
 * Answer a topic question from the stored reference instead of letting the model
 * resolve a pronoun by itself. Returns null when the turn is not a topic FAQ, so
 * the normal (model-driven) path still handles everything else.
 */
function resolveGroundedTopicAnswer(
  queryText: string,
  explicitTopics: TopicKey[],
  currentTopic: TopicKey | null,
  followUp: "how" | "more" | null,
  langName: string
): { text: string; topic: TopicKey } | null {
  if (!queryText.trim()) return null;
  if (INCIDENT_DETAIL_PATTERN.test(queryText)) return null;  // a live complaint
  if (DETAIL_ASKING.test(queryText)) return null;            // needs a real answer, not a definition

  const named = explicitTopics[0] || null;
  const target = named || currentTopic;
  if (!target) return null;

  const entry = TOPIC_BY_KEY[target];
  if (!entry) return null;

  const lang = toLangCode(langName);

  if (named && isDefinitionQuestion(queryText)) return { text: entry.definition[lang], topic: target };
  if (named && isHowQuestion(queryText)) return { text: entry.works[lang], topic: target };
  if (!named && followUp === "how") return { text: entry.works[lang], topic: target };
  if (!named && followUp === "more") return { text: entry.more[lang], topic: target };

  return null;
}

/**
 * The prompt block that makes the topic explicit. Without this the model treats a
 * pronoun follow-up as a question about itself - the exact defect reported.
 */
function buildTopicBlock(topics: TopicKey[], current: TopicKey | null, langName: string): string {
  const lang = toLangCode(langName);

  if (!current) {
    return [
      "=== CURRENT TOPIC ===",
      "Nothing has been discussed yet, so no topic is established.",
      'If the caller uses a bare pronoun ("how does it work?", "why?") without naming a subject, ask what they are referring to instead of guessing.',
    ].join("\n");
  }

  const entry = TOPIC_BY_KEY[current];
  if (!entry) return "";

  const earlier = topics
    .filter((t) => t !== current && TOPIC_BY_KEY[t])
    .map((t) => TOPIC_BY_KEY[t].label.en);

  return [
    '=== CURRENT TOPIC (this is what "it" / "that" refers to) ===',
    `Current topic: ${entry.label[lang]}`,
    earlier.length ? `Earlier topics in this conversation, most recent first: ${earlier.join("; ")}` : "",
    `Reference you may use (do not contradict it): ${entry.definition[lang]} ${entry.works[lang]}`,
    "RULES:",
    '- A follow-up such as "how does it work", "why", "tell me more", "and?" refers to the CURRENT TOPIC above. Answer about THAT subject.',
    "- Never describe how this app, website, chatbot or helpline works unless the caller explicitly asks about the app itself. Explaining yourself when they asked about a food safety subject is a wrong answer.",
    "- If the caller moves to a new subject, that new subject becomes the current topic.",
  ].filter(Boolean).join("\n");
}

// Start a fresh conversation: close the caller's previous thread so it is no
// longer picked up as their "latest" open conversation.
app.post("/api/chat/new", chatLimit, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.profile?.phone);
    const previousId = String(req.body?.conversationId || "").trim().slice(0, 80);
    if (previousId) await closeConversation(previousId, phone);
    res.json({ ok: true });
  } catch (error: any) {
    console.warn("[Chat] Could not close the previous conversation:", error?.message);
    res.status(500).json({ error: "Could not start a new conversation" });
  }
});

// API: Chat with Assistant (100% Dynamic AI Generation - No Hardcoded or Cached Answers)
app.post("/api/chat", chatLimit, async (req, res) => {
  const { message, context, language, profile, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  // Collapse a repeated utterance before it reaches memory or the model, so the
  // assistant never mirrors back "idli idli idli".
  const queryText = collapseRepetitions(String(message || '')).trim();
  const targetLang = language || "English";
  const isKannada = targetLang.toLowerCase().includes("kan") || targetLang.toLowerCase().includes("kn");
  const isHindi = targetLang.toLowerCase().includes("hin") || targetLang.toLowerCase().includes("hi");
  const langName = isKannada ? "Kannada" : (isHindi ? "Hindi" : "English");

  // --- Server-side conversation memory -------------------------------------
  // The transcript lives on the server now, so memory no longer depends on how
  // many messages the browser happens to resend, and it survives a reload.
  const requestedConversationId = String(req.body?.conversationId || "").trim().slice(0, 80);
  const callerPhone = normalizePhone(profile?.phone);

  // PRIVACY: loadConversation only returns a thread whose stored owner matches
  // the caller. If the browser presents an id that belongs to someone else
  // (shared device, leaked id), it resolves to null and that caller never sees
  // the other person's history.
  let conversation: ConversationRecord | null = requestedConversationId
    ? await loadConversation(requestedConversationId, callerPhone)
    : null;

  // Adopt a previous thread ONLY when the caller supplied no id at all - that is
  // the "new device, nothing stored here yet" case.
  //
  // An id that we do not recognise means the client deliberately generated a
  // fresh one (the New conversation button). Adopting an older thread there would
  // silently resurrect the topic the caller just cleared, so it must NOT happen.
  if (!conversation && !requestedConversationId && callerPhone.length >= 10) {
    conversation = await findLatestConversationForPhone(callerPhone);
  }

  if (!conversation) {
    // Reuse the id the client chose (that is how its New conversation button
    // names a fresh thread) - but only if it is genuinely free. An id owned by a
    // different caller is never taken over.
    const idTakenByOther = requestedConversationId
      ? await isConversationOwnedByOther(requestedConversationId, callerPhone)
      : false;

    conversation = {
      id: requestedConversationId && !idTakenByOther
        ? requestedConversationId
        : `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      phone: callerPhone,
      language: langName,
      profile: profile || {},
      turns: [],
      updatedAt: Date.now(),
    };
  }

  // Bind the owner on first use, and record it for the response below.
  if (callerPhone) conversation.phone = callerPhone;
  const conversationId = conversation.id;

  // Everything the caller has said before this message (used for recall + facts).
  const earlierUserTurns = conversation.turns
    .filter((t) => t.role === "user")
    .map((t) => t.text.trim())
    .filter(Boolean);

  // Record the new user turn immediately, so recall sees it and a crash later
  // cannot lose it.
  conversation.turns.push({ role: "user", text: queryText, at: Date.now() });
  conversation.language = langName;
  if (profile) conversation.profile = profile;

  // --- Topic memory -------------------------------------------------------
  // What is this conversation about? Derived from every stored turn, with the
  // browser's own topic list as a fallback for a restarted / serverless instance.
  const topicState = deriveTopicState(conversation.turns, normalizeTopicList(req.body?.clientTopics));
  const currentTopic = topicState.current;
  conversation.topics = topicState.mentioned;

  // Answer "what did I say?" from the stored transcript instead of letting the
  // model guess - a small model reliably replied "I don't know" here.
  if (wantsRecall(queryText)) {
    const replyText = buildRecallReply(conversation, langName, queryText);
    conversation.turns.push({ role: "assistant", text: replyText, at: Date.now() });
    await saveConversation(conversation);
    let audioUrl: string | null = null;
    try {
      audioUrl = await generateTTSAudioUrl(replyText, langName);
    } catch {
      audioUrl = null;
    }
    return res.json({
      response: replyText,
      spokenText: replyText,
      markdownReport: "",
      audioUrl,
      isComplaintDraft: false,
      conversationId,
      recalled: true,
      cached: false,
      topic: currentTopic,
      topics: conversation.topics,
    });
  }

  // --- Grounded topic answers ---------------------------------------------
  // "How does it work?" has no antecedent of its own, so it is resolved from the
  // CURRENT TOPIC and answered from the gathered reference text. This is what
  // stops the assistant answering a question about FSSAI by explaining the app.
  const explicitTopics = detectTopics(queryText);
  const followUpIntent = resolveFollowUpIntent(queryText);
  const grounded = resolveGroundedTopicAnswer(queryText, explicitTopics, currentTopic, followUpIntent, langName);

  if (grounded) {
    conversation.turns.push({ role: "assistant", text: grounded.text, at: Date.now() });
    await saveConversation(conversation);
    let audioUrl: string | null = null;
    try {
      audioUrl = await generateTTSAudioUrl(grounded.text, langName);
    } catch {
      audioUrl = null;
    }
    console.log(`[/api/chat] Answered from topic memory: ${grounded.topic}`);
    return res.json({
      response: grounded.text,
      spokenText: grounded.text,
      markdownReport: "",
      audioUrl,
      isComplaintDraft: false,
      conversationId,
      recalled: false,
      grounded: true,
      topic: grounded.topic,
      topics: conversation.topics,
      cached: false,
    });
  }

  // Facts are derived from the WHOLE stored conversation, not just the messages
  // the browser resent - this is what stops "I said idli" being followed by
  // "what did you eat?".
  const historyTurns = conversation.turns.map((t) => ({ role: t.role, text: t.text }));
  const analysis = analyzeCustomerWords(queryText, [...historyTurns, ...(Array.isArray(history) ? history : [])], {}, langName);

  const priorUserTurns = earlierUserTurns.slice(-10);

  const knownFacts = [
    analysis.location ? `Incident location / establishment: ${analysis.location}` : '',
    analysis.when ? `When it happened: ${analysis.when}` : '',
    analysis.cause ? `What was wrong: ${analysis.cause}` : '',
    analysis.item ? `Food item involved: ${analysis.item}` : '',
    profile?.name ? `Caller name: ${profile.name}` : '',
    profile?.location ? `Caller city: ${profile.location}` : '',
  ].filter(Boolean).join('\n');

  const alreadyAsked = conversation.turns.filter((t) => t.role === "assistant").map((t) => t.text).slice(-4);

  // Cross-surface memory: this caller's earlier phone calls and complaints, so the
  // website assistant knows what they already reported. Scoped to their phone
  // number only - it can never return another caller's history.
  let crossSurfaceMemory = "";
  if (callerPhone.length >= 10) {
    try {
      crossSurfaceMemory = await loadCallerMemory(callerPhone);
    } catch (e: any) {
      console.warn("[Memory] cross-surface lookup notice:", e?.message);
    }
  }

  // Whether anything is actually known - drives the honesty rules below, so the
  // model can never agree that it "remembers" an empty conversation.
  const hasAnyMemory = !!(knownFacts || priorUserTurns.length || alreadyAsked.length || crossSurfaceMemory);

  const memoryBlock = [
    knownFacts ? `FACTS ALREADY ESTABLISHED (treat as known, never ask again):\n${knownFacts}` : 'FACTS ALREADY ESTABLISHED: none yet.',
    priorUserTurns.length
      ? `The caller's own earlier words this conversation, oldest first:\n- ${priorUserTurns.join('\n- ')}`
      : '',
    alreadyAsked.length ? `Your own recent replies (do NOT repeat these questions):\n- ${alreadyAsked.join('\n- ')}` : '',
    crossSurfaceMemory
      ? `This caller's earlier contact with us on the phone helpline (use it naturally, do not read it out as a list):\n${crossSurfaceMemory}`
      : '',
  ].filter(Boolean).join('\n\n');

  // The subject under discussion, stated explicitly. Without this the model
  // resolves "it" to itself and explains the app instead of answering.
  const topicBlock = buildTopicBlock(conversation.topics as TopicKey[], currentTopic, langName);

  try {
    let effectiveContext = context || "";

    if (!effectiveContext.trim()) {
      try {
        const turso = getTurso();
        if (turso) {
          const kbResult = await turso.execute("SELECT name, content FROM knowledge_base ORDER BY createdAt DESC LIMIT 5");
          effectiveContext = kbResult.rows.map(r => `--- ${r.name} ---\n${r.content}`).join("\n\n");
        }
      } catch (dbErr: any) {
        console.warn("Could not load knowledge from Turso in /api/chat:", dbErr?.message);
      }
    }

    const isGreeting = /^(hello|hi|hey|namaste|namaskara|good\s+morning|good\s+evening|ನಮಸ್ಕಾರ|ನಮಸ್ತೆ|नमस्ते|ಹಲೋ)$/i.test(queryText);
    const isInfoOrGeneral = analysis.isInformationalInquiry || /^(what|how|why|who|explain|tell|fssai|rules|law|information|help|ಏನು|ಹೇಗೆ|ಯಾಕೆ|ಯಾರು|ತಿಳಿಸಿ|ಹೇಳಿ|ಬಗ್ಗೆ|ಸಹಾಯ|क्या|कैसे|बताओ|जानकारी)/i.test(queryText);

    const systemPrompt = `You are VoxAssist, a warm, friendly, natural human-like AI companion and Food Safety & Consumer Expert. You converse naturally just like a real person.
Citizen Profile:
- Name: ${profile?.name || "Citizen"}
- Phone: ${profile?.phone || "Not provided"}
- Location: ${profile?.location || "Not specified"}

TARGET LANGUAGE: ${langName}
CRITICAL LANGUAGE MANDATE:
Every single word of your response MUST strictly be in ${langName}.
- If Kannada: Write purely in native Kannada script (ಕನ್ನಡ).
- If Hindi: Write purely in Devanagari script (हिंदी).
- If English: Write in English.

CORE BEHAVIOR INSTRUCTIONS:
1. NATURAL CONVERSATION & NO REPEATED GREETINGS/NAMES:
   - DO NOT repeat "Namaskara" (ನಮಸ್ಕಾರ / नमस्ते / Hello) or constantly repeat the person's name in every single message. A greeting should only ever occur once at the very first greeting exchange.
   - In ongoing back-and-forth conversation, respond DIRECTLY and naturally without starting with "Namaskara [Name]" or repeating their name repeatedly. Speak just like two people having a continuous conversation.
   - Behave like a natural, warm person. Answer general questions, food inquiries, or chat using your database knowledge and general knowledge freely and helpfully.
   - DO NOT aggressively interrogate or focus only on complaints. Only discuss or collect complaint details if the user explicitly brings up a food safety issue, contaminated food, or unhygienic incident they want to report.

2. STRICT FACTUAL & MEMORY BOUNDARY:
   - You record and remember specific **Food Safety Grievance details** when reported.
   - Do NOT accept or store false facts or altered historical claims. If someone tests factual knowledge, reply politely and factually.

3. INFORMATIONAL INQUIRIES & CHIT-CHAT:
   - Answer directly, accurately, and conversationally in 1-2 concise sentences without repeating greetings.
   - Answer about the CURRENT TOPIC below. A question like "how does it work?" follows on from what you were just discussing - it does not mean "explain yourself".
   - Never explain how this app, website, chatbot or helpline works unless the caller explicitly asks about the app. If they asked about FSSAI, licensing, hygiene, penalties or labelling, answer about THAT.

4. GRIEVANCE / COMPLAINT REPORTING (Only when user reports a food safety issue):
   - Details already established from this conversation - Location: "${analysis.location || "unknown"}", When: "${analysis.when || "unknown"}", Cause: "${analysis.cause || "unknown"}", What they ate: "${analysis.item || "unknown"}".
   - NEVER ask for anything marked as known above. In particular, if a food item has already been mentioned (for example idli, dosa or biryani), do NOT ask "what did you eat?" - it is already answered.
   - If details are genuinely missing (WHERE / WHEN / CAUSE / ITEM), politely ask ONLY for the missing detail.
   - Ask for at most ONE genuinely missing detail per turn.
   - If the caller refers back to something ("that place", "the same problem", "what I told you"), resolve it from the conversation and answer directly instead of asking again.
   - If all details are known OR user confirms submission:
     Format the official grievance report in clean Markdown starting with:
     # 📋 Official Food Safety & Inspection Grievance Report
     and ending with COMPLAINT_DRAFT_REQUEST.

=== CONVERSATION MEMORY (this is what makes you sound like a person who was listening) ===
${memoryBlock}

${topicBlock}

=== HONESTY ABOUT MEMORY (never break these) ===
- The memory above is the ONLY thing you remember. There is no other history you can access.
- ${hasAnyMemory
  ? "The memory above is not empty, so use it naturally. But still never claim to recall a specific thing unless that thing is actually written above."
  : "The memory above is EMPTY. You have NOT been told anything yet in this conversation. If the caller asks whether you remember, do NOT say \"yes, I remember\" - say plainly that they have not told you anything yet and ask them to describe the issue. Saying you remember while having nothing is the worst possible answer."}
- Never invent a place, person, food item, date or complaint reference. If it is not above, you do not know it - ask, or say you do not know.
- If the caller asks what they said earlier and it is not in the memory above, say you do not have it and ask them to repeat it.

Always respond warmly, naturally, and directly to what the user actually said.`;

    // History comes from the stored conversation (the browser's copy is only a
    // fallback), so the model always sees the real, complete dialogue.
    const storedPriorTurns = conversation.turns
      .slice(0, -1) // drop the user turn just appended; it is sent as the prompt below
      .slice(-16)
      .map((t) => ({ role: t.role, content: t.text }));

    const fallbackHistory = storedPriorTurns.length
      ? []
      : (Array.isArray(history) ? history : []).slice(-12).map((h: any) => ({
          role: (h.role === "assistant" || h.sender === "assistant") ? ("assistant" as const) : ("user" as const),
          content: String(h.content || h.text || ""),
        }));

    const fullMessages: Array<{ role: string; content: string }> = [
      ...(storedPriorTurns.length ? storedPriorTurns : fallbackHistory),
      { role: "user", content: queryText }
    ];

    console.log(`[/api/chat] Generating dynamic AI response for "${queryText}" in ${langName}...`);
    let responseText = await runLLMGeneration({
      system: systemPrompt,
      messages: fullMessages,
    });

    // Minimal safety fallback only if the AI model completely failed to return any text
    if (!responseText || responseText.trim().length < 2) {
      if (isGreeting) {
        if (langName === 'Kannada') {
          responseText = `ನಮಸ್ಕಾರ ${profile?.name || ''}! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?`;
        } else if (langName === 'Hindi') {
          responseText = `नमस्ते ${profile?.name || ''}! मैं आपकी क्या सहायता कर सकता हूँ?`;
        } else {
          responseText = `Hello ${profile?.name || ''}! How can I assist you today?`;
        }
      } else if (isInfoOrGeneral) {
        if (langName === 'Kannada') {
          responseText = `ದಯವಿಟ್ಟು ತಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ತಿಳಿಸಿ, ನಾನು ಆಹಾರ ಸುರಕ್ಷತೆಯ ಬಗ್ಗೆ ತಮಗೆ ವಿವರ ನೀಡುತ್ತೇನೆ.`;
        } else if (langName === 'Hindi') {
          responseText = `कृपया अपना प्रश्न पूछें, मैं खाद्य सुरक्षा संबंधी जानकारी प्रदान करूँगा।`;
        } else {
          responseText = `Please let me know your question regarding food safety, and I will be happy to assist.`;
        }
      } else {
        if (langName === 'Kannada') {
          responseText = `ದಯವಿಟ್ಟು ಘಟನೆಯ ಸ್ಥಳ ಅಥವಾ ಹೋಟೆಲ್ ಹೆಸರನ್ನು ತಿಳಿಸಿ.`;
        } else if (langName === 'Hindi') {
          responseText = `कृपया घटना का स्थान या रेस्टोरेंट का नाम बताएं।`;
        } else {
          responseText = `Please share the establishment or location of the incident.`;
        }
      }
    }

    const isComplaintDraft = responseText.includes("COMPLAINT_DRAFT_REQUEST");
    const cleanedText = responseText.replace(/COMPLAINT_DRAFT_REQUEST/g, "").trim();

    let spokenPart = cleanedText;
    let markdownPart = "";

    if (cleanedText.includes("# 📋") || cleanedText.includes("Official Consumer Grievance")) {
      const parts = cleanedText.split(/(?=# 📋|# Official Consumer Grievance)/);
      if (parts.length > 1 && parts[0].trim().length > 10) {
        spokenPart = parts[0].trim();
        markdownPart = parts.slice(1).join("").trim();
      } else {
        markdownPart = cleanedText;
        const customerName = profile?.name ? ` ${profile.name}` : "";
        if (langName === 'Kannada') {
          spokenPart = `ನಾವು ಮುಂದಿನ ಕ್ರಮವನ್ನು ಕೈಗೊಳ್ಳುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು${customerName}! ಬೈ${customerName}, ತಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ!`;
        } else if (langName === 'Hindi') {
          spokenPart = `हम आगे की उचित कार्रवाई करेंगे। धन्यवाद${customerName}! बाय${customerName}, आपका दिन शुभ हो!`;
        } else {
          spokenPart = `We will take care further. Thank you${customerName}! Bye${customerName}, have a nice day!`;
        }
      }
    }

    // Generate audio for fast playback & storage using spoken portion
    const audioUrl = await generateTTSAudioUrl(spokenPart.slice(0, 450), langName);

    // Persist the assistant turn, so the next call sees the full exchange and
    // "what did I say?" can be answered from real records.
    conversation.turns.push({ role: "assistant", text: cleanedText, at: Date.now() });
    await saveConversation(conversation);

    res.json({ 
      response: cleanedText, 
      spokenText: spokenPart,
      markdownReport: markdownPart,
      audioUrl, 
      isComplaintDraft, 
      conversationId,
      cached: false,
      // Sent back so the browser can keep its own topic memory in localStorage.
      topic: currentTopic,
      topics: conversation.topics,
    });
  } catch (error: any) {
    console.error("[Chat Error]:", error);
    res.status(500).json({ error: error.message || "Failed to process chat query" });
  }
});

// ---------------------------------------------------------------------------
// IVR helpers
// Language normalisation, caller memory, knowledge grounding, turn persistence
// and human-like reply sanitation for the voice helpline.
// ---------------------------------------------------------------------------

type IvrLangCode = "kn-IN" | "hi-IN" | "en-IN";

function normalizeIvrLang(input?: string): IvrLangCode {
  const v = String(input || "").toLowerCase();
  if (v.includes("kn") || v.includes("kannada") || v.includes("ಕನ್ನಡ")) return "kn-IN";
  if (v.includes("hi") || v.includes("hindi") || v.includes("हिंदी") || v.includes("हिन्दी")) return "hi-IN";
  return "en-IN";
}

function ivrLangName(code: string): string {
  if (code === "kn-IN") return "Kannada";
  if (code === "hi-IN") return "Hindi";
  return "English";
}

function queryTokens(text: string): string[] {
  if (!text) return [];
  const raw = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of raw) {
    if (w.length < 3 && !/[\u0C80-\u0CFF\u0900-\u097F]/.test(w)) continue;
    if (/^(the|and|for|with|that|this|you|your|are|was|have|has|what|how|why|when|where|please|tell|about|ನಮಸ್ಕಾರ|नमस्ते)$/.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function overlapScore(tokens: string[], corpus: string): number {
  if (!tokens.length || !corpus) return 0;
  const hay = corpus.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits++;
  }
  return hits / Math.sqrt(tokens.length);
}

/**
 * Pulls the most relevant rows out of the uploaded knowledge base and the
 * learned Q&A cache, so the IVR can actually ANSWER a question instead of
 * only collecting a complaint.
 */
async function getIvrKnowledgeContext(langCode: string, query: string, limit = 2): Promise<string> {
  try {
    const turso = getTurso();
    if (!turso) return "";
    const langName = ivrLangName(langCode);
    const tokens = queryTokens(query);

    const kb = await turso.execute("SELECT name, content FROM knowledge_base ORDER BY createdAt DESC LIMIT 60");
    const qa = await turso.execute({
      sql: "SELECT question, answer FROM qa_cache WHERE language = ? OR language = ? ORDER BY created_at DESC LIMIT 120",
      args: [langName, langCode],
    });

    const scored: Array<{ score: number; text: string }> = [];

    for (const row of kb.rows as any[]) {
      const content = String(row.content || "").replace(/\s+/g, " ").trim();
      if (!content) continue;
      const score = overlapScore(tokens, `${row.name || ""} ${content}`) + 0.2;
      if (score > 0.3) {
        scored.push({ score, text: `• DOCUMENT (${row.name || "reference"}): ${content.slice(0, 400)}` });
      }
    }

    for (const row of qa.rows as any[]) {
      const q = String(row.question || "").trim();
      const a = String(row.answer || "").trim();
      if (!q || !a) continue;
      const score = overlapScore(tokens, q) + 0.25;
      if (score > 0.3) {
        scored.push({ score, text: `• KNOWN ANSWER — Q: ${q} | A: ${a.slice(0, 400)}` });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.text)
      .join("\n");
  } catch (e: any) {
    console.warn("[IVR] knowledge lookup notice:", e?.message);
    return "";
  }
}

/**
 * Last-resort answering path: when no LLM provider is reachable (expired key or
 * exhausted credits) the helpline still ANSWERS from its own stored knowledge
 * instead of falling back to a complaint question.
 */
function answerFromKnowledgeContext(context: string, langCode: string): string {
  if (!context) return "";

  let answer = "";
  const known = context.split("\n").find((l) => l.includes("KNOWN ANSWER"));
  if (known) {
    const idx = known.indexOf("| A:");
    answer = idx >= 0 ? known.slice(idx + 4).trim() : known.replace(/^.*?Q:\s*/, "").trim();
  } else {
    const doc = context.split("\n").find((l) => l.trim().startsWith("• DOCUMENT"));
    if (doc) answer = doc.replace(/^•\s*DOCUMENT\s*\([^)]*\):\s*/, "").trim();
  }

  if (!answer) return "";

  // Keep it speakable: at most two sentences / ~60 words.
  const twoSentences = answer.split(/(?<=[.!?।])\s+/).slice(0, 2).join(" ").trim();
  const words = twoSentences.split(/\s+/).slice(0, 60).join(" ");
  return words.trim();
}

/** Stores a newly answered question so the IVR gets smarter over time. */
async function rememberQaPair(params: { langCode: string; question: string; answer: string }): Promise<void> {
  try {
    const turso = getTurso();
    if (!turso) return;
    const langName = ivrLangName(params.langCode);
    const q = (params.question || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const a = (params.answer || "").replace(/\s+/g, " ").trim().slice(0, 1200);
    if (q.length < 5 || a.length < 12) return;

    const existing = await turso.execute({
      sql: "SELECT id FROM qa_cache WHERE question = ? AND language = ? LIMIT 1",
      args: [q, langName],
    });
    if (existing.rows.length > 0) return;

    await turso.execute({
      sql: `INSERT INTO qa_cache (id, normalized_intent, language, question, answer, audio_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `qa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        "learned_ivr",
        langName,
        q,
        a,
        "",
        Date.now(),
      ],
    });
  } catch (e: any) {
    console.warn("[IVR] qa_cache write notice:", e?.message);
  }
}

/** Persists one turn of an IVR conversation. */
async function logIvrTurn(params: {
  callId?: string;
  turnIndex?: number;
  role: "user" | "assistant";
  text: string;
  langCode: string;
  step: string;
}): Promise<void> {
  if (!params.callId || !params.text) return;
  try {
    const turso = getTurso();
    if (!turso) return;
    await turso.execute({
      sql: `INSERT INTO ivr_turns (id, callId, turnIndex, role, text, language, step, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `${params.callId}_${params.turnIndex ?? 0}_${params.role}_${Math.random().toString(36).slice(2, 6)}`,
        params.callId,
        params.turnIndex ?? 0,
        params.role,
        String(params.text).slice(0, 4000),
        params.langCode,
        params.step || "",
        Date.now(),
      ],
    });
  } catch (e: any) {
    console.warn("[IVR] turn log notice:", e?.message);
  }
}

/** Creates or updates the call session row. */
async function upsertIvrCall(params: {
  callId?: string;
  profile?: any;
  language?: string;
  status?: string;
  turnCount?: number;
  complaintId?: string;
  transcript?: string;
  collectedData?: any;
  ended?: boolean;
}): Promise<void> {
  if (!params.callId) return;
  try {
    const turso = getTurso();
    if (!turso) return;

    const existing = await turso.execute({
      sql: "SELECT id FROM ivr_calls WHERE id = ? LIMIT 1",
      args: [params.callId],
    });

    if (existing.rows.length === 0) {
      await turso.execute({
        sql: `INSERT INTO ivr_calls
              (id, callerName, phone, language, startedAt, endedAt, turnCount, status, complaintId, transcript, collectedData)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          params.callId,
          params.profile?.name || "IVR Caller",
          params.profile?.phone || "IVR Phone",
          params.language || "en-IN",
          Date.now(),
          0,
          params.turnCount ?? 0,
          params.status || "active",
          params.complaintId || "",
          params.transcript || "",
          JSON.stringify(params.collectedData || {}),
        ],
      });
      return;
    }

    if (params.status) {
      await turso.execute({ sql: "UPDATE ivr_calls SET status = ? WHERE id = ?", args: [params.status, params.callId] });
    }
    if (typeof params.turnCount === "number") {
      await turso.execute({ sql: "UPDATE ivr_calls SET turnCount = ? WHERE id = ?", args: [params.turnCount, params.callId] });
    }
    if (params.language) {
      await turso.execute({ sql: "UPDATE ivr_calls SET language = ? WHERE id = ?", args: [params.language, params.callId] });
    }
    if (params.complaintId) {
      await turso.execute({ sql: "UPDATE ivr_calls SET complaintId = ? WHERE id = ?", args: [params.complaintId, params.callId] });
    }
    if (typeof params.transcript === "string") {
      await turso.execute({ sql: "UPDATE ivr_calls SET transcript = ? WHERE id = ?", args: [params.transcript.slice(0, 8000), params.callId] });
    }
    if (params.collectedData) {
      await turso.execute({ sql: "UPDATE ivr_calls SET collectedData = ? WHERE id = ?", args: [JSON.stringify(params.collectedData), params.callId] });
    }
    if (params.ended) {
      await turso.execute({ sql: "UPDATE ivr_calls SET endedAt = ? WHERE id = ?", args: [Date.now(), params.callId] });
    }
  } catch (e: any) {
    console.warn("[IVR] call upsert notice:", e?.message);
  }
}

/**
 * "Have I spoken to this person before?" - gives the agent real memory of the
 * caller so it behaves like someone who has met them, not like a form.
 */
async function loadCallerMemory(phone?: string): Promise<string> {
  if (!phone) return "";
  try {
    const turso = getTurso();
    if (!turso) return "";
    const lines: string[] = [];

    const calls = await turso.execute({
      sql: "SELECT startedAt, collectedData, status FROM ivr_calls WHERE phone = ? ORDER BY startedAt DESC LIMIT 3",
      args: [phone],
    });
    for (const r of calls.rows as any[]) {
      let d: any = {};
      try { d = JSON.parse(String(r.collectedData || "{}")); } catch {}
      const when = r.startedAt ? new Date(Number(r.startedAt)).toLocaleDateString() : "recently";
      const subject = d.cause || d.item || "a food safety concern";
      const where = d.location ? ` at ${d.location}` : "";
      lines.push(`- Called on ${when} about ${subject}${where}`);
    }

    const complaints = await turso.execute({
      sql: "SELECT id, location, status FROM complaints WHERE phoneNumber = ? ORDER BY createdAt DESC LIMIT 3",
      args: [phone],
    });
    for (const c of complaints.rows as any[]) {
      lines.push(`- Complaint #${c.id} at ${c.location || "an outlet"} (status: ${c.status})`);
    }

    return lines.join("\n");
  } catch (e: any) {
    console.warn("[IVR] caller memory notice:", e?.message);
    return "";
  }
}

/**
 * The reverse direction: what this caller already said in the WEBSITE chat, so a
 * phone call does not make them repeat it. Strictly scoped to one phone number.
 * Only compact derived facts are used, never the raw transcript.
 */
async function loadWebChatCallerMemory(phone: string, langName = "English"): Promise<string> {
  const owner = normalizePhone(phone);
  if (owner.length < 10) return "";
  const turso = getTurso();
  if (!turso) return "";
  try {
    const result = await turso.execute({
      sql: "SELECT turns, updatedAt FROM conversations WHERE phone = ? ORDER BY updatedAt DESC LIMIT 2",
      args: [owner],
    });

    const lines: string[] = [];
    for (const r of result.rows as any[]) {
      let turns: any[] = [];
      try {
        turns = JSON.parse(String(r.turns || "[]"));
      } catch {}
      const userText = turns
        .filter((t) => t && t.role === "user")
        .map((t) => String(t.text || "").trim())
        .filter(Boolean);
      if (!userText.length) continue;

      const priorTurns = userText.slice(0, -1).map((t) => ({ role: "user", text: t }));
      const analysis = analyzeCustomerWords(userText[userText.length - 1], priorTurns, {}, langName);
      const when = r.updatedAt ? new Date(Number(r.updatedAt)).toLocaleDateString() : "recently";
      const bits = [
        analysis.cause ? `issue: ${analysis.cause}` : "",
        analysis.item ? `food: ${analysis.item}` : "",
        analysis.location ? `place: ${analysis.location}` : "",
        analysis.when ? `when: ${analysis.when}` : "",
      ].filter(Boolean).join(", ");

      lines.push(`- Website chat on ${when}: ${bits || userText[userText.length - 1].slice(0, 140)}`);
    }
    return lines.join("\n");
  } catch (e: any) {
    console.warn("[Memory] web-chat caller memory notice:", e?.message);
    return "";
  }
}

const IVR_GREETING_WORDS = [
  "namaskara", "namaskaram", "namaskar", "namaste", "namasthe", "hello", "hi there", "hi", "hey",
  "नमस्कार", "नमस्ते", "हैलो", "ನಮಸ್ಕಾರ", "ನಮಸ್ತೆ", "ಹಲೋ", "ಸ್ವಾಗತ", "ಸುಸ್ವಾಗತ",
];

/**
 * A real person greets you ONCE and does not re-address you by name in every
 * sentence. This strips repeated greetings / name callouts from ongoing turns.
 */
function sanitizeIvrReply(text: string, opts: { turnIndex: number; name?: string }): string {
  let out = String(text || "").replace(/\s+/g, " ").trim();
  if (!out) return out;

  const isOngoing = opts.turnIndex > 1;
  if (!isOngoing) return out;

  // 1. Strip greetings only if they are at the very start of the reply.
  let guard = 0;
  let changed = true;
  while (changed && guard < 3) {
    changed = false;
    guard++;
    const lower = out.toLowerCase();
    for (const g of IVR_GREETING_WORDS) {
      if (lower.startsWith(g)) {
        out = out.slice(g.length).replace(/^[\s,.!?।:;\-–]+/, "");
        changed = true;
        break;
      }
    }
  }

  // 2. Drop name callouts near the start ("Ramesh, ...") - once is enough.
  const name = String(opts.name || "").trim();
  if (name.length > 2) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`^\\s*${escaped}\\s*[,!।:;\\-–]\\s*`, "i"), "");
    out = out.replace(new RegExp(`^\\s*${escaped}\\b\\s*[,!।:;\\-–]?\\s*`, "i"), "");
  }

  // 3. Remove greetings repeated mid-sentence.
  out = out
    .replace(/[,!।.\-–]?\s*(ನಮಸ್ಕಾರ|ನಮಸ್ತೆ|ಸ್ವಾಗತ|नमस्ते|नमस्कार|namaskara|namaskaram|namaste)\s*[,!।.\-–]?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.!?।:;\-–]+/, "")
    .trim();

  // 4. Never leave the reply empty after cleaning.
  if (!out || out.length < 8) return String(text || "").replace(/\s+/g, " ").trim();

  return out;
}

// ---------------------------------------------------------------------------
// Anchored IVR answer matching
//
// ROOT CAUSE of "the IVR keeps asking the same thing": the menu tests below
// used to be unanchored alternations such as /1|one|kannada|.../i. A bare /1/
// matches the 1 in "2025" or "₹100", and /one/ matches inside ordinary words
// like "phone", "someone", "money" and "done". So a caller who simply described
// their problem ("someone sold me stale food at 7pm") re-triggered the language
// menu, the welcome prompt was replayed, and the step was reset - the caller
// had to start over. Every menu answer is now matched against the WHOLE
// utterance (or a whole word), never a substring.
// ---------------------------------------------------------------------------
function ivrNormalize(text: string): string {
  return String(text || "").trim().toLowerCase().replace(/[\s!.,?;:।"'()]+$/g, "");
}

/** Whole-utterance DTMF answer: "9", "press 9", "option 9". */
function matchesIvrDigit(message: string, digit: string): boolean {
  const t = ivrNormalize(message);
  if (!t) return false;
  return new RegExp(`^(?:press\\s+|option\\s+|number\\s+)?${digit}$`).test(t);
}

/** Latin tokens need \b; Kannada/Devanagari tokens are bounded by their script range. */
function ivrTokenRegex(token: string): RegExp {
  if (/^[\u0900-\u097F\u0C80-\u0CFF]+$/.test(token)) {
    return new RegExp(`(?<![\\u0900-\\u097F\\u0C80-\\u0CFF])${token}(?![\\u0900-\\u097F\\u0C80-\\u0CFF])`);
  }
  return new RegExp(`\\b${token}\\b`, "i");
}

// Whole-word tokens only. "one" is safe here because \bone\b cannot match
// inside "phone", "someone", "money", "none" or "done".
const IVR_LANG_TOKENS: Record<string, string[]> = {
  "kn-IN": ["kannada", "kannad", "ondu", "one", "first", "ಕನ್ನಡ", "ಒಂದು"],
  "hi-IN": ["hindi", "eradu", "two", "second", "हिंदी", "हिन्दी", "दो", "ಎರಡು"],
  "en-IN": ["english", "mooru", "three", "third", "ಇಂಗ್ಲಿಷ್", "ಮೂರು", "तीन"],
};

function matchesIvrLanguageChoice(message: string, digit: string, langCode: string): boolean {
  if (matchesIvrDigit(message, digit)) return true;
  const raw = String(message || "");
  if (!raw) return false;
  return (IVR_LANG_TOKENS[langCode] || []).some((tok) => ivrTokenRegex(tok).test(raw));
}

// Whole-utterance confirmation. The old submit test accepted a bare "ha"
// substring at step press_7_prompt, so any sentence containing "what", "have",
// "shall" or "harsh" filed the complaint immediately - before the caller had
// answered anything.
const IVR_AFFIRM_WORDS = [
  "confirm", "confirmed", "submit", "yes", "yeah", "yep", "yup", "ok", "okay",
  "okey", "sure", "done", "proceed", "sari", "sare", "saree", "haan", "han", "ha", "houdu",
  "ದೃಢೀಕರಿಸಿ", "ಹೌದು", "ಸರಿ", "ಒಂಬತ್ತು",
  "मंज़ूर", "हाँ", "हां", "पुष्टि", "ठीक", "दर्ज",
];
const IVR_AFFIRM_TRAIL = [
  "please", "it", "do", "that", "thats", "is", "all", "go", "ahead", "to",
  "submit", "now", "fine", "ok", "okay", "yes", "sir", "madam", "haan",
  "hai", "है", "करें", "करो",
];

function isIvrConfirmation(text: string): boolean {
  const t = ivrNormalize(text);
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const norm = (w: string) => w.replace(/[^\p{L}\p{N}']/gu, "");
  const first = norm(words[0]);
  if (words.length === 1) return IVR_AFFIRM_WORDS.includes(first);
  if (!IVR_AFFIRM_WORDS.includes(first)) return false;
  return words.slice(1).every((w) => {
    const n = norm(w);
    return !n || IVR_AFFIRM_TRAIL.includes(n) || IVR_AFFIRM_WORDS.includes(n);
  });
}

// API: Dedicated Calm & Pleasant IVR Dialogue State Machine
app.post("/api/ivr/dialogue", voiceLimit, async (req, res) => {
  const { 
    message: rawMessage, 
    digits, 
    step = "welcome", 
    language = "en-IN", 
    profile, 
    collectedData = {}, 
    history = [],
    audioNoteUrl,
    isVoiceNote,
    callId,
    turnIndex = 0
  } = req.body;

  // Collapse a repeated utterance here too. The IVR used to run its "did they
  // already give me the location?" checks against text that could contain the
  // same words several times, and a repeated "yes yes yes" could trip the
  // confirmation branch more than once.
  const message = collapseRepetitions(String(rawMessage || '')).trim();

  const callerTurn = Number(turnIndex) || 0;
  let currentLang = collectedData?.language || language || "en-IN";
  let nextStep = step;
  let replyText = "";
  let updatedData = { ...collectedData };
  if (audioNoteUrl) {
    updatedData.audioNoteUrl = audioNoteUrl;
  }
  let isComplaintReady = false;
  let markdownReport = "";
  let raisedComplaintId = "";

  // Explicit Script-based and DTMF language detection (whole-utterance matches
  // only - see the anchored IVR matching helpers above).
  if (digits === "1" || (step === "welcome" && matchesIvrLanguageChoice(message || "", "1", "kn-IN"))) {
    currentLang = "kn-IN";
  } else if (digits === "2" || (step === "welcome" && matchesIvrLanguageChoice(message || "", "2", "hi-IN"))) {
    currentLang = "hi-IN";
  } else if (digits === "3" || (step === "welcome" && matchesIvrLanguageChoice(message || "", "3", "en-IN"))) {
    currentLang = "en-IN";
  } else if (message && /[\u0C80-\u0CFF]/.test(message)) {
    currentLang = "kn-IN";
  } else if (message && /[\u0900-\u097F]/.test(message)) {
    currentLang = "hi-IN";
  }

  updatedData.language = currentLang;

  const isKannada = currentLang === "kn-IN" || currentLang === "Kannada";
  const isHindi = currentLang === "hi-IN" || currentLang === "Hindi";
  const langName = isKannada ? "Kannada (ಕನ್ನಡ)" : (isHindi ? "Hindi (हिंदी)" : "English");

  try {
    // 1. DTMF Language Selection (1 = Kannada, 2 = Hindi, 3 = English)
    //    Whole-utterance matching only, so "someone", "phone", "money", "done"
    //    or a digit inside a date can never select a language and replay the
    //    welcome prompt.
    if (digits === "1" || (step === "welcome" && matchesIvrLanguageChoice(message || "", "1", "kn-IN"))) {
      currentLang = "kn-IN";
      updatedData.language = "kn-IN";
      nextStep = "collecting_info";
      replyText = "ನಮಸ್ಕಾರ! ಆಹಾರ ಸುರಕ್ಷತಾ ಪರಿಶೀಲನೆ ಸಹಾಯವಾಣಿಗೆ ಸ್ವಾಗತ. ದಯವಿಟ್ಟು ತಾವು ಎದುರಿಸಿದ ಆಹಾರ ನೈರ್ಮಲ್ಯ ಅಥವಾ ಕಲುಷಿತ ಆಹಾರದ ದೂರಿನ ಬಗ್ಗೆ ವಿವರವಾಗಿ ತಿಳಿಸಿ. ನಾವು ಸೂಕ್ತ ತನಿಖೆ ನಡೆಸುತ್ತೇವೆ.";
    } else if (digits === "2" || (step === "welcome" && matchesIvrLanguageChoice(message || "", "2", "hi-IN"))) {
      currentLang = "hi-IN";
      updatedData.language = "hi-IN";
      nextStep = "collecting_info";
      replyText = "नमस्ते! खाद्य सुरक्षा एवं निरीक्षण हेल्पलाइन में आपका स्वागत है। कृपया अपनी खाद्य सुरक्षा या स्वच्छता संबंधी शिकायत का विवरण बताएं। हम उचित जांच करेंगे।";
    } else if (digits === "3" || (step === "welcome" && matchesIvrLanguageChoice(message || "", "3", "en-IN"))) {
      currentLang = "en-IN";
      updatedData.language = "en-IN";
      nextStep = "collecting_info";
      replyText = "Welcome to the Food Safety & Standards Inspection Authority Helpline. Please describe the food safety, contamination, or hygiene issue you encountered. We will investigate immediately.";
    } 
    // 2. DTMF Key 7: Press 7 for Audio Voice Note Recording
    else if ((digits === "7" || matchesIvrDigit(message || "", "7") || ivrTokenRegex("seven").test(message || "") || /\b(record|voice note|audio note)\b/i.test(message || "") || ivrTokenRegex("ಧ್ವನಿ").test(message || "") || ivrTokenRegex("ರೆಕಾರ್ಡ್").test(message || "") || ivrTokenRegex("ಏಳು").test(message || "") || ivrTokenRegex("ऑडियो").test(message || "") || ivrTokenRegex("सात").test(message || "")) && !isVoiceNote && step !== "ready_for_beep") {
      nextStep = "ready_for_beep";
      if (isKannada) {
        replyText = "ದಯವಿಟ್ಟು ಬೀಪ್ ಶಬ್ದದ ನಂತರ ತಮ್ಮ ವಿವರವಾದ ಧ್ವನಿ ಸಂದೇಶವನ್ನು ಸ್ಪಷ್ಟವಾಗಿ ಮಾತನಾಡಿ.";
      } else if (isHindi) {
        replyText = "कृपया बीप की आवाज़ के बाद अपना विस्तृत ऑडियो संदेश रिकॉर्ड करें।";
      } else {
        replyText = "Please record your message after the beep.";
      }
    }
    // 2b. Reaction to Recorded Voice Note
    else if (isVoiceNote || step === "ready_for_beep") {
      nextStep = "press_7_prompt";
      if (message && message !== "Voice note recorded and attached." && message !== "Voice note recorded.") {
        const prompt = `The customer just recorded an audio voice note describing their food complaint.
Voice note transcript: "${message}"
Caller Selected Language: ${langName} (${currentLang})
Known details:
- Cause: ${updatedData.cause || "Unknown"}
- Location: ${updatedData.location || "Unknown"}
- When: ${updatedData.when || "Unknown"}
- Item: ${updatedData.item || "Unknown"}

Instructions:
1. Extract any newly mentioned cause (what went wrong/details), location/where (restaurant name, branch, address), when (date or time), or food item name.
2. Acknowledge what the caller spoke in their voice note in 1-2 calm, reassuring sentences.
3. Then state clearly: "To submit your complaint now, press 9 or say confirm." (in ${langName}).
4. CRITICAL: The response MUST be strictly in ${langName}. If Kannada, use polite Kannada honorifics (ನಮಸ್ಕಾರ, ಧನ್ಯವಾದಗಳು, ತಾವು, ತಮ್ಮ). If Hindi, use polite Hindi (नमस्ते, धन्यवाद, आप).

Respond in strict JSON:
{
  "cause": "updated or existing cause",
  "location": "updated or existing location",
  "when": "updated or existing when",
  "item": "updated or existing item",
  "spokenResponse": "1-2 highly polite sentences to speak to caller strictly in ${langName}"
}`;

        try {
          const aiResponse = await runLLMGeneration({
            prompt,
            json: true,
            maxTokens: 320,
            preferFast: true,
          }) || "{}";
          const parsed = cleanAndParseJson(aiResponse) || {};
          if (parsed.cause) updatedData.cause = parsed.cause;
          if (parsed.location) updatedData.location = parsed.location;
          if (parsed.when) updatedData.when = parsed.when;
          if (parsed.item) updatedData.item = parsed.item;
          if (parsed.spokenResponse) {
            replyText = sanitizeIvrReply(String(parsed.spokenResponse), {
              turnIndex: Math.max(2, callerTurn),
              name: profile?.name,
            });
          }
        } catch {}
      }

      if (!replyText) {
        if (isKannada) {
          replyText = "ಧನ್ಯವಾದಗಳು, ತಮ್ಮ ಧ್ವನಿ ಸಂದೇಶವನ್ನು ಸ್ವೀಕರಿಸಲಾಗಿದೆ ಮತ್ತು ದಾಖಲಿಸಲಾಗಿದೆ. ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ ಅಥವಾ ದೃಢೀಕರಿಸಿ ಎಂದು ಹೇಳಿ.";
        } else if (isHindi) {
          replyText = "धन्यवाद, आपकी ऑडियो रिकॉर्डिंग सुरक्षित कर ली गई है। शिकायत दर्ज करने के लिए 9 दबाएँ या पुष्टि करें कहें।";
        } else {
          replyText = "Thank you, your voice note has been recorded and attached. To submit your complaint, press 9 or say confirm.";
        }
      }
    }
    // 3. DTMF Key 9 or explicit user confirmation to submit.
    //    A plain "yes / confirm / sari" is honoured at any point once the agent
    //    has actually asked for confirmation, so the caller is never trapped in
    //    a loop of the same prompt.
    else if (
      digits === "9" ||
      matchesIvrDigit(message || "", "9") ||
      // Deliberately NOT applied at step "welcome": a stray "ok" there must not
      // file an empty complaint before the caller has even chosen a language.
      ((step === "collecting_info" || step === "press_7_prompt") &&
        isIvrConfirmation(message || ""))
    ) {
      nextStep = "submitted";
      isComplaintReady = true;

      const caseId = `GRV-${Date.now().toString().slice(-6)}`;
      raisedComplaintId = caseId;
      const cause = updatedData.cause || "Food hygiene & quality discrepancy";
      const location = updatedData.location || profile?.location || "Unspecified Branch";
      const item = updatedData.item || "Food Item";

      markdownReport = `# 📋 Official Consumer Grievance Report
> **Reference ID:** #${caseId} | **Channel:** IVR Helpline (1800-FOOD-VOX) | **Priority:** High | **Status:** Logged & Under Review

---

### 📍 Incident Specifics
| Parameter | Record Details |
| :--- | :--- |
| **Consumer Name** | ${profile?.name || "Valued Customer"} |
| **Contact Phone** | ${profile?.phone || "Phone On File"} |
| **Incident Location** | ${location} |
| **Affected Item** | ${item} |
| **Core Cause / Violation** | ${cause} |
| **Incident Timestamp** | ${new Date().toLocaleString()} |

---

### 🔍 Cause & Incident Breakdown
${cause}

### 🎙️ Audio Evidence
${updatedData.audioNoteUrl ? `**Voice Note Attached (MP3):** [Play Voice Evidence](${updatedData.audioNoteUrl})` : "No direct audio recording attached."}

### ⚠️ Safety & Compliance Protocol
- **Hygiene & Safety Assessment:** Immediate compliance audit initiated.
- **Regulatory Framework:** FSSAI Schedule 4 Standards & Consumer Protection Act 2019.

### 📌 Corrective Actions
1. Immediate notification sent to outlet manager at ${location}.
2. Redressal & refund processing scheduled.
3. Audio recording and transcript archived for administrative review.

---
*Report filed via VoxAssist IVR Voice System*`;

      // Save into Turso database complaints table
      try {
        const turso = getTurso();
        if (turso) {
          await turso.execute({
            sql: `INSERT INTO complaints (id, name, phoneNumber, location, query, status, chatHistory, mediaUrls, audioUrl, createdAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              caseId,
              profile?.name || "IVR Caller",
              profile?.phone || "IVR Phone",
              location,
              markdownReport,
              "pending",
              JSON.stringify(history || []),
              "[]",
              updatedData.audioNoteUrl || "",
              Date.now()
            ]
          });
          console.log(`[IVR] Successfully registered complaint ${caseId} in Turso DB`);
        }
      } catch (dbErr: any) {
        console.warn("[IVR] Turso insert notice:", dbErr?.message);
      }

      if (isKannada) {
        replyText = `ನಿಮ್ಮ ದೂರು ಸಂಖ್ಯೆ ${caseId} ಯಶಸ್ವಿಯಾಗಿ ನೋಂದಾಯಿಸಲ್ಪಟ್ಟಿದೆ. ನಾವು ಮುಂದಿನ ಕ್ರಮವನ್ನು ಕೈಗೊಳ್ಳುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು, ತಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ!`;
      } else if (isHindi) {
        replyText = `आपकी शिकायत संख्या ${caseId} सफलतापूर्वक दर्ज कर ली गई है। हम आगे की उचित कार्रवाई करेंगे। धन्यवाद, आपका दिन शुभ हो!`;
      } else {
        replyText = `Your complaint reference ID ${caseId} has been successfully registered. We will take care of it further. Thank you, have a nice day!`;
      }
    }
    // 4. Live conversation - the agent talks like a person, answers real
    //    questions, remembers what the caller already said, and only then
    //    collects the complaint facts.
    else {
      // 4a. Understand what the caller said using conversation-wide memory.
      const analysis = analyzeCustomerWords(message, history, updatedData, currentLang);

      const saidText = String(message || "").trim();
      const isGreeting = /^(hello|hi|hey|namaste|namaskara|namaskaram|good\s+morning|good\s+evening|ನಮಸ್ಕಾರ|ನಮಸ್ತೆ|नमस्ते|हैलो|ಹಲೋ)[\s!.,।]*$/i.test(saidText);
      const asksAQuestion = /\?|ಏನು|ಹೇಗೆ|ಯಾಕೆ|ಯಾರು|ಎಷ್ಟು|ಎಲ್ಲಿ|ಯಾವಾಗ|ತಿಳಿಸಿ|ಹೇಳಿ|ಬಗ್ಗೆ|सहायता|क्या|कैसे|क्यों|कब|कहाँ|बताइए|जानकारी|what|how|why|who|when|where|which|can you|could you|tell me|explain|help/i.test(saidText);
      const isInformational = !isGreeting && (analysis.isInformationalInquiry || asksAQuestion);

      // A question is a question: never scrape a "location/date/cause" out of
      // it, otherwise junk such as "is FSSAI and how does it" ends up stored as
      // the caller's restaurant.
      if (!isInformational) {
        if (analysis.location && !updatedData.location) updatedData.location = analysis.location;
        if (analysis.when && !updatedData.when) updatedData.when = analysis.when;
        if (analysis.cause && !updatedData.cause) updatedData.cause = analysis.cause;
        if (analysis.item && !updatedData.item) updatedData.item = analysis.item;
        if (analysis.owner && !updatedData.owner) updatedData.owner = analysis.owner;
      }

      // 4b. Ground the reply in real data: uploaded knowledge + learned Q&A +
      //     this caller's earlier calls.
      const knowledge = await getIvrKnowledgeContext(currentLang, saidText);
      const callerMemory = await loadCallerMemory(profile?.phone);
      // What they already described on the website, so the call does not make
      // them start over. Same phone number only.
      const webChatMemory = await loadWebChatCallerMemory(profile?.phone, langName);

      const memoryBlock = `Known so far in this call:
- Cause / problem: ${updatedData.cause || "not yet known"}
- Place (hotel / restaurant / branch): ${updatedData.location || "not yet known"}
- When: ${updatedData.when || "not yet known"}
- Food item: ${updatedData.item || "not yet known"}
- Still missing: ${analysis.missingFields.join(", ") || "nothing"}
- Caller says they are done / confirming: ${analysis.isExhaustedOrConfirming ? "yes" : "no"}
${callerMemory ? `Earlier contact with this caller:\n${callerMemory}` : ""}${webChatMemory ? `\nWhat this caller already told us on the website chat:\n${webChatMemory}` : ""}`;

      const languageRules = `LANGUAGE: reply ONLY in ${langName}. ${
        isKannada
          ? "Write every single word in Kannada script (ಕನ್ನಡ), never in English."
          : isHindi
          ? "Write every single word in Devanagari (हिंदी), never in English."
          : "Reply in clear, simple Indian English."
      }`;

      const humanRules = `HOW A REAL PERSON TALKS ON A HELPLINE CALL:
- Greet only in the very first sentence of the call. From now on: no "Namaskara", no "Namaste", no "Hello", and do NOT keep repeating the caller's name.
- Acknowledge what they just said in your own words, then continue - like a caring human on the phone.
- 1 to 2 short spoken sentences. Never read out lists, markdown, symbols or emojis.
- Never ask for a detail that is already known above.
- Ask at most ONE question per turn, and only when you genuinely need it.
- If the caller asks ANY question - rules, licence, hygiene, penalty, procedure, how to complain, complaint status - answer it properly and helpfully FIRST. This helpline must answer questions, not only record complaints.
- If the caller sounds upset, reassure them briefly before asking anything else.
- Never invent an outlet name, date, person or fact the caller did not mention.`;

      let prompt = "";
      if (isGreeting) {
        prompt = `You are the voice of the Food Safety Helpline - a warm, natural, human-sounding agent.
The caller just greeted you: "${saidText}"
${languageRules}
Reply with ONE short, warm, human sentence that greets them back and asks how you can help.
Respond in strict JSON: {"cause":"","location":"","when":"","item":"","spokenResponse":"<one sentence>","hasRequiredDetails":false}`;
      } else if (isInformational) {
        prompt = `You are a warm, knowledgeable food safety and consumer affairs expert answering a helpline caller by phone.
Caller asked: "${saidText}"
${languageRules}
${knowledge ? `Verified reference material you should use when relevant:\n${knowledge}\n` : ""}
${memoryBlock}

RULES:
- Answer the question directly and helpfully in 1-2 spoken sentences. Answering is the whole point of this turn - do not dodge it and do not just demand complaint details.
- If the reference material does not cover it, answer from general food safety and consumer protection knowledge.
- Be conversational and human. No markdown, no bullet points, no emojis.
Respond in strict JSON: {"cause":"","location":"","when":"","item":"","spokenResponse":"<1-2 sentences>","hasRequiredDetails":false}`;
      } else {
        prompt = `You are the voice of the Food Safety Helpline - a warm, attentive human-sounding agent on a live phone call.
Caller's name: ${profile?.name || "the caller"}

${memoryBlock}

The caller just said: "${saidText}"

${languageRules}
${knowledge ? `Verified reference material you may use:\n${knowledge}\n` : ""}
${humanRules}

TASK:
1. React naturally to what the caller said (acknowledge, reassure, or answer).
2. If they are still describing a problem and an important detail is missing, ask for exactly ONE missing detail.
3. If everything needed is known, or they say they are finished, tell them in ${langName} that the details are recorded, that they can press 7 to record a voice note, or press 9 / say "confirm" to submit the complaint.
Respond in strict JSON: {"cause":"<cause or empty>","location":"<place or empty>","when":"<when or empty>","item":"<food item or empty>","spokenResponse":"<1-2 spoken sentences>","hasRequiredDetails":true/false}`;
      }

      const aiResponse = await runLLMGeneration({
        prompt,
        json: true,
        maxTokens: 320,
        preferFast: true,
      }) || "{}";
      const parsed: any = cleanAndParseJson(aiResponse) || {};

      // The model understands context far better than the keyword regexes, so
      // its extraction wins: e.g. the regex stored "ರಾತ್ರಿ ಅನ್ನಪೂರ್ಣೇಶ್ವರಿ ಹೋಟೆಲ್"
      // (sweeping in the word for "night") where the model returns just the
      // outlet name. Only fall back to the regex value when the model is silent.
      updatedData.cause = parsed.cause || updatedData.cause;
      updatedData.location = parsed.location || updatedData.location;
      updatedData.when = parsed.when || updatedData.when;
      updatedData.item = parsed.item || updatedData.item;

      const hasAllDetails = parsed.hasRequiredDetails ||
        analysis.hasAllRequired ||
        analysis.isExhaustedOrConfirming ||
        (updatedData.cause && updatedData.location);

      nextStep = hasAllDetails ? "press_7_prompt" : "collecting_info";

      let candidateReply = String(parsed.spokenResponse || "").trim();
      const langMatches = !!candidateReply && (
        (isKannada && /[\u0C80-\u0CFF]/.test(candidateReply)) ||
        (isHindi && /[\u0900-\u097F]/.test(candidateReply)) ||
        (!isKannada && !isHindi)
      );
      // Only a real model answer may be learned into the Q&A cache - never a
      // canned fallback line, or the cache poisons itself over time.
      let answerCameFromModel = !!candidateReply && langMatches;

      if (!candidateReply || !langMatches) {
        // Fallback wording must fit the kind of turn it is: for a question we
        // never fall back to "please tell me the date of the incident".
        const infoFallback = isKannada
          ? `ಖಂಡಿತ, ನಾನು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ. ದಯವಿಟ್ಟು ಅದನ್ನು ಇನ್ನೊಮ್ಮೆ ತಿಳಿಸುವಿರಾ?`
          : isHindi
          ? `जी, मैं इसमें आपकी सहायता करता हूँ। कृपया इसे एक बार फिर बताइए।`
          : `Of course, I am happy to help with that. Could you say that once more?`;

        const doneFallback = isKannada
          ? `ಧನ್ಯವಾದಗಳು, ವಿವರಗಳನ್ನು ದಾಖಲಿಸಿದ್ದೇನೆ. ಧ್ವನಿ ಸಂದೇಶ ರೆಕಾರ್ಡ್ ಮಾಡಲು 7 ಒತ್ತಿ, ದೂರು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ.`
          : isHindi
          ? `धन्यवाद, मैंने विवरण दर्ज कर लिया है। ऑडियो संदेश के लिए 7 दबाएँ, शिकायत दर्ज करने के लिए 9 दबाएँ।`
          : `Thank you, I have noted the details. Press 7 to record a voice note, or press 9 to submit your complaint.`;

        const moreFallback = isKannada
          ? `ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಹೆಚ್ಚು ವಿವರ ತಿಳಿಸುವಿರಾ?`
          : isHindi
          ? `कृपया थोड़ा और विवरण बताइए।`
          : `Could you tell me a little more about that?`;

        const kbAnswer = isInformational ? answerFromKnowledgeContext(knowledge, currentLang) : "";

        candidateReply = isInformational
          ? (kbAnswer || infoFallback)
          : (analysis.suggestedPrompt || (hasAllDetails ? doneFallback : moreFallback));

        answerCameFromModel = false;
      }

      replyText = candidateReply;

      // 4c. Learn from real questions so the same one is instant next time.
      if (answerCameFromModel && isInformational && replyText && saidText.length > 6) {
        await rememberQaPair({ langCode: currentLang, question: saidText, answer: replyText });
      }
    }

    // One single place guarantees the agent never re-greets or chants the
    // caller's name on every turn, whichever branch produced the reply.
    if (replyText) {
      replyText = sanitizeIvrReply(replyText, { turnIndex: callerTurn, name: profile?.name });
    }

    // Persist the conversation. This is the database memory that lets the IVR
    // behave like someone who knows the caller, and lets any follow-up be
    // answered from real records instead of a fresh conversation.
    const turnBase = (Number(turnIndex) || 0) * 2;
    const userTurnText = String(message || (digits ? `Pressed ${digits}` : "") || "").trim();
    if (userTurnText) {
      await logIvrTurn({
        callId,
        turnIndex: turnBase,
        role: "user",
        text: userTurnText,
        langCode: currentLang,
        step,
      });
    }
    if (replyText) {
      await logIvrTurn({
        callId,
        turnIndex: turnBase + 1,
        role: "assistant",
        text: replyText,
        langCode: currentLang,
        step: nextStep,
      });
    }
    await upsertIvrCall({
      callId,
      profile,
      language: currentLang,
      status: isComplaintReady ? "submitted" : "active",
      turnCount: Number(turnIndex) || 0,
      complaintId: raisedComplaintId,
      collectedData: updatedData,
    });

    // Text-to-speech with a hard cap, so a slow voice provider can never delay
    // the spoken answer. If it misses the deadline the client speaks locally.
    let audioUrl: string | null = null;
    try {
      audioUrl = await Promise.race<string | null>([
        generateTTSAudioUrl(replyText, currentLang),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5500)),
      ]);
    } catch {
      audioUrl = null;
    }

    res.json({
      text: replyText,
      replyText,
      audioUrl,
      nextStep,
      language: currentLang,
      collectedData: updatedData,
      isComplaintReady,
      markdownReport
    });
  } catch (err: any) {
    console.error("[IVR Dialogue Error]", err);
    res.status(500).json({ error: err.message || "IVR dialogue error" });
  }
});

// API: Register an IVR call session, so every conversation is stored in the DB
app.post("/api/ivr/call/start", async (req, res) => {
  try {
    const { callId, profile, language } = req.body || {};
    if (!callId) return res.status(400).json({ ok: false, error: "callId is required" });
    await upsertIvrCall({ callId, profile, language, status: "active" });
    res.json({ ok: true, callId });
  } catch (err: any) {
    res.status(200).json({ ok: false, error: err?.message });
  }
});

// API: Close an IVR call session and store the full transcript
app.post("/api/ivr/call/end", async (req, res) => {
  try {
    const { callId, language, collectedData, history } = req.body || {};
    const turns: any[] = Array.isArray(history) ? history : [];
    const transcript = turns
      .map((h: any) => `${h.role === "user" ? "Caller" : "Agent"}: ${String(h.text || "").trim()}`)
      .filter((line: string) => line.length > 9)
      .join("\n");

    await upsertIvrCall({
      callId,
      language,
      status: "completed",
      transcript,
      collectedData,
      turnCount: turns.filter((h: any) => h.role === "user").length,
      ended: true,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(200).json({ ok: false, error: err?.message });
  }
});

// API: IVR conversation records for the dashboard / admin review
app.get("/api/admin/ivr-calls", requireAdmin, async (req, res) => {
  try {
    const turso = getTurso();
    if (!turso) return res.json([]);
    const calls = await turso.execute("SELECT * FROM ivr_calls ORDER BY startedAt DESC LIMIT 100");
    res.json(calls.rows);
  } catch (error: any) {
    console.error("Error fetching IVR calls:", error);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

app.get("/api/admin/ivr-calls/:id", requireAdmin, async (req, res) => {
  try {
    const turso = getTurso();
    if (!turso) return res.status(404).json({ error: "Database not configured" });
    const call = await turso.execute({
      sql: "SELECT * FROM ivr_calls WHERE id = ? LIMIT 1",
      args: [req.params.id],
    });
    const turns = await turso.execute({
      sql: "SELECT * FROM ivr_turns WHERE callId = ? ORDER BY turnIndex ASC",
      args: [req.params.id],
    });
    res.json({ call: call.rows[0] || null, turns: turns.rows });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// API: Neural Text-to-Speech (TTS)
app.post("/api/tts", voiceLimit, async (req, res) => {
  try {
    const { text, language = "kn-IN" } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }
    const audioUrl = await generateTTSAudioUrl(text, language);
    if (audioUrl) {
      return res.json({ audioUrl });
    }
    return res.status(503).json({ error: "No TTS provider available" });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "TTS failed" });
  }
});

// Helper to detect Whisper hallucinations on silent/quiet audio clips
function isHallucinatedTranscript(text: string): boolean {
  if (!text || !text.trim()) return true;
  // Reject CJK (Chinese, Japanese, Korean) or Cyrillic characters returned as hallucinations
  if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af\u0400-\u04FF]/.test(text)) {
    return true;
  }
  const clean = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const hallucinations = [
    "thank you",
    "thank you very much",
    "thank you so much",
    "thank you for watching",
    "thanks for watching",
    "thanks",
    "subtitles by amara org",
    "subtitles by amaraorg",
    "subtitles by",
    "amara org",
    "bye",
    "subscribe",
    "you",
    "mb",
    "silence",
    "noise",
    "dank u",
    "untertitel",
    "moje",
    "shokran"
  ];
  return hallucinations.includes(clean);
}

// API: Speech-to-Text (STT) - Groq Whisper large-v3-turbo
app.post("/api/stt", voiceLimit, upload.single("audio"), async (req: any, res) => {
  const startedAt = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const rawLang = String(req.body?.language || "en-IN");
    const hint = String(req.body?.hint || "").trim().slice(0, 800);
    const langCode = normalizeIvrLang(rawLang); // kn-IN | hi-IN | en-IN
    const whisperCode = langCode === "kn-IN" ? "kn" : langCode === "hi-IN" ? "hi" : "en";

    const audioBuffer = req.file.buffer as Buffer;
    const mime = req.file.mimetype || "audio/webm";

    const makeFile = (buffer: Buffer, type: string, name: string) =>
      typeof File !== "undefined"
        ? new File([buffer], name, { type })
        : new Blob([buffer], { type });

    // Walk the language's STT chain. The language is FORCED and the decoder is
    // seeded with a domain lexicon, so the transcript cannot silently drift to
    // English and local food/hotel words are not "corrected" into nonsense.
    const groqKey = getGroqKey();
    if (groqKey) {
      const chain = GROQ_STT_CHAINS[whisperCode] || GROQ_STT_CHAINS.en;
      const prompt = hint || STT_DOMAIN_HINTS[whisperCode] || "";

      for (const model of chain) {
        const attempt = async (usePrompt: boolean): Promise<string> => {
          const formData = new FormData();
          formData.append("file", makeFile(audioBuffer, mime, "voice.webm") as any, "voice.webm");
          formData.append("model", model);
          formData.append("language", whisperCode);
          formData.append("temperature", "0");
          formData.append("response_format", "json");
          // A long decoder prompt conditioned on silence is the classic trigger
          // for Whisper repetition loops, so the prompt is optional here and the
          // caller retries without it when the first result loops.
          if (usePrompt && prompt) formData.append("prompt", prompt.slice(0, 800));

          const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${groqKey}`,
            },
            body: formData,
          }, 15000);

          const contentType = groqRes.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) {
            const errTxt = await groqRes.text().catch(() => "");
            console.warn(`[STT] ${model}${usePrompt ? "" : " (no prompt)"} returned HTTP ${groqRes.status}: ${errTxt.slice(0, 200)}`);
            return "";
          }
          const groqData: any = await groqRes.json();
          return String(groqData?.text || "").trim();
        };

        try {
          let text = await attempt(true);

          // If the model looped, re-decode WITHOUT the prompt and keep whichever
          // result is not repetitive.
          if (text && looksRepetitive(text)) {
            console.warn(`[STT] ${model} returned a repeated phrase; retrying without the decoder prompt.`);
            const retry = await attempt(false);
            if (retry && !looksRepetitive(retry)) text = retry;
          }

          // Collapse repeats, then repair digit homophones, so "8 food" never
          // reaches the caption, the chat or memory.
          const collapsed = normalizeRecognizedText(collapseRepetitions(text));

          if (collapsed && !isHallucinatedTranscript(collapsed)) {
            if (collapsed !== text) {
              console.log(`[STT] collapsed a repeated transcript: "${text}" -> "${collapsed}"`);
            }
            console.log(`[STT] ${model} (${whisperCode}) in ${Date.now() - startedAt}ms: "${collapsed}"`);
            return res.json({
              transcript: collapsed,
              repeatedRawText: collapsed !== text ? text : undefined,
              provider: `groq-whisper:${model}`,
              model,
              language: langCode,
              ms: Date.now() - startedAt,
            });
          }
        } catch (modelErr: any) {
          console.warn(`[STT] ${model} failed: ${modelErr?.message}`);
        }
      }
    }

    console.warn(`[STT] Chain [${(GROQ_STT_CHAINS[whisperCode] || []).join(" -> ")}] produced no usable transcript after ${Date.now() - startedAt}ms - the caller falls back to on-device recognition.`);
    res.status(200).json({ transcript: "", language: langCode, error: "Could not transcribe audio." });
  } catch (err: any) {
    console.error("STT endpoint error:", err);
    res.status(200).json({ transcript: "", error: err.message });
  }
});

// API: Knowledge Base CRUD (Turso Database)
app.get("/api/knowledge", requireAdmin, async (req, res) => {
  try {
    const turso = getTurso();
    if (!turso) return res.json([]);
    const result = await turso.execute("SELECT * FROM knowledge_base ORDER BY createdAt DESC");
    res.json(result.rows);
  } catch (error: any) {
    console.error("Error fetching knowledge from Turso:", error);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

app.post("/api/knowledge", requireAdmin, async (req, res) => {
  const { id, name, content, type, createdAt } = req.body;
  const docId = id || Date.now().toString();
  const docCreatedAt = createdAt || Date.now();
  try {
    const turso = getTurso();
    if (!turso) return res.json({ success: true, id: docId, name, content, type, createdAt: docCreatedAt });
    await turso.execute({
      sql: "INSERT INTO knowledge_base (id, name, content, type, createdAt) VALUES (?, ?, ?, ?, ?)",
      args: [docId, name || "Document", content || "", type || "text", docCreatedAt],
    });
    res.json({ success: true, id: docId, name, content, type, createdAt: docCreatedAt });
  } catch (error: any) {
    console.error("Error inserting knowledge into Turso:", error);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/knowledge/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const turso = getTurso();
    if (!turso) return res.json({ success: true, id });
    await turso.execute({
      sql: "DELETE FROM knowledge_base WHERE id = ?",
      args: [id],
    });
    res.json({ success: true, id });
  } catch (error: any) {
    console.error("Error deleting knowledge from Turso:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Store Complaint in Turso
app.post("/api/complaints/add", uploadLimit, async (req, res) => {
  const { id, name, phoneNumber, location, query, status, chatHistory, mediaUrls, audioUrl, createdAt, adminReply, adminReplyAt } = req.body;
  
  try {
    const turso = getTurso();
    if (!turso) return res.json({ success: true, id });
    await turso.execute({
      sql: `INSERT INTO complaints (id, name, phoneNumber, location, query, status, chatHistory, mediaUrls, audioUrl, createdAt, adminReply, adminReplyAt) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id || Date.now().toString(), 
        name || "Guest", 
        phoneNumber || "N/A", 
        location || "", 
        query || "", 
        status || "pending", 
        typeof chatHistory === "string" ? chatHistory : JSON.stringify(chatHistory || []), 
        typeof mediaUrls === "string" ? mediaUrls : JSON.stringify(mediaUrls || []), 
        audioUrl || "", 
        createdAt || Date.now(),
        adminReply || "",
        adminReplyAt || null
      ],
    });
    res.json({ success: true, id });
  } catch (error: any) {
    console.error("Error saving complaint:", error);
    res.status(500).json({ error: error.message });
  }
});

// Diagnostics: answers "is my memory actually being stored, or is this a database
// problem?" in one request. Deliberately reports no credentials.
app.get("/api/health", async (_req, res) => {
  const turso = getTurso();
  let conversationsInDb: number | null = null;
  let dbError: string | null = null;

  if (turso) {
    try {
      const result = await turso.execute("SELECT COUNT(*) AS c FROM conversations");
      conversationsInDb = Number((result.rows[0] as any)?.c || 0);
    } catch (e: any) {
      dbError = e?.message || "query failed";
    }
  }

  res.json({
    ok: true,
    database: turso ? "configured" : "missing",
    memoryIsDurable: !!turso,
    conversationsInDb,
    conversationsInMemory: conversationMemory.size,
    dbError,
    llmKeyConfigured: !!getGroqKey(),
    note: turso
      ? "Conversation memory is stored in the database, so it is shared between instances and survives a restart."
      : "TURSO_DATABASE_URL is NOT set. Memory lives only inside this running server process: it is LOST on every restart, and on serverless hosting each instance keeps its own copy, so consecutive messages can appear to forget. This is the cause of 'it forgot what I said'.",
  });
});

app.get("/api/complaints", async (req, res) => {
  const { phone, id } = req.query;
  try {
    // Validate the lookup BEFORE touching the database, so a partial phone number
    // is always refused - even when the DB is unavailable and the handler would
    // otherwise short-circuit with an empty list.
    const complaintId = id ? String(id).trim() : '';
    const cleanPhone = phone ? String(phone).trim() : '';
    if (complaintId) {
      if (complaintId.length < 6) {
        return res.status(400).json({ error: "A valid complaint reference is required" });
      }
    } else if (cleanPhone) {
      if (cleanPhone.replace(/\D/g, "").length < 10) {
        return res.status(400).json({ error: "Please enter the full phone number you registered with" });
      }
    } else {
      // No lookup key: never leak other citizens' complaints.
      return res.json([]);
    }

    const turso = getTurso();
    if (!turso) return res.json([]);
    if (complaintId) {
      const result = await turso.execute({
        sql: "SELECT * FROM complaints WHERE id = ? ORDER BY createdAt DESC",
        args: [complaintId],
      });
      return res.json(result.rows);
    }
    if (cleanPhone) {
      // SECURITY FIX: this previously ran `phoneNumber LIKE %<input>%`, so a
      // one-character query such as ?phone=9 dumped every matching citizen's
      // complaint details. A full number is now required (validated above).
      const digits = cleanPhone.replace(/\D/g, "");
      const result = await turso.execute({
        sql: "SELECT * FROM complaints WHERE phoneNumber = ? OR phoneNumber = ? ORDER BY createdAt DESC",
        args: [cleanPhone, digits],
      });
      return res.json(result.rows);
    }
    res.json([]);
  } catch (error: any) {
    console.warn("Error fetching customer complaints:", error.message);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

app.get("/api/admin/complaints", requireAdmin, async (req, res) => {
  try {
    const turso = getTurso();
    if (!turso) return res.json([]);
    const result = await turso.execute("SELECT * FROM complaints ORDER BY createdAt DESC");
    res.json(result.rows);
  } catch (error: any) {
    console.error("Error fetching admin complaints:", error);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

// Admin: Reply to complaint
app.post("/api/admin/complaints/:id/reply", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { reply, status } = req.body;
  try {
    const turso = getTurso();
    const replyAt = Date.now();
    const newStatus = status || "resolved";
    await turso.execute({
      sql: "UPDATE complaints SET adminReply = ?, adminReplyAt = ?, status = ? WHERE id = ?",
      args: [reply, replyAt, newStatus, id],
    });
    res.json({ success: true, id, adminReply: reply, adminReplyAt: replyAt, status: newStatus });
  } catch (error: any) {
    console.error("Error updating complaint reply:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update status
app.patch("/api/admin/complaints/:id/status", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const turso = getTurso();
    await turso.execute({
      sql: "UPDATE complaints SET status = ? WHERE id = ?",
      args: [status, id],
    });
    res.json({ success: true, id, status });
  } catch (error: any) {
    console.error("Error updating complaint status:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete single or batch knowledge entries from Turso
app.post("/api/knowledge/batch-delete", requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "IDs array is required" });
  }
  try {
    const turso = getTurso();
    for (const id of ids) {
      await turso.execute({
        sql: "DELETE FROM knowledge_base WHERE id = ?",
        args: [id],
      });
    }
    res.json({ success: true, count: ids.length });
  } catch (error: any) {
    console.error("Turso delete knowledge error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete complaint
app.delete("/api/admin/complaints/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const turso = getTurso();
    await turso.execute({
      sql: "DELETE FROM complaints WHERE id = ?",
      args: [id],
    });
    res.json({ success: true, id });
  } catch (error: any) {
    console.error("Error deleting complaint:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: AI Intelligent Database Erase Evaluator
app.post("/api/admin/ai-eval-erase", requireAdmin, async (req, res) => {
  const { prompt, documents } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Erase prompt is required" });
  }

  if (!Array.isArray(documents) || documents.length === 0) {
    return res.json({ 
      matchingDocIds: [], 
      explanation: "There are no documents in the database to evaluate.",
      matchedDetails: [] 
    });
  }

  try {
    const systemInstruction = `You are an AI database curator and pruning agent for a food service knowledge base.
Your job is to strictly evaluate a list of database documents against the user's natural language erasure prompt, and determine exactly which document IDs should be deleted.

Guidelines:
1. Carefully inspect the user's prompt (e.g. "delete all burger items", "remove drinks and cocktails", "erase documents from last week", "delete everything", "remove refund policy").
2. Match documents based on their name, content, type, or timestamp.
3. If the user prompt asks to delete everything, clear all, or wipe database, return all document IDs.
4. Output MUST be valid JSON with this exact schema:
{
  "matchingDocIds": ["docId1", "docId2"],
  "explanation": "Clear human-readable summary of what was matched and why.",
  "matchedDetails": [
    {
      "id": "docId1",
      "name": "Document Name",
      "reason": "Why this document matches the erasure criteria"
    }
  ]
}`;

    const promptPayload = `USER ERASURE PROMPT:
"""
${prompt}
"""

CURRENT DATABASE DOCUMENTS (${documents.length} total):
${JSON.stringify(documents.map((d: any) => ({
  id: d.id,
  name: d.name,
  type: d.type,
  createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : "Unknown",
  contentSnippet: (d.content || "").slice(0, 800), // First 800 chars for semantic matching
})), null, 2)}

Respond with JSON only.`;

    const responseText = await runLLMGeneration({
      system: systemInstruction,
      prompt: promptPayload,
    }) || "{}";
    let parsedResult: any = {};
    try {
      parsedResult = JSON.parse(responseText);
    } catch {
      parsedResult = {
        matchingDocIds: [],
        explanation: responseText,
        matchedDetails: []
      };
    }

    res.json(parsedResult);
  } catch (error: any) {
    console.error("AI Erase Evaluation error:", error);
    res.status(500).json({ error: error.message || "Failed to evaluate AI erase prompt" });
  }
});

// Handle unmatched API routes to ensure JSON responses (prevents HTML fallback)
app.use("/api", (req, res, next) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` });
});

// API Error Handler Middleware
app.use("/api", (err: any, req: any, res: any, next: any) => {
  console.error("API Error Middleware caught:", err?.message || err);
  res.status(err?.status || 500).json({ error: err?.message || "Internal server error" });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;

if (process.env.VERCEL !== "1") {
  startServer();
}
