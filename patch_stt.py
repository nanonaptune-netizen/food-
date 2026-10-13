# ===========================================================================
# DEPRECATED - DO NOT RUN.
#
# One-off migration script that has ALREADY been applied. Re-running it will
# silently undo later fixes, because it rewrites whole function bodies by
# string matching. patch_va.py in particular re-introduces the transcript
# doubling bug. Kept for historical reference only.
# ===========================================================================
import re

with open("server.ts", "r") as f:
    content = f.read()

# We will replace the entire STT body
start_str = 'app.post("/api/stt", upload.single("audio"), async (req: any, res) => {'
end_str = 'res.status(200).json({ transcript: "", error: "Could not transcribe audio from speech providers." });\n  } catch (err: any) {\n    console.error("STT endpoint error:", err);\n    res.status(200).json({ transcript: "", error: err.message });\n  }\n});'

start_idx = content.find(start_str)
end_idx = content.find(end_str) + len(end_str)

new_stt = '''app.post("/api/stt", upload.single("audio"), async (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const { language } = req.body;
    const groqKey = (process.env.GROQ_API_KEY || "").replace(/["'\\r\\n ]/g, "").trim();

    if (groqKey && groqKey !== "YOUR_GROQ_API_KEY") {
      try {
        const formData = new FormData();
        const audioBuffer = req.file.buffer;
        const mime = req.file.mimetype || "audio/webm";

        const fileObj = typeof File !== "undefined"
          ? new File([audioBuffer], "voice.webm", { type: mime })
          : new Blob([audioBuffer], { type: mime });

        formData.append("file", fileObj as any, "voice.webm");
        formData.append("model", "whisper-large-v3-turbo");

        if (language === "Hindi" || language === "hi-IN") {
          formData.append("language", "hi");
        } else if (language === "Kannada" || language === "kn-IN") {
          formData.append("language", "kn");
        } else {
          formData.append("language", "en");
        }

        const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqKey}`,
          },
          body: formData,
        });

        const contentType = groqRes.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const groqData: any = await groqRes.json();
          const text = groqData?.text?.trim();

          if (text && !isHallucinatedTranscript(text)) {
            console.log(`[STT Success] Groq Whisper transcribed (${language || 'en'}): "${text}"`);
            return res.json({ transcript: text, provider: "groq-whisper" });
          }
        }
      } catch (groqWhisperErr: any) {
        console.warn("Groq Whisper STT failed:", groqWhisperErr?.message);
      }
    }

    res.status(200).json({ transcript: "", error: "Could not transcribe audio using Groq." });
  } catch (err: any) {
    console.error("STT endpoint error:", err);
    res.status(200).json({ transcript: "", error: err.message });
  }
});'''

with open("server.ts", "w") as f:
    f.write(content[:start_idx] + new_stt + content[end_idx:])
print("Patched STT")
