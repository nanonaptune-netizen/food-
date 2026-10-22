import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Mic, MicOff, Send, AlertCircle, Loader2, Languages, Utensils, Upload, X, Volume2, VolumeX, Sparkles, ChevronDown, ChevronUp, Cpu, PhoneCall, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { VoiceInteraction, UserProfile } from '../types';
import ParticleBall from './ParticleBall';
import { RenderedMarkdown } from './RenderedMarkdown';
import { transcribeAudioInBrowser } from '../lib/clientWhisper';
import { stripEmojis, cleanSpeechTranscript, mergeTranscripts, isAffirmation, collapseRepetitions, normalizeRecognizedText } from '../utils/text';

// ---------------------------------------------------------------------------
// Browser memory
//
// The server keeps the conversation, but the browser used to keep only the
// conversation ID. So after a reload - or when a request lands on a different
// server instance - the assistant had no idea what was being discussed, and a
// follow-up like "how does it work?" came back as a description of the app.
//
// This stores the recent turns AND the subjects of the conversation in
// localStorage, so the topic is known on this device even when the server has
// nothing. It is per-browser, never shared, and cleared by "New conversation".
// ---------------------------------------------------------------------------
type BrowserMemoryTurn = { role: 'user' | 'assistant'; text: string; at: number };

type BrowserMemory = {
  conversationId: string;
  /** Most recent first, e.g. ["fssai", "licence"]. */
  topics: string[];
  turns: BrowserMemoryTurn[];
  updatedAt: number;
};

const BROWSER_MEMORY_KEY = 'vox_memory_v1';
const BROWSER_MEMORY_MAX_TURNS = 24;

