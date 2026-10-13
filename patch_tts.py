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

start_str = 'app.post("/api/tts", async (req, res) => {'
end_str = 'res.status(500).json({ error: err.message || "TTS error" });\n  }\n});'

start_idx = content.find(start_str)
end_idx = content.find(end_str) + len(end_str)

new_tts = '''app.post("/api/tts", async (req, res) => {
  // Groq does not currently support TTS. 
  // We return a 501 Not Implemented so the frontend gracefully falls back to browser SpeechSynthesis.
  res.status(501).json({ error: "Groq TTS not available. Defaulting to browser Speech Synthesis." });
});'''

if start_idx != -1 and end_idx != -1:
    with open("server.ts", "w") as f:
        f.write(content[:start_idx] + new_tts + content[end_idx:])
    print("Patched TTS")
else:
    print("TTS bounds not found.")
