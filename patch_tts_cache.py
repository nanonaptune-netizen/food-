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

start_str = '// Helper to generate & upload TTS audio to Cloudinary'
end_str = 'return null;\n}'

start_idx = content.find(start_str)
end_idx = content.find(end_str) + len(end_str)

new_func = '''// Helper to generate & upload TTS audio to Cloudinary for instant playback
async function generateTTSAudioUrl(text: string, language: string): Promise<string | null> {
  // Groq does not have a TTS endpoint. We return null, the client will rely on browser synthesis.
  return null;
}'''

if start_idx != -1 and end_idx != -1:
    with open("server.ts", "w") as f:
        f.write(content[:start_idx] + new_func + content[end_idx:])
    print("Patched generateTTSAudioUrl")
else:
    print("TTS bounds not found.")