function loadBrowserMemory(): BrowserMemory | null {
  try {
    const raw = localStorage.getItem(BROWSER_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : '',
      topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t: any) => typeof t === 'string').slice(-8) : [],
      turns: Array.isArray(parsed.turns)
        ? parsed.turns
            .filter((t: any) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
            .slice(-BROWSER_MEMORY_MAX_TURNS)
        : [],
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

function saveBrowserMemory(memory: BrowserMemory): void {
  try {
    localStorage.setItem(BROWSER_MEMORY_KEY, JSON.stringify({
      ...memory,
      turns: memory.turns.slice(-BROWSER_MEMORY_MAX_TURNS),
      updatedAt: Date.now(),
    }));
  } catch {
    // Private mode / quota: the server copy still keeps the conversation.
  }
}

function clearBrowserMemory(): void {
  try {
    localStorage.removeItem(BROWSER_MEMORY_KEY);
  } catch {}
}

function isHallucinatedText(text: string): boolean {
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

// Whisper decoder hints for the main page, matching the IVR vocabulary so the
// same words are recognised consistently on both surfaces.
const MAIN_PAGE_STT_HINTS: Record<string, string> = {
  Kannada: 'ಆಹಾರ ಸುರಕ್ಷತೆ ದೂರು. ಇಡ್ಲಿ, ದೋಸೆ, ಬಿರಿಯಾನಿ, ಅನ್ನ, ಸಾಂಬಾರ್, ಪಲ್ಯ, ಚಪಾತಿ, ಊಟ, ಚಹಾ, ಕಾಫಿ, ಹೋಟೆಲ್, ರೆಸ್ಟೋರೆಂಟ್, ತಿಂಡಿ. ಹುಳು, ಕೂದಲು, ಕಲುಷಿತ, ವಾಸನೆ, ಹಳಸಿದ, ಕೊಳಕು, ಹೊಟ್ಟೆ ನೋವು, ವಾಂತಿ, ಜಾಸ್ತಿ ಉಪ್ಪು. ನಿನ್ನೆ, ಇಂದು, ಸಂಜೆ, ರಾತ್ರಿ, ಬೆಳಗ್ಗೆ. ದೂರು ದಾಖಲಿಸಿ, FSSAI.',
  Hindi: 'खाद्य सुरक्षा शिकायत. इडली, डोसा, बिरयानी, चावल, सांभर, सब्जी, रोटी, चाय, कॉफी, होटल, रेस्टोरेंट, ढाबा. कीड़ा, बाल, मिलावट, बदबू, बासी, गंदा, पेट दर्द, उल्टी, ज्यादा नमक. कल, आज, शाम, रात, सुबह. शिकायत दर्ज, FSSAI.',
  English: 'Food safety complaint helpline. Idli, dosa, biryani, rice, sambar, curry, chapati, tea, coffee, hotel, restaurant, canteen. insect, hair, contaminated, foul smell, stale, unhygienic, stomach pain, vomiting, excess salt. yesterday, today, evening, night, morning. file complaint, FSSAI.',
};

export default function VoiceAssistant({ profile }: { profile: UserProfile }) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [transcript, setTranscript] = useState('');
  const [manualText, setManualText] = useState('');
  const [messages, setMessages] = useState<VoiceInteraction[]>([]);
  const [language, setLanguage] = useState<'English' | 'Hindi' | 'Kannada'>('English');
  const [isLoading, setIsLoading] = useState(false);
  const [complaintDraft, setComplaintDraft] = useState<{ query: string; markdownReport?: string; media: string[] } | null>(null);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(typeof window !== 'undefined' ? window.speechSynthesis : null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const transcriptRef = useRef<string>('');
  const accumulatedFinalRef = useRef<string>('');
  const sessionPrefixRef = useRef<string>('');
  // Text captured by the CURRENT recognition session. Chrome resets its own
  // result list on every start(), so this is rebuilt from scratch per session
  // and merged with sessionPrefixRef (earlier sessions of the same turn).
  const sessionTextRef = useRef<string>('');
  // True while the caller is driving the orb by voice, so listening is re-armed
  // automatically as soon as the assistant finishes speaking.
  const autoListenRef = useRef<boolean>(false);
  // Guards against dispatching the same utterance twice (energy detector and the
  // recogniser's own silence timer can both fire).
  const turnDispatchedRef = useRef<boolean>(false);
  // The current utterance's recorded chunks. Owned per recorder instance so a
  // late flush from a previous recorder cannot bleed into this turn.
  const chunkBufferRef = useRef<Blob[]>([]);
  const vizStreamRef = useRef<MediaStream | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const silenceTimerRef = useRef<any>(null);
  const isListeningRef = useRef<boolean>(false);
  const isSpeakingRef = useRef<boolean>(false);
  const isLoadingRef = useRef<boolean>(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<any>(null);
  const hasSpokenRef = useRef<boolean>(false);
  const lastSoundTimeRef = useRef<number>(0);
  // The server keys conversation memory on this id, so the assistant remembers
  // what was said even after a reload or a long conversation.
  const conversationIdRef = useRef<string>('');
  // Subjects already discussed, mirrored from the server so a reload keeps them.
  const topicsRef = useRef<string[]>([]);

  // High-performance response cache for repeated queries
  const queryCacheRef = useRef<Map<string, { response: string; spokenText: string; audioUrl?: string; isComplaintDraft?: boolean; markdownReport?: string }>>(new Map());

  const updateListeningState = (val: boolean) => {
    isListeningRef.current = val;
    setIsListening(val);
  };

  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);

  const updateSpeakingState = (val: boolean) => {
    isSpeakingRef.current = val;
    setIsSpeaking(val);
    if (!val) setPlayingMsgId(null);
  };

  // Bumped whenever playback is interrupted, so an in-flight TTS fetch from a
  // cancelled turn can never start playing late.
  const speakGenerationRef = useRef<number>(0);
  // Neural audio keyed by language+text, so replays and repeated prompts are instant.
  const neuralAudioCacheRef = useRef<Map<string, string>>(new Map());

  const stopSpeaking = () => {
    speakGenerationRef.current += 1;
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
        activeAudioRef.current.currentTime = 0;
        activeAudioRef.current = null;
      } catch {}
    }
    if (synthRef.current) {
      try {
        synthRef.current.cancel();
      } catch {}
    }
    activeUtteranceRef.current = null;
    setPlayingMsgId(null);
    updateSpeakingState(false);
  };

  // Initialize and load browser speech synthesis voices (e.g. Google Kannada, Google Hindi, Google English)
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      synthRef.current = window.speechSynthesis;
      const updateVoices = () => {
        try {
          const list = window.speechSynthesis.getVoices();
          if (list && list.length > 0) {
            voicesRef.current = list;
          }
        } catch (e) {
          console.warn("Could not load speech synthesis voices", e);
        }
      };
      updateVoices();
      window.speechSynthesis.onvoiceschanged = updateVoices;
    }
  }, []);

  // Auto-scroll chat stream to bottom whenever messages or loading state changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, transcript]);

  // Restore this device's conversation id, but do NOT invent one on first run.
  // Sending no id is what lets the server continue the caller's own thread on a
  // new device; sending an unknown id would look like a deliberate fresh start.
  useEffect(() => {
    const storedMemory = loadBrowserMemory();
    try {
      conversationIdRef.current =
        storedMemory?.conversationId || localStorage.getItem('vox_conversation_id') || '';
    } catch {
      conversationIdRef.current = storedMemory?.conversationId || '';
    }

    if (storedMemory) {
      topicsRef.current = storedMemory.topics;
      // Restore what was on screen: the subject is only useful if the caller can
      // see the conversation it came from.
      if (storedMemory.turns.length) {
        setMessages(storedMemory.turns.map((turn, index) => ({
          id: `restored-${index}`,
          text: turn.text,
          sender: turn.role,
          timestamp: turn.at,
        })));
      }
    }
  }, []);

  /**
   * Append a turn to browser memory. The topic list comes from the server, so the
   * browser and the server agree on what the conversation is about.
   */
  const rememberTurn = (
    role: 'user' | 'assistant',
    text: string,
    extra?: { topics?: string[]; conversationId?: string }
  ) => {
    if (!text || !text.trim()) return;
    const existing = loadBrowserMemory();
    const memory: BrowserMemory = existing || {
      conversationId: '',
      topics: [],
      turns: [],
      updatedAt: Date.now(),
    };

    memory.conversationId = extra?.conversationId || conversationIdRef.current || memory.conversationId;
    memory.turns = [...memory.turns, { role, text: text.trim(), at: Date.now() }].slice(-BROWSER_MEMORY_MAX_TURNS);
    if (extra?.topics && extra.topics.length) {
      memory.topics = extra.topics.slice(-8);
    }
    topicsRef.current = memory.topics;
    saveBrowserMemory(memory);
  };

  // Release the orb visualiser microphone when the page goes away.
  useEffect(() => {
    return () => {
      autoListenRef.current = false;
      if (vadIntervalRef.current) {
        clearInterval(vadIntervalRef.current);
        vadIntervalRef.current = null;
      }
      try {
        vizStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {}
      vizStreamRef.current = null;
      try {
        mediaRecorderRef.current?.state !== 'inactive' && mediaRecorderRef.current?.stop();
      } catch {}
      try {
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
          void audioContextRef.current.close();
        }
      } catch {}
      audioContextRef.current = null;
    };
  }, []);

  // How long a silence ends the caller's turn, and the hard ceiling on one turn.
  const TURN_SILENCE_MS = 2500;
  const MAX_TURN_MS = 20000;

  const stopEnergyTurnDetection = () => {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
  };

  // Record the caller's turn from the SINGLE persistent microphone stream.
  // The previous code opened a second microphone here (and only when the browser
  // had no speech recogniser), which is why the orb never saw real audio and why
  // no recording existed to transcribe accurately.
  const armUtteranceRecorder = () => {
    const stream = vizStreamRef.current;
    if (!stream || typeof MediaRecorder === 'undefined') {
      mediaRecorderRef.current = null;
      return;
    }
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch {}
      }
      // MediaRecorder cannot be restarted, so each turn gets a fresh one.
      let recorder: MediaRecorder;
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      } else {
        recorder = new MediaRecorder(stream);
      }
      // Each recorder owns its OWN buffer. stop() flushes a final
      // dataavailable asynchronously, and with a shared array that late flush
      // landed in the NEXT turn's recording - a cross-turn contamination that
      // put part of the previous utterance into the new one.
      const buffer: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) buffer.push(e.data);
      };
      chunkBufferRef.current = buffer;
      mediaRecorderRef.current = recorder;
      recorder.start(100);
    } catch (e) {
      console.warn('Utterance recorder unavailable; falling back to the browser transcript:', e);
      mediaRecorderRef.current = null;
    }
  };

  // Energy-based turn detection.
  // ROOT-CAUSE FIX (Kannada never sent / captions wrong): recognition.lang='kn-IN'
  // is silently ignored by desktop Chrome, so recognition.onresult often never
  // fires for Kannada. The old silence timer lived INSIDE onresult, so the turn
  // was never dispatched at all. Turn-taking is now driven by real microphone
  // energy, which works identically in all three languages.
  const startEnergyTurnDetection = () => {
    stopEnergyTurnDetection();
    const stream = vizStreamRef.current;
    if (!stream) return;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioCtx();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') void ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);

      const buf = new Float32Array(analyser.fftSize);
      const startedAt = Date.now();
      let spoken = false;
      let lastLoudAt = Date.now();

      vadIntervalRef.current = setInterval(() => {
        if (!isListeningRef.current) {
          stopEnergyTurnDetection();
          return;
        }

        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);

        const now = Date.now();
        if (rms > 0.012) {
          spoken = true;
          lastLoudAt = now;
          hasSpokenRef.current = true;
          lastSoundTimeRef.current = now;
        }

        // End of turn: the caller spoke and has now been quiet long enough.
        if (spoken && now - lastLoudAt >= TURN_SILENCE_MS) {
          stopEnergyTurnDetection();
          if (isListeningRef.current) void stopListeningAndSend();
          return;
        }
        // Safety net: never capture for ever.
        if (now - startedAt >= MAX_TURN_MS) {
          stopEnergyTurnDetection();
          if (isListeningRef.current) void stopListeningAndSend();
        }
      }, 100);
    } catch (e) {
      console.warn('Energy turn detection unavailable:', e);
    }
  };

  const stopAndTranscribeAudio = async (): Promise<string | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        return resolve(null);
      }

      // Pin the buffer to THIS recorder, so a later arm cannot swap it out
      // from under an in-flight transcription.
      const buffer = chunkBufferRef.current;

      recorder.onstop = async () => {
        if (!buffer || buffer.length === 0) return resolve(null);
        
        try {
          const audioBlob = new Blob(buffer, { type: recorder.mimeType || 'audio/webm' });
          if (audioBlob.size < 500) {
            return resolve(null); // Too short to be voice
          }

          // 1. Send recorded audio to high-accuracy server STT (/api/stt: Groq Whisper STT)
          try {
            const formData = new FormData();
            formData.append('audio', audioBlob, 'speech.webm');
            formData.append('language', language);
            // Seed Whisper with domain vocabulary for this language, so local food
            // items and hotel names are not "corrected" into unrelated words.
            formData.append('hint', MAIN_PAGE_STT_HINTS[language] || '');

            const res = await fetch('/api/stt', { method: 'POST', body: formData });
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
              const data = await res.json();
              if (res.ok && data.transcript && data.transcript.trim()) {
                return resolve(data.transcript.trim());
              }
            }
          } catch (serverErr) {
            console.warn("Server STT request notice:", serverErr);
          }

          // 2. Client-side fallback: In-browser Transformers.js Whisper
          try {
            const clientText = await transcribeAudioInBrowser(audioBlob, language);
            if (clientText && clientText.trim() && !isHallucinatedText(clientText)) {
              return resolve(clientText.trim());
            }
          } catch (clientErr) {
            console.warn("Client Whisper fallback notice:", clientErr);
          }

          resolve(null);
        } catch (e) {
          console.warn("STT transcription notice:", e);
          resolve(null);
        }
      };

      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });
  };

  const stopAndUploadAudio = async (): Promise<string | undefined> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        return resolve(undefined);
      }
      
      const buffer = chunkBufferRef.current;

      recorder.onstop = async () => {
        if (!buffer || buffer.length === 0) return resolve(undefined);
        const audioBlob = new Blob(buffer, { type: recorder.mimeType || 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioBlob);
        try {
          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          const data = await res.json();
          resolve(data.url);
        } catch (e) { 
          resolve(undefined); 
        }
      };
      try {
        recorder.stop();
      } catch {
        resolve(undefined);
      }
    });
  };

  // Re-configure speech recognition whenever language changes
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }

      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        // Continuous listening so natural pauses between Kannada / Hindi words do not abort recognition
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        
        // Exact BCP-47 language tag for Google Keyboard / Chrome speech engine
        if (language === 'Hindi') recognition.lang = 'hi-IN';
        else if (language === 'Kannada') recognition.lang = 'kn-IN';
        else recognition.lang = 'en-IN';

        recognition.onstart = () => {
          // Every start() is a brand-new recognition session with a fresh,
          // empty result list. Start this session's text fresh too; text from
          // earlier sessions of the same turn is held in sessionPrefixRef.
          sessionTextRef.current = '';
          updateListeningState(true);
          setMicError(null);
        };

        recognition.onresult = (event: any) => {
          // ROOT-CAUSE FIX (doubled words / "2 lines became 10 lines"):
          // rebuild the ENTIRE session transcript on every event instead of
          // appending to a running accumulator. Chrome re-delivers results it
          // has already reported -- especially after its automatic
          // onend -> start() restart -- so appending re-added the same words
          // again and again, doubling the caller's sentence each cycle.
          let finalText = '';
          let interimText = '';

          for (let i = 0; i < event.results.length; i++) {
            const item = event.results[i];
            if (!item || !item[0]) continue;
            if (item.isFinal) {
              finalText += item[0].transcript + ' ';
            } else {
              interimText += item[0].transcript;
            }
          }

          sessionTextRef.current = cleanSpeechTranscript((finalText + ' ' + interimText).trim());

          // Merge with what previous sessions of this same turn already heard.
          // mergeTranscripts overlaps the seam (up to 6 words) instead of
          // repeating it, so a re-delivered tail folds into one sentence.
          const combined = mergeTranscripts(sessionPrefixRef.current, sessionTextRef.current);
          accumulatedFinalRef.current = combined;

          if (combined) {
            transcriptRef.current = combined;
            setTranscript(combined);
            hasSpokenRef.current = true;
            lastSoundTimeRef.current = Date.now();

            // User barge-in: If user speaks while AI audio is active, stop AI speech immediately
            if (isSpeakingRef.current || activeAudioRef.current) {
              stopSpeaking();
            }

            // Silence Detection: After natural pause (3.5 seconds of silence) after speech, auto send
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
            }
            silenceTimerRef.current = setTimeout(() => {
              if (isListeningRef.current && transcriptRef.current.trim()) {
                stopListeningAndSend();
              }
            }, 3500);
          }
        };

        recognition.onerror = (event: any) => {
          console.warn('Browser speech recognition notice:', event.error);
          if (event.error === 'not-allowed') {
            setMicError("Microphone access blocked in browser. Please enable permissions.");
            updateListeningState(false);
          }
        };

        recognition.onend = async () => {
          if (isListeningRef.current) {
            // Chrome ends recognition by itself after a pause. Bank whatever this
            // session heard (seam-merged, never re-appended) and restart, so one
            // long utterance is never lost and never duplicated.
            sessionPrefixRef.current = mergeTranscripts(sessionPrefixRef.current, sessionTextRef.current);
            sessionTextRef.current = '';
            try {
              recognition.start();
            } catch {}
          }
        };

        recognitionRef.current = recognition;
      }
    } catch (err) {
      console.warn("Speech recognition initialization error", err);
    }
  }, [language]);

  // Primary 1st Priority TTS: Browser built-in Google Speech Synthesis (Instant, Fast, Zero latency)
  const speakWithBrowserGoogle = (text: string, lang: string): boolean => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return false;
    try {
      // NOTE: no speechSynthesis.cancel() here. The caller (speak) has already
      // stopped any previous audio, and cancelling again immediately before
      // speak() is the known Chrome pattern that leaves the utterance queued
      // twice / unreliably.
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }

      const cleanedForSpeech = stripEmojis(text);

      if (!cleanedForSpeech) return false;

      const utterance = new SpeechSynthesisUtterance(cleanedForSpeech);

      let targetLangCode = 'en-IN';
      let langPrefix = 'en';
      if (lang === 'Kannada') {
        targetLangCode = 'kn-IN';
        langPrefix = 'kn';
      } else if (lang === 'Hindi') {
        targetLangCode = 'hi-IN';
        langPrefix = 'hi';
      }

      utterance.lang = targetLangCode;
      utterance.rate = 1.35; // Authentic clear cadence
      utterance.pitch = 1.0;

      // Find best available voice on the device (prioritize Google keyboard / Android / native voice)
      const availableVoices = voicesRef.current.length > 0 
        ? voicesRef.current 
        : (window.speechSynthesis ? window.speechSynthesis.getVoices() : []);

      const lowerPrefix = langPrefix.toLowerCase();
      
      // Priority 1: Microsoft Edge Natural Voice (e.g. Microsoft Gagan/Sapna - Kannada, Swara/Madhur - Hindi, Neerja/Prabhat - English)
      let matchedVoice = availableVoices.find(v => {
        const vLang = v.lang.toLowerCase().replace('_', '-');
        const vName = v.name.toLowerCase();
        const matchesLang = vLang.startsWith(lowerPrefix) || vName.includes(lowerPrefix) || vName.includes(lang.toLowerCase());
        return matchesLang && (vName.includes('microsoft') || vName.includes('edge') || vName.includes('natural'));
      });

      // Priority 2: Google / Chrome voices for language
      if (!matchedVoice) {
        matchedVoice = availableVoices.find(v => {
          const vLang = v.lang.toLowerCase().replace('_', '-');
          const vName = v.name.toLowerCase();
          const matchesLang = vLang.startsWith(lowerPrefix) || vName.includes(lowerPrefix) || vName.includes(lang.toLowerCase());
          return matchesLang && vName.includes('google');
        });
      }

      // Priority 3: Any voice matching language prefix (kn, hi, en)
      if (!matchedVoice) {
        matchedVoice = availableVoices.find(v => {
          const vLang = v.lang.toLowerCase().replace('_', '-');
          const vName = v.name.toLowerCase();
          return vLang.startsWith(lowerPrefix) || vName.includes(lang.toLowerCase());
        });
      }

      // If requested language is Kannada or Hindi and device does NOT have a native voice for it,
      // return false so the assistant immediately uses the server neural voice (audioUrl / /api/tts)
      if ((langPrefix === 'kn' || langPrefix === 'hi') && !matchedVoice) {
        return false;
      }

      if (matchedVoice) {
        utterance.voice = matchedVoice;
      }

      activeUtteranceRef.current = utterance;

      utterance.onstart = () => updateSpeakingState(true);
      utterance.onend = () => {
        activeUtteranceRef.current = null;
        updateSpeakingState(false);
        setPlayingMsgId(null);
        resumeListeningAfterSpeech();
      };
      utterance.onerror = (e) => {
        console.warn("Browser speech synthesis error:", e);
        activeUtteranceRef.current = null;
        updateSpeakingState(false);
        setPlayingMsgId(null);
        resumeListeningAfterSpeech();
      };

      window.speechSynthesis.speak(utterance);
      return true;
    } catch (e) {
      console.warn("Browser SpeechSynthesis attempt notice:", e);
      return false;
    }
  };

  const speak = async (text: string, audioUrl?: string, messageId?: string) => {
    if (!text) return;

    // Toggle Mute: If clicking audio icon of the message that is CURRENTLY PLAYING, mute/stop it immediately!
    if (isSpeaking && messageId && playingMsgId === messageId) {
      stopSpeaking();
      return;
    }

    stopSpeaking();
    if (messageId) setPlayingMsgId(messageId);

    const textToSpeak = stripEmojis(text);
    if (!textToSpeak) return;

    // ROOT-CAUSE FIX ("you're not using any microsoft neural voices"): the
    // browser's built-in speechSynthesis used to be tier 1 and it claimed EVERY
    // English reply, so the robotic on-device voice spoke instead of the natural
    // Microsoft Edge neural voice. Neural audio is now tried first and the
    // on-device voice is a genuine last resort.
    const generation = ++speakGenerationRef.current;

    const playNeural = async (url: string): Promise<boolean> => {
      try {
        if (generation !== speakGenerationRef.current) return true; // turn cancelled
        const audio = new Audio(url);
        audio.onplay = () => updateSpeakingState(true);
        audio.onended = () => {
          // Clear the ref as well, otherwise it still points at the finished
          // element and resumeListeningAfterSpeech() would refuse to re-arm.
          activeAudioRef.current = null;
          updateSpeakingState(false);
          setPlayingMsgId(null);
          resumeListeningAfterSpeech();
        };
        audio.onerror = () => {
          activeAudioRef.current = null;
          updateSpeakingState(false);
          setPlayingMsgId(null);
          resumeListeningAfterSpeech();
        };
        activeAudioRef.current = audio;
        await audio.play();
        return true;
      } catch (e) {
        console.warn("Neural audio playback notice:", e);
        activeAudioRef.current = null;
        return false;
      }
    };

    // 1ST PRIORITY: neural audio already generated alongside the reply
    if (audioUrl && (await playNeural(audioUrl))) return;
    if (generation !== speakGenerationRef.current) return;

    // 2ND PRIORITY: neural voice from /api/tts (Edge), cached per language+text
    const neuralKey = `${language}:${textToSpeak}`;
    const cachedNeural = neuralAudioCacheRef.current.get(neuralKey);
    if (cachedNeural && (await playNeural(cachedNeural))) return;
    if (generation !== speakGenerationRef.current) return;

    updateSpeakingState(true); // show progress while synthesising
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToSpeak, language })
      });

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        const url = data?.audioUrl || (data?.audioBase64 ? `data:audio/wav;base64,${data.audioBase64}` : '');
        if (url) {
          // Keep the cache bounded: each entry is a ~25KB inline audio URL.
          if (neuralAudioCacheRef.current.size >= 40) {
            const oldestKey = neuralAudioCacheRef.current.keys().next().value;
            if (oldestKey) neuralAudioCacheRef.current.delete(oldestKey);
          }
          neuralAudioCacheRef.current.set(neuralKey, url);
          if (await playNeural(url)) return;
        }
      }
    } catch (err) {
      console.warn("Server TTS request notice:", err);
    }

    if (generation !== speakGenerationRef.current) return;

    // 3RD PRIORITY - last resort only: the on-device browser voice.
    console.warn("Neural voice unavailable - falling back to the on-device browser voice.");
    if (speakWithBrowserGoogle(textToSpeak, language)) return;

    updateSpeakingState(false);
    setPlayingMsgId(null);
  };

  const stopListeningAndSend = async () => {
    // Single-dispatch guard: the energy turn detector and the recogniser's own
    // silence timer can both fire for the same utterance. Without this, each
    // extra entry stopped an already-stopped recorder and fell through to the
    // browser text, adding another identical user message to the chat.
    if (!isListeningRef.current || turnDispatchedRef.current) return;
    turnDispatchedRef.current = true;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    hasSpokenRef.current = false;
    lastSoundTimeRef.current = 0;
    updateListeningState(false);

    try {
      recognitionRef.current?.stop();
    } catch (e) {
      console.warn(e);
    }

    const browserCaptured = transcriptRef.current.trim();
    accumulatedFinalRef.current = '';
    sessionPrefixRef.current = '';
    sessionTextRef.current = '';

    // 1ST PRIORITY: server Whisper on the recorded audio.
    // ROOT-CAUSE FIX ("Kannada: understand perfectly but captions are incorrect"):
    // the browser recogniser used to be the primary transcript AND the caption.
    // Desktop Chrome ignores recognition.lang='kn-IN', so the caption was
    // garbled while the server model had no trouble. Whisper is now the source
    // of truth for both the caption and the dispatched text.
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      setIsLoading(true);
      setTranscript('Recognising your speech...');
      const serverText = await stopAndTranscribeAudio();
      setIsLoading(false);

      // ROOT-CAUSE FIX ("I spoke 3 words, it showed them 3 to 7 times"): the
      // server transcript was dispatched completely raw, so whatever repetition
      // the recogniser produced went straight into the caption, the chat message
      // and the LLM prompt. Every path now goes through the same collapsing
      // (near-exact repeated copies included) before anything is shown or sent.
      const rawFinal = serverText && serverText.trim() && !isHallucinatedText(serverText.trim())
        ? serverText.trim()
        : browserCaptured;
      // Collapse repeats, then repair digit homophones ("I 8 food" -> "I ate food")
      // before it becomes the caption, the chat message or memory.
      const finalText = normalizeRecognizedText(collapseRepetitions(rawFinal)).trim();

      transcriptRef.current = '';
      if (finalText) {
        setTranscript(finalText);
        // Exactly ONE dispatch per utterance (the audio is never sent to a
        // second transcription path as well).
        handleSendMessage(finalText);
      } else {
        setTranscript('');
      }
      return;
    }

    // 2ND PRIORITY: no recording available - use the browser preview text.
    // This string is exactly where the "3 words shown 3 to 7 times" repeats came
    // from: Chrome replays the same audio across its silent end/restart cycles and
    // re-transcribes it slightly differently, so the same phrase accumulated. It
    // is collapsed here too, so no path can emit repetition.
    const fallbackText = normalizeRecognizedText(collapseRepetitions(browserCaptured)).trim();
    if (fallbackText && !isHallucinatedText(fallbackText)) {
      setTranscript(fallbackText);
      transcriptRef.current = '';
      handleSendMessage(fallbackText);
      return;
    }

    transcriptRef.current = '';
    setTranscript('');
  };

  // One shared microphone stream feeds the orb visualiser. It is opened once and
  // kept warm (the recogniser itself owns its own capture), so the sphere shows
  // the caller's real voice energy instead of synthetic waves.
  const ensureVizStream = async (): Promise<MediaStream | null> => {
    if (vizStreamRef.current && vizStreamRef.current.active) return vizStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      vizStreamRef.current = stream;
      setMicStream(stream);
      setMicError(null);
      return stream;
    } catch (e) {
      console.warn('Microphone access error:', e);
      setMicError('Microphone access is unavailable or blocked. Please check browser permissions or type your question below.');
      return null;
    }
  };

  /**
   * Start a brand-new conversation.
   *
   * The conversation id used to be created once and never rotated, so every
   * session appended to one endless thread and an unrelated topic kept the old
   * context. This closes the old thread server-side (so it cannot be re-adopted
   * as "latest"), rotates the id, and clears the on-screen history.
   */
  const startNewConversation = () => {
    const previousId = conversationIdRef.current;

    stopSpeaking();
    try {
      recognitionRef.current?.abort?.();
    } catch {}
    stopEnergyTurnDetection();
    updateListeningState(false);
    autoListenRef.current = false;
    turnDispatchedRef.current = true; // nothing may dispatch from the old thread

    const nextId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    conversationIdRef.current = nextId;
    try {
      localStorage.setItem('vox_conversation_id', nextId);
    } catch {}

    queryCacheRef.current.clear();
    // A new conversation must not inherit the old subject, on the server or here.
    // The id written above stays - it names the new, empty thread.
    clearBrowserMemory();
    topicsRef.current = [];
    setMessages([]);
    setTranscript('');
    transcriptRef.current = '';
    sessionPrefixRef.current = '';
    sessionTextRef.current = '';
    setComplaintDraft(null);

    // Best effort: mark the previous thread closed for this caller. The new
    // thread is already in place, so a failure here cannot break the chat.
    if (previousId) {
      fetch('/api/chat/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: previousId, profile }),
      }).catch(() => {});
    }
  };

  // Re-arm listening the instant the assistant finishes speaking, so a voice
  // conversation flows hands-free instead of stopping after every reply.
  const resumeListeningAfterSpeech = () => {
    if (!autoListenRef.current) return;
    window.setTimeout(() => {
      if (!autoListenRef.current) return;
      if (isListeningRef.current || isSpeakingRef.current || activeAudioRef.current) return;
      if (isLoadingRef.current) return;
      void startListeningProcess();
    }, 260);
  };

  const startListeningProcess = async () => {
    stopSpeaking();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setTranscript('');
    transcriptRef.current = '';
    accumulatedFinalRef.current = '';
    sessionPrefixRef.current = '';
    sessionTextRef.current = '';
    // A new listening turn: allow exactly one dispatch for it.
    turnDispatchedRef.current = false;
    // The caller is now driving the orb by voice: re-arm listening automatically
    // once the assistant stops speaking.
    autoListenRef.current = true;
    updateListeningState(true);

    // One persistent microphone stream now serves everything: the orb
    // visualiser, the utterance recording that gets transcribed by Whisper, and
    // the energy-based turn detector. (Previously micStream was only created
    // inside startRecording(), which is skipped whenever the native
    // SpeechRecognition exists - so on desktop Chrome the orb always received
    // null and animated synthetic waves.)
    const stream = await ensureVizStream();
    if (!stream) {
      updateListeningState(false);
      autoListenRef.current = false;
      return;
    }

    armUtteranceRecorder();
    startEnergyTurnDetection();

    // The browser recogniser is now only a live preview: it is called off as the
    // authoritative transcript because recognition.lang is silently ignored for
    // Kannada/Hindi on desktop Chrome, which produced the wrong captions.
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition && recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch (e: any) {
        // "already started" is harmless; the energy detector drives the turn, so
        // a failure here must not disable listening.
        if (!/already started|InvalidState/i.test(String(e?.message || e))) {
          console.warn("Native speech recognition preview notice (non-fatal):", e);
        }
      }
    }
  };

  const toggleListening = async () => {
    // 1. If AI is speaking -> INTERRUPT! Stop speech immediately and start listening to user
    if (isSpeakingRef.current || isSpeaking || activeAudioRef.current) {
      stopSpeaking();
      await startListeningProcess();
      return;
    }

    // 2. If listening -> User clicked mic again to stop! Stop listening & send immediately
    if (isListeningRef.current || isListening) {
      await stopListeningAndSend();
      return;
    }

    // 3. Otherwise -> Start listening
    await startListeningProcess();
  };

  const handleMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !complaintDraft) return;
    setIsUploadingMedia(true);
    try {
      const urls: string[] = [...complaintDraft.media];
      const fileArray = Array.from(files);
      for (const file of fileArray) {
        const formData = new FormData();
        formData.append('file', file as Blob);
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        urls.push(data.url);
      }
      setComplaintDraft({ ...complaintDraft, media: urls });
    } catch (e) { console.error(e); } finally { setIsUploadingMedia(false); }
  };

  const handleSendMessage = async (text: string) => {
    const queryText = text?.trim();
    if (!queryText) return;

    const userMsg: VoiceInteraction = { 
      id: Date.now().toString(), 
      text: queryText, 
      sender: 'user', 
      timestamp: Date.now() 
    };
    setMessages(prev => [...prev, userMsg]);
    // Store the caller's words in browser memory immediately, so a reload mid-turn
    // cannot lose the subject of the conversation.
    rememberTurn('user', queryText);
    setIsLoading(true);
    isLoadingRef.current = true;
    setTranscript('');
    transcriptRef.current = '';
    setManualText('');

    // Check for confirmation if a complaint was drafted.
    // ROOT-CAUSE FIX (false confirmations): the old test used
    // queryText.includes('ha'), which also matched "what", "have", "shall",
    // "harsh" -- so an ordinary question filed the complaint without the caller
    // ever confirming. isAffirmation only accepts a whole-utterance "yes".
    if (complaintDraft && isAffirmation(queryText)) {
      await finalizeComplaint();
      return;
    }

    // Remember more of the conversation so the assistant can follow context the
    // way a person does (it used to see only the last 8 entries).
    const recentHistory = messages.slice(-16).map(m => ({
      role: m.sender === 'user' ? 'user' : 'assistant',
      content: m.text
    }));

    const userTurnCount = messages.filter(m => m.sender === 'user').length + 1;

    // Check local response cache for immediate fast return on repeated queries
    const cacheKey = `${language}:${queryText.toLowerCase().trim()}`;
    const cachedResponse = queryCacheRef.current.get(cacheKey);
    // A cached reply is only valid when there is no conversation context yet.
    // Serving it mid-conversation returned the same context-free answer the
    // second time the caller repeated a question - which read as "the AI has no
    // idea what we were just talking about".
    if (cachedResponse && !complaintDraft && userTurnCount === 1) {
      const assistantMsg: VoiceInteraction = { 
        id: (Date.now() + 1).toString(), 
        text: cachedResponse.response, 
        sender: 'assistant', 
        timestamp: Date.now(),
        audioUrl: cachedResponse.audioUrl
      };
      setMessages(prev => [...prev, assistantMsg]);
      rememberTurn('assistant', assistantMsg.text);
      speak(cachedResponse.spokenText || cachedResponse.response, cachedResponse.audioUrl, assistantMsg.id);
      if (cachedResponse.isComplaintDraft) {
        setComplaintDraft({
          query: queryText,
          markdownReport: cachedResponse.markdownReport || cachedResponse.response,
          media: []
        });
      }
      setIsLoading(false);
      setTranscript('');
      return;
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: queryText, 
          history: recentHistory,
          language, 
          profile,
          chatCount: userTurnCount,
          conversationId: conversationIdRef.current || undefined,
          // Browser-side topic memory: lets the server resolve a follow-up even
          // when it has no stored turns (restart, or a different instance).
          clientTopics: topicsRef.current
        })
      });

      let data: any = {};
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        throw new Error('Server returned non-JSON response');
      }

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Server failed to respond');
      }
      
      const assistantReply = data.response || "I have received your query. How else may I assist you?";
      const spokenVoiceText = data.spokenText || assistantReply;

      // Adopt the server's conversation id, so memory keeps working even if the
      // server had to create one for us.
      if (data.conversationId && data.conversationId !== conversationIdRef.current) {
        conversationIdRef.current = String(data.conversationId);
        try {
          localStorage.setItem('vox_conversation_id', conversationIdRef.current);
        } catch {}
      }

      // Cache only context-free replies. A recall answer ("here is what you told
      // me") is specific to this conversation and must never be replayed.
      if (!data.recalled) {
        queryCacheRef.current.set(cacheKey, {
          response: assistantReply,
          spokenText: spokenVoiceText,
          audioUrl: data.audioUrl || undefined,
          isComplaintDraft: !!data.isComplaintDraft,
          markdownReport: data.markdownReport
        });
      }

      const assistantMsg: VoiceInteraction = { 
        id: (Date.now() + 1).toString(), 
        text: assistantReply, 
        sender: 'assistant', 
        timestamp: Date.now(),
        audioUrl: data.audioUrl || undefined
      };
      
      setMessages(prev => [...prev, assistantMsg]);
      // Mirror the server's topic ledger into the browser, so the subject of the
      // conversation is still known here after a reload.
      rememberTurn('assistant', assistantReply, {
        topics: Array.isArray(data.topics) ? data.topics : undefined,
        conversationId: conversationIdRef.current,
      });
      speak(spokenVoiceText, data.audioUrl, assistantMsg.id);

      // Detect if AI suggested a complaint
      if (data.isComplaintDraft) {
        setComplaintDraft({ 
          query: queryText, 
          markdownReport: data.markdownReport || assistantReply,
          media: [] 
        });
      }
    } catch (error: any) { 
      console.error("Chat error:", error);
      let errorText = "I'm having trouble connecting to the AI service. Please try again shortly.";
      if (language === 'Kannada') {
        errorText = "ಕ್ಷಮಿಸಿ, ಸೇವೆಯನ್ನು ಸಂಪರ್ಕಿಸುವಲ್ಲಿ ಅಡಚಣೆ ಉಂಟಾಗಿದೆ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಪುನಃ ಪ್ರಯತ್ನಿಸಿ.";
      } else if (language === 'Hindi') {
        errorText = "माफ़ कीजिए, सेवा से कनेक्ट करने में समस्या आ रही है। कृपया थोड़ी देर बाद पुनः प्रयास करें।";
      }

      const fallbackMsg: VoiceInteraction = {
        id: (Date.now() + 1).toString(),
        text: errorText,
        sender: 'assistant',
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, fallbackMsg]);
      speak(fallbackMsg.text);
    } finally { 
      setIsLoading(false); 
      isLoadingRef.current = false;
      setTranscript(''); 
    }
  };

  const finalizeComplaint = async () => {
    if (!complaintDraft) return;
    setIsLoading(true);
    const audioUrl = await stopAndUploadAudio();
    const complaintId = Date.now().toString();
    const complaintData = {
      id: complaintId,
      name: profile.name || 'Anonymous',
      phoneNumber: profile.phone || 'N/A',
      location: profile.location || '',
      query: complaintDraft.markdownReport || complaintDraft.query,
      status: 'pending',
      chatHistory: messages,
      mediaUrls: complaintDraft.media,
      audioUrl: audioUrl,
      createdAt: Date.now(),
      adminReply: '',
      adminReplyAt: null,
    };
    
    try {
      // Save directly to Turso database via server API
      const res = await fetch('/api/complaints/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(complaintData)
      });
      
      if (!res.ok) {
        throw new Error("Failed to register complaint");
      }
      
      // Only promise an audio review when audio was actually attached; on
      // browsers with the native speech recogniser there is no MediaRecorder,
      // so no clip exists and the old wording was simply untrue.
      const successText = audioUrl
        ? "Your report has been successfully registered along with your voice recording! Our support team will review it shortly. You can track progress anytime in Track Reports."
        : "Your report has been successfully registered! Our support team will review the details shortly. You can track progress anytime in Track Reports.";

      const successMsg: VoiceInteraction = {
        id: Date.now().toString(),
        text: successText,
        sender: 'assistant',
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, successMsg]);
      speak(successMsg.text);
      setComplaintDraft(null);
    } catch (e) { 
      console.error('Error finalizing complaint:', e); 
    } finally { 
      setIsLoading(false); 
    }
  };

  const hasMessages = messages.length > 0;
  const [isMinimized, setIsMinimized] = useState(false);

  // If user sends a new message while minimized, un-minimize automatically
  const showFullChat = hasMessages && !isMinimized;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col h-[calc(100vh-5.5rem)] max-w-lg mx-auto relative px-3 sm:px-4"
    >
      {/* Mic Error Banner */}
      {micError && (
        <div className="shrink-0 mb-2 bg-rose-50 border border-rose-200 text-rose-800 p-2.5 rounded-2xl flex items-start gap-2 text-xs shadow-sm z-30">
          <AlertCircle size={15} className="text-rose-500 shrink-0 mt-0.5" />
          <div className="flex-1 font-semibold">{micError}</div>
          <button onClick={() => setMicError(null)} className="text-rose-400 hover:text-rose-600">
            <X size={14} />
          </button>
        </div>
      )}

      <AnimatePresence mode="wait">
        {!showFullChat ? (
          /* ========================================================
             1. MAIN LANDING PAGE: Big 3D Sphere in Middle & assist heading
             ======================================================== */
          <motion.div
            key="landing-orb"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col items-center justify-between py-2 min-h-0"
          >
            {/* Massive PEPERO Font Style Wordmark: VOX-ASSIST */}
            <div className="shrink-0 pt-2 pb-0 text-center select-none flex justify-center">
              <h1 
                className="font-brand-display tracking-tighter text-white drop-shadow-md transform -skew-x-6 inline-block"
                style={{
                  width: '333.362px',
                  height: '108.0057px',
                  fontSize: '88px',
                  textAlign: 'left',
                  lineHeight: '70px',
                }}
              >
                VOX-ASSIST
              </h1>
            </div>

            {/* Language Switcher Bar */}
            <div className="shrink-0 flex justify-center gap-1.5 p-1 bg-white/20 backdrop-blur-xl rounded-2xl border border-white/30 shadow-md w-fit mx-auto mt-1 mb-2">
              {(['English', 'Hindi', 'Kannada'] as const).map((lang) => {
                const labelMap = { English: 'English', Hindi: 'हिन्दी', Kannada: 'ಕನ್ನಡ' };
                return (
                  <button
                    key={lang}
                    onClick={() => {
                      setLanguage(lang);
                      if (synthRef.current) synthRef.current.cancel();
                    }}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold tracking-wide transition-all ${
                      language === lang 
                        ? 'bg-white text-rose-600 shadow-md font-black scale-[1.02]' 
                        : 'text-white/80 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {labelMap[lang]}
                  </button>
                );
              })}
            </div>

            {/* Middle Big 3D Sphere */}
            <div className="flex-1 flex flex-col items-center justify-center py-2 space-y-3">
              <ParticleBall
                isListening={isListening}
                isSpeaking={isSpeaking}
                isLoading={isLoading}
                onClick={toggleListening}
                audioStream={micStream}
                compact={false}
              />

              <div className="text-center max-w-sm px-2">
                <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight drop-shadow-sm">
                  {isListening 
                    ? "Listening to your voice..." 
                    : isSpeaking 
                    ? "Speaking answer..." 
                    : isLoading 
                    ? "Thinking..." 
                    : "How can I help you today?"}
                </h2>
                <div className="mt-1 min-h-5">
                  <AnimatePresence mode="wait">
                    <motion.p 
                      key={transcript || (isListening ? 'listening' : 'idle')}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-white/95 font-bold text-xs tracking-wide px-2"
                    >
                      {transcript || (
                        isListening 
                          ? "Listening... Speak your query clearly" 
                          : ""
                      )}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>
            </div>

            {/* If there are existing messages and user minimized, show toggle to re-open chat */}
            {hasMessages && (
              <button
                onClick={() => setIsMinimized(false)}
                className="shrink-0 mb-2 px-4 py-2 bg-white/25 hover:bg-white/35 backdrop-blur-xl border border-white/40 text-white text-xs font-bold rounded-2xl flex items-center gap-1.5 shadow-md transition-all"
              >
                <span>View Chat History ({messages.length})</span>
                <ChevronUp size={14} />
              </button>
            )}
          </motion.div>
        ) : (
          /* ========================================================
             2. FULL CHAT STREAM: Expands and Fills Page on message send
             ======================================================== */
          <motion.div
            key="chat-full"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Top Compact Header: Small Sphere + Clear Eng/Hi/Kan + Corner Minimize Button */}
            <div className="shrink-0 flex items-center justify-between gap-2 p-2 bg-white/20 backdrop-blur-xl rounded-2xl border border-white/30 shadow-md z-10 mb-1">
              <div className="flex items-center gap-2">
                <ParticleBall
                  isListening={isListening}
                  isSpeaking={isSpeaking}
                  isLoading={isLoading}
                  onClick={toggleListening}
                  audioStream={micStream}
                  compact={true}
                />
                <div>
                  <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span className="font-brand-display text-base text-white tracking-tight">VOX-ASSIST</span>
                    {isListening && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />}
                  </h3>
                  <p className="text-[10px] text-white/90 font-bold truncate max-w-[110px] sm:max-w-[150px]">
                    {transcript || (
                      isListening 
                        ? "Listening..." 
                        : isSpeaking 
                        ? "Speaking..." 
                        : isLoading 
                        ? "Thinking..." 
                        : "Active Chat"
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {/* Clear Eng | Hi | Kan Language Switcher */}
                <div className="flex items-center gap-1 p-0.5 bg-white/20 rounded-xl border border-white/30">
                  {(['English', 'Hindi', 'Kannada'] as const).map((lang) => {
                    const labelMap = { English: 'Eng', Hindi: 'Hi', Kannada: 'Kan' };
                    return (
                      <button
                        key={lang}
                        onClick={() => {
                          setLanguage(lang);
                          if (synthRef.current) synthRef.current.cancel();
                        }}
                        className={`px-2 py-1 rounded-lg text-[10px] sm:text-xs font-bold transition-all ${
                          language === lang 
                            ? 'bg-white text-rose-600 shadow-sm' 
                            : 'text-white/80 hover:text-white hover:bg-white/15'
                        }`}
                        title={`Switch to ${lang}`}
                      >
                        {labelMap[lang]}
                      </button>
                    );
                  })}
                </div>

                {/* Start a fresh thread: rotates the conversation id so the
                    assistant stops seeing the previous topic. */}
                <button
                  onClick={startNewConversation}
                  className="p-1.5 rounded-xl bg-white/20 hover:bg-white/30 text-white transition-colors border border-white/30"
                  title="New conversation"
                  aria-label="New conversation"
                >
                  <Plus size={17} />
                </button>

                {/* Corner Minimize Button */}
                <button
                  onClick={() => setIsMinimized(true)}
                  className="p-1.5 rounded-xl bg-white/20 hover:bg-white/30 text-white transition-colors border border-white/30"
                  title="Minimize chat to main sphere"
                >
                  <ChevronDown size={17} />
                </button>
              </div>
            </div>

            {/* Main Full Chat Stream Container */}
            <div className="flex-1 overflow-y-auto py-2 space-y-3 custom-scrollbar flex flex-col pr-1 min-h-0 my-1">
              <AnimatePresence initial={false}>
                {messages.map((m) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 14, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                    className={`p-3.5 rounded-2xl max-w-[88%] shadow-lg transition-all ${
                      m.sender === 'user' 
                      ? 'bg-white/25 backdrop-blur-xl border border-white/35 text-white self-end shadow-black/10 rounded-br-xs' 
                      : 'bg-white/15 backdrop-blur-2xl border border-white/25 text-white self-start shadow-black/10 rounded-bl-xs'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        {m.sender === 'assistant' && (m.text.includes('# ') || m.text.includes('### ') || m.text.includes('| Parameter |') || m.text.includes('|---')) ? (
                          <RenderedMarkdown content={m.text} variant="glass" />
                        ) : (
                          <p className="text-xs sm:text-sm font-medium leading-relaxed whitespace-pre-wrap text-white">{m.text}</p>
                        )}
                      </div>
                      {m.sender === 'assistant' && (
                        <button 
                          onClick={() => {
                            if (isSpeaking && playingMsgId === m.id) {
                              stopSpeaking();
                            } else {
                              speak(m.text, m.audioUrl, m.id);
                            }
                          }}
                          className={`p-1.5 rounded-xl transition-all shrink-0 flex items-center gap-1 font-bold text-[10px] ${
                            isSpeaking && playingMsgId === m.id
                              ? 'bg-white text-rose-600 border border-white animate-pulse shadow-sm'
                              : 'text-white/80 hover:text-white bg-white/15 hover:bg-white/25 border border-white/20'
                          }`}
                          title={isSpeaking && playingMsgId === m.id ? "Mute / Stop Audio" : "Play Voice Answer"}
                        >
                          {isSpeaking && playingMsgId === m.id ? (
                            <>
                              <VolumeX size={15} className="text-rose-600" />
                              <span>Mute</span>
                            </>
                          ) : (
                            <Volume2 size={15} />
                          )}
                        </button>
                      )}
                    </div>
                    <div className={`text-[9px] font-bold uppercase tracking-wider mt-1.5 opacity-70 ${m.sender === 'user' ? 'text-right text-white/80' : 'text-left text-white/70'}`}>
                      {m.sender === 'user' ? (profile.name || 'You') : 'VOX-ASSIST'} • {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {isLoading && (
                <div className="flex items-center gap-2 bg-white/20 backdrop-blur-xl w-fit px-3.5 py-2.5 rounded-2xl border border-white/30 shadow-md text-white self-start">
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                  <span className="text-[11px] font-bold uppercase tracking-wider text-white">Generating answer...</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* BOTTOM CHAT & MIC BAR: 100% Glassmorphism, NO white background */}
      <div className="shrink-0 sticky bottom-0 bg-transparent pt-2 pb-1 space-y-2 z-20">
        {/* Complaint Drafting Box */}
        {complaintDraft && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-amber-50 border-2 border-amber-300 p-3 rounded-2xl space-y-2 shadow-md"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <AlertCircle size={16} className="text-amber-600" />
                <p className="text-xs font-bold text-amber-900 uppercase tracking-wide">Issue Report Drafted</p>
              </div>
              <button 
                onClick={() => mediaInputRef.current?.click()}
                disabled={isUploadingMedia}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-white text-amber-800 border border-amber-300 rounded-lg text-[10px] font-bold uppercase tracking-wider shadow-sm hover:bg-amber-50"
              >
                {isUploadingMedia ? <Loader2 className="animate-spin" size={12} /> : <Upload size={12} />} 
                Add Photos
              </button>
              <input 
                type="file" 
                ref={mediaInputRef} 
                className="hidden" 
                multiple 
                accept="image/*,.pdf" 
                onChange={handleMediaUpload}
              />
            </div>

            {complaintDraft.markdownReport && (
              <div className="bg-white/95 p-3 rounded-xl border border-amber-200 shadow-2xs max-h-56 overflow-y-auto">
                <RenderedMarkdown content={complaintDraft.markdownReport} />
              </div>
            )}

            {complaintDraft.media.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {complaintDraft.media.map((url, i) => (
                  <div key={i} className="w-10 h-10 rounded-lg bg-white border border-amber-200 overflow-hidden relative group">
                    <img src={url} className="w-full h-full object-cover" alt="attachment" />
                    <button 
                      onClick={() => setComplaintDraft({ ...complaintDraft, media: complaintDraft.media.filter((_, idx) => idx !== i) })}
                      className="absolute inset-0 bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-0.5">
              <p className="text-[10px] text-amber-800 font-medium">
                Say <span className="font-bold">"Yes"</span> or tap confirm to submit.
              </p>
              <button
                onClick={finalizeComplaint}
                disabled={isLoading}
                className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-colors shadow-sm"
              >
                Confirm Report
              </button>
            </div>
          </motion.div>
        )}

        {/* Glassmorphic Transparent Chat Input & Mic Form */}
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            if (manualText.trim()) {
              setIsMinimized(false);
              handleSendMessage(manualText);
            }
          }}
          className="flex items-center gap-2 bg-white/15 backdrop-blur-2xl p-1.5 sm:p-2 rounded-2xl border border-white/30 shadow-xl shadow-black/10 focus-within:border-white/60 focus-within:bg-white/20 transition-all"
        >
          <button
            type="button"
            onClick={() => {
              setIsMinimized(false);
              toggleListening();
            }}
            className={`p-2.5 rounded-xl transition-all ${
              isListening 
                ? 'bg-rose-500 text-white animate-pulse shadow-md shadow-rose-900/30' 
                : 'bg-white/20 hover:bg-white/30 text-white border border-white/30 active:scale-95'
            }`}
            title={isListening ? "Stop Listening" : "Start Voice Input"}
          >
            {isListening ? <MicOff size={18} /> : <Mic size={18} />}
          </button>

          <input
            type="text"
            placeholder={
              language === 'Kannada' 
                ? "ಇಲ್ಲಿ ಸಂದೇಶ ಟೈಪ್ ಮಾಡಿ..." 
                : language === 'Hindi' 
                ? "यहाँ अपना प्रश्न टाइप करें..." 
                : "Type your query or complaint here..."
            }
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            className="flex-1 bg-transparent px-3 py-2 text-xs sm:text-sm font-semibold text-white placeholder-white/65 focus:outline-none border-none"
          />

          <button
            type="submit"
            disabled={!manualText.trim() || isLoading}
            className="p-2.5 bg-white/25 hover:bg-white/35 active:scale-95 text-white rounded-xl transition-all disabled:opacity-40 border border-white/30 shadow-md flex items-center justify-center shrink-0 cursor-pointer"
          >
            <Send size={16} />
          </button>
        </form>

        {/* Identity Alert */}
        {!profile.name && (
          <div className="bg-white/15 backdrop-blur-md p-2 rounded-xl border border-white/25 flex items-center gap-2 shadow-sm text-white">
            <Sparkles size={14} className="text-white shrink-0" />
            <p className="text-[10px] text-white/90 font-medium">
              Tip: Set your name and phone in profile to personalize answers.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

