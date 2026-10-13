# ===========================================================================
# DEPRECATED - DO NOT RUN.
#
# One-off migration script that has ALREADY been applied. Re-running it will
# silently undo later fixes, because it rewrites whole function bodies by
# string matching. patch_va.py in particular re-introduces the transcript
# doubling bug. Kept for historical reference only.
# ===========================================================================
import re

with open("src/components/VoiceAssistant.tsx", "r") as f:
    content = f.read()

# We need to add sessionPrefixRef
content = content.replace(
    'const transcriptRef = useRef<string>(\'\');',
    'const transcriptRef = useRef<string>(\'\');\n  const sessionPrefixRef = useRef<string>(\'\');'
)

# Modify toggleListening
old_toggle = '''const toggleListening = async () => {
    // 1. If AI is speaking -> INTERRUPT! Stop speech immediately and start listening to user
    if (isSpeakingRef.current || isSpeaking || activeAudioRef.current) {
      await startListeningProcess();
      return;
    }'''
new_toggle = '''const toggleListening = async () => {
    // 1. If AI is speaking -> INTERRUPT! Stop speech immediately and start listening to user
    if (isSpeakingRef.current || isSpeaking || activeAudioRef.current) {
      stopSpeaking();
      await startListeningProcess();
      return;
    }'''
content = content.replace(old_toggle, new_toggle)

# Modify startListeningProcess
old_start = '''const startListeningProcess = async () => {
    stopSpeaking();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setTranscript('');
    transcriptRef.current = '';'''
new_start = '''const startListeningProcess = async () => {
    stopSpeaking();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setTranscript('');
    transcriptRef.current = '';
    sessionPrefixRef.current = '';'''
content = content.replace(old_start, new_start)

# Modify stopListeningAndSend
old_stop = '''const stopListeningAndSend = async () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (vadIntervalRef.current) {'''
new_stop = '''const stopListeningAndSend = async () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    sessionPrefixRef.current = '';
    if (vadIntervalRef.current) {'''
content = content.replace(old_stop, new_stop)

# Modify onresult cleanText
old_clean = '''const cleanText = fullText
            .replace(/\\b(\\w+)(?:\\s+\\1\\b)+/gi, '$1')
            .replace(/([\\u0900-\\u0D7F]+)(?:\\s+\\1)+/gu, '$1')
            .trim();'''
new_clean = '''const cleanText = (sessionPrefixRef.current + " " + fullText)
            .replace(/\\b(\\w+)(?:\\s+\\1\\b)+/gi, '$1')
            .replace(/([\\u0900-\\u0D7F]+)(?:\\s+\\1)+/gu, '$1')
            .trim();'''
content = content.replace(old_clean, new_clean)

# Modify onend
old_onend = '''recognition.onend = async () => {
          const capturedText = transcriptRef.current?.trim();
          if (capturedText && isListeningRef.current) {
            stopListeningAndSend();
          } else if (isListeningRef.current) {
            // Keep listening alive if user is still in listening mode
            try {
              recognition.start();
            } catch {}
          }
        };'''
new_onend = '''recognition.onend = async () => {
          if (isListeningRef.current) {
            // Chrome abruptly ends recognition when it detects a long pause or no speech.
            // DO NOT automatically send just because onend fired; instead, accumulate and restart.
            // Auto-send ONLY occurs if the 3500ms silenceTimer fires.
            const capturedText = transcriptRef.current?.trim();
            if (capturedText) {
              sessionPrefixRef.current = capturedText + " ";
            }
            try {
              recognition.start();
            } catch {}
          }
        };'''
content = content.replace(old_onend, new_onend)

with open("src/components/VoiceAssistant.tsx", "w") as f:
    f.write(content)
print("Patched VoiceAssistant.tsx")
