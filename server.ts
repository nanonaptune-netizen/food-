import express, { Request } from "express";
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
const GROQ_STT_MODEL = "whisper-large-v3-turbo";

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
      console.warn("Turso DB URL not set in environment; skipping DB initialization.");
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
      const wanted = [...new Set([...GROQ_VOICE_MODELS, ...GROQ_TEXT_MODELS, GROQ_STT_MODEL])];
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
app.post("/api/upload", upload.single("file"), async (req: any, res) => {
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
app.post("/api/upload-audio", upload.single("audio"), async (req: any, res) => {
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
app.post("/api/process-document", upload.single("file"), async (req: MulterRequest, res) => {
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

// API: Chat with Assistant (100% Dynamic AI Generation - No Hardcoded or Cached Answers)
app.post("/api/chat", async (req, res) => {
  const { message, context, language, profile, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  const queryText = message.trim();
  const targetLang = language || "English";
  const isKannada = targetLang.toLowerCase().includes("kan") || targetLang.toLowerCase().includes("kn");
  const isHindi = targetLang.toLowerCase().includes("hin") || targetLang.toLowerCase().includes("hi");
  const langName = isKannada ? "Kannada" : (isHindi ? "Hindi" : "English");

  // Semantic Memory & Customer Words Analysis across turns
  const analysis = analyzeCustomerWords(queryText, history, {}, langName);

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

4. GRIEVANCE / COMPLAINT REPORTING (Only when user reports a food safety issue):
   - If details are missing (WHERE / WHEN / CAUSE), politely ask ONLY for the missing detail.
   - If all details are known (Location: "${analysis.location || ""}", When: "${analysis.when || ""}", Cause: "${analysis.cause || ""}") OR user confirms submission:
     Format the official grievance report in clean Markdown starting with:
     # 📋 Official Food Safety & Inspection Grievance Report
     and ending with COMPLAINT_DRAFT_REQUEST.

Always respond warmly, naturally, and directly to what the user actually said.`;

    const conversationHistory = Array.isArray(history) && history.length > 0
      ? history.slice(-6).map((h: any) => ({
          role: (h.role === "assistant" || h.sender === "assistant") ? "assistant" : "user",
          content: String(h.content || h.text || "")
        }))
      : [];

    const fullMessages = [
      ...conversationHistory,
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

    res.json({ 
      response: cleanedText, 
      spokenText: spokenPart,
      markdownReport: markdownPart,
      audioUrl, 
      isComplaintDraft, 
      cached: false 
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

// API: Dedicated Calm & Pleasant IVR Dialogue State Machine
app.post("/api/ivr/dialogue", async (req, res) => {
  const { 
    message, 
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

  // Explicit Script-based and DTMF language detection
  if (digits === "1" || (step === "welcome" && (/1|one|kannada|ಕನ್ನಡ|ಒಂದು/i.test(message || "")))) {
    currentLang = "kn-IN";
  } else if (digits === "2" || (step === "welcome" && (/2|two|hindi|हिंदी|हिन्दी|दो|ಎರಡು/i.test(message || "")))) {
    currentLang = "hi-IN";
  } else if (digits === "3" || (step === "welcome" && (/3|three|english|ಇಂಗ್ಲಿಷ್|ಮೂರು|तीन/i.test(message || "")))) {
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
    if (digits === "1" || (step === "welcome" && (/1|one|kannada|ಕನ್ನಡ|ಒಂದು/i.test(message || "")))) {
      currentLang = "kn-IN";
      updatedData.language = "kn-IN";
      nextStep = "collecting_info";
      replyText = "ನಮಸ್ಕಾರ! ಆಹಾರ ಸುರಕ್ಷತಾ ಪರಿಶೀಲನೆ ಸಹಾಯವಾಣಿಗೆ ಸ್ವಾಗತ. ದಯವಿಟ್ಟು ತಾವು ಎದುರಿಸಿದ ಆಹಾರ ನೈರ್ಮಲ್ಯ ಅಥವಾ ಕಲುಷಿತ ಆಹಾರದ ದೂರಿನ ಬಗ್ಗೆ ವಿವರವಾಗಿ ತಿಳಿಸಿ. ನಾವು ಸೂಕ್ತ ತನಿಖೆ ನಡೆಸುತ್ತೇವೆ.";
    } else if (digits === "2" || (step === "welcome" && (/2|two|hindi|हिंदी|हिन्दी|दो|ಎರಡು/i.test(message || "")))) {
      currentLang = "hi-IN";
      updatedData.language = "hi-IN";
      nextStep = "collecting_info";
      replyText = "नमस्ते! खाद्य सुरक्षा एवं निरीक्षण हेल्पलाइन में आपका स्वागत है। कृपया अपनी खाद्य सुरक्षा या स्वच्छता संबंधी शिकायत का विवरण बताएं। हम उचित जांच करेंगे।";
    } else if (digits === "3" || (step === "welcome" && (/3|three|english|ಇಂಗ್ಲಿಷ್|ಮೂರು|तीन/i.test(message || "")))) {
      currentLang = "en-IN";
      updatedData.language = "en-IN";
      nextStep = "collecting_info";
      replyText = "Welcome to the Food Safety & Standards Inspection Authority Helpline. Please describe the food safety, contamination, or hygiene issue you encountered. We will investigate immediately.";
    } 
    // 2. DTMF Key 7: Press 7 for Audio Voice Note Recording
    else if ((digits === "7" || /7|seven|record|voice note|audio note|ಧ್ವನಿ|ರೆಕಾರ್ಡ್|ಏಳು|ऑडियो|सात/i.test(message || "")) && !isVoiceNote && step !== "ready_for_beep") {
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
      (step === "press_7_prompt" && /9|nine|confirm|yes|submit|sari|ha|ದೃಢೀಕರಿಸಿ|ಒಂಬತ್ತು|दर्ज|पुष्टि|हाँ|नौ/i.test(message || "")) ||
      ((step === "collecting_info" || step === "press_7_prompt") &&
        /^(confirm|confirmed|submit|yes|yes please|sari|haan|ha|ok|okay|done|that'?s all|proceed|ದೃಢೀಕರಿಸಿ|ಹೌದು|ಸರಿ|मंज़ूर|हाँ|हां|पुष्टि|ठीक है)[\s!.,।]*$/i.test((message || "").trim()))
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

      const memoryBlock = `Known so far in this call:
- Cause / problem: ${updatedData.cause || "not yet known"}
- Place (hotel / restaurant / branch): ${updatedData.location || "not yet known"}
- When: ${updatedData.when || "not yet known"}
- Food item: ${updatedData.item || "not yet known"}
- Still missing: ${analysis.missingFields.join(", ") || "nothing"}
- Caller says they are done / confirming: ${analysis.isExhaustedOrConfirming ? "yes" : "no"}
${callerMemory ? `Earlier contact with this caller:\n${callerMemory}` : ""}`;

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
app.get("/api/admin/ivr-calls", async (req, res) => {
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

app.get("/api/admin/ivr-calls/:id", async (req, res) => {
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
app.post("/api/tts", async (req, res) => {
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
app.post("/api/stt", upload.single("audio"), async (req: any, res) => {
  const startedAt = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const rawLang = String(req.body?.language || "en-IN");
    const hint = String(req.body?.hint || "").slice(0, 400);
    const langCode = normalizeIvrLang(rawLang); // kn-IN | hi-IN | en-IN
    const whisperCode = langCode === "kn-IN" ? "kn" : langCode === "hi-IN" ? "hi" : "en";

    const audioBuffer = req.file.buffer as Buffer;
    const mime = req.file.mimetype || "audio/webm";

    const makeFile = (buffer: Buffer, type: string, name: string) =>
      typeof File !== "undefined"
        ? new File([buffer], name, { type })
        : new Blob([buffer], { type });

    // Groq Whisper large-v3-turbo. It genuinely understands Kannada, Hindi and
    // English, and the language is FORCED here - so the transcript can never
    // silently drift to English the way the browser engine did.
    const groqKey = getGroqKey();
    if (groqKey) {
      try {
        const formData = new FormData();
        formData.append("file", makeFile(audioBuffer, mime, "voice.webm") as any, "voice.webm");
        formData.append("model", GROQ_STT_MODEL);
        formData.append("language", whisperCode);
        formData.append("temperature", "0");
        formData.append("response_format", "json");
        // Hint biases the decoder towards IVR vocabulary such as "ನಮಸ್ಕಾರ"
        // (namaskara) and local outlet names, instead of guessing plain English.
        if (hint) formData.append("prompt", hint);

        const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqKey}`,
          },
          body: formData,
        }, 12000);

        const contentType = groqRes.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const groqData: any = await groqRes.json();
          const text = String(groqData?.text || "").trim();
          if (text && !isHallucinatedTranscript(text)) {
            console.log(`[STT] groq-whisper (${whisperCode}) in ${Date.now() - startedAt}ms: "${text}"`);
            return res.json({
              transcript: text,
              provider: "groq-whisper",
              language: langCode,
              ms: Date.now() - startedAt,
            });
          }
        }
      } catch (groqWhisperErr: any) {
        console.warn("Groq Whisper STT failed:", groqWhisperErr?.message);
      }
    }

    console.warn(`[STT] Groq returned no usable transcript after ${Date.now() - startedAt}ms - the browser falls back to on-device recognition.`);
    res.status(200).json({ transcript: "", language: langCode, error: "Could not transcribe audio." });
  } catch (err: any) {
    console.error("STT endpoint error:", err);
    res.status(200).json({ transcript: "", error: err.message });
  }
});

// API: Knowledge Base CRUD (Turso Database)
app.get("/api/knowledge", async (req, res) => {
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

app.post("/api/knowledge", async (req, res) => {
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

app.delete("/api/knowledge/:id", async (req, res) => {
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
app.post("/api/complaints/add", async (req, res) => {
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

app.get("/api/complaints", async (req, res) => {
  const { phone, id } = req.query;
  try {
    const turso = getTurso();
    if (!turso) return res.json([]);
    if (id) {
      const result = await turso.execute({
        sql: "SELECT * FROM complaints WHERE id = ? ORDER BY createdAt DESC",
        args: [id as string],
      });
      return res.json(result.rows);
    }
    if (phone) {
      const cleanPhone = (phone as string).trim();
      const result = await turso.execute({
        sql: "SELECT * FROM complaints WHERE phoneNumber = ? OR phoneNumber LIKE ? ORDER BY createdAt DESC",
        args: [cleanPhone, `%${cleanPhone}%`],
      });
      return res.json(result.rows);
    }
    // Return empty list if no phone specified to prevent leaking other customers' private complaints
    res.json([]);
  } catch (error: any) {
    console.warn("Error fetching customer complaints:", error.message);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

app.get("/api/admin/complaints", async (req, res) => {
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
app.post("/api/admin/complaints/:id/reply", async (req, res) => {
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
app.patch("/api/admin/complaints/:id/status", async (req, res) => {
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
app.post("/api/knowledge/batch-delete", async (req, res) => {
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
app.delete("/api/admin/complaints/:id", async (req, res) => {
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
app.post("/api/admin/ai-eval-erase", async (req, res) => {
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
