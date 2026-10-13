import React, { useState, useEffect, useRef } from 'react';
import { 
  Phone, 
  PhoneOff, 
  Mic, 
  MicOff,
  Volume2, 
  VolumeX, 
  ArrowLeft
} from 'lucide-react';
import { UserProfile } from '../types';
import { Link } from 'react-router-dom';
import { stripEmojis } from '../utils/text';
import { VoiceCapture, VoiceLang } from '../lib/voiceCapture';

interface IVRDialerProps {
  profile?: UserProfile;
}

// Domain hint passed to the STT engine so Kannada/Hindi words such as
// "ನಮಸ್ಕಾರ" / "ನಮಸ್ಕಾರ" (namaskara) and local hotel names are recognised
// correctly instead of being guessed as English.
const IVR_STT_HINTS: Record<VoiceLang, string> = {
  'kn-IN':
    'ನಮಸ್ಕಾರ, ಆಹಾರ ಸುರಕ್ಷತೆ, ದೂರು, ಹೋಟೆಲ್, ರೆಸ್ಟೋರೆಂಟ್, ಇಡ್ಲಿ, ದೋಸೆ, ಅನ್ನ, ಉಪ್ಪು ಜಾಸ್ತಿ, ಹುಳು, ಕೂದಲು, ಕಲುಷಿತ, ಹಾಳಾಗಿದೆ, ನಿನ್ನೆ, ಇಂದು, ದಯವಿಟ್ಟು.',
  'hi-IN':
    'नमस्ते, खाद्य सुरक्षा, शिकायत, होटल, रेस्टोरेंट, इडली, डोसा, चावल, नमक ज्यादा, कीड़ा, बाल, खराब, कल, आज, कृपया।',
  'en-IN':
    'Namaskara, food safety, complaint, hotel, restaurant, idli, dosa, rice, excess salt, insect, hair, spoiled, yesterday, today, please.',
};

// DTMF Frequencies for authentic telephone tones
const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
};

export const IVRDialer: React.FC<IVRDialerProps> = ({ profile }) => {
  // Call States
  const [callActive, setCallActive] = useState<boolean>(false);
  const [callDuration, setCallDuration] = useState<number>(0);
  const callActiveRef = useRef<boolean>(false);

  // IVR Dialogue State
  const [ivrStep, setIvrStep] = useState<string>('welcome');
  const [language, setLanguage] = useState<'kn-IN' | 'hi-IN' | 'en-IN'>('en-IN');
  const [isIvrSpeaking, setIsIvrSpeaking] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Press Start Call to begin');
  const [lastCallerSpoken, setLastCallerSpoken] = useState<string>('');
  const [lastIvrResponse, setLastIvrResponse] = useState<string>('');
  const [callerSpeaking, setCallerSpeaking] = useState<boolean>(false);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [notice, setNotice] = useState<string>('');

  // Voice Note Recording (Press 7 Feature)
  const [isBeepPlaying, setIsBeepPlaying] = useState<boolean>(false);
  const [isRecordingNote, setIsRecordingNote] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [audioNoteUrl, setAudioNoteUrl] = useState<string>('');

  // Extracted Complaint Data
  const [collectedData, setCollectedData] = useState<{
    cause?: string;
    location?: string;
    item?: string;
    audioNoteUrl?: string;
    language?: string;
  }>({});

  // Audio & WebRTC Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const callTimerRef = useRef<any>(null);
  const noteTimerRef = useRef<any>(null);

  // Persistent voice capture engine (mic + VAD + single-shot transcription)
  const voiceEngineRef = useRef<VoiceCapture | null>(null);

  // Conversation bookkeeping so every call is persisted with its full transcript
  const callIdRef = useRef<string>('');
  const turnIndexRef = useRef<number>(0);

  // Synchronized state refs for callbacks & listeners
  const languageRef = useRef<'kn-IN' | 'hi-IN' | 'en-IN'>('en-IN');
  const ivrStepRef = useRef<string>('welcome');
  const collectedDataRef = useRef<any>({});
  const dialogueHistoryRef = useRef<Array<{ role: 'user' | 'assistant'; text: string }>>([]);

  // Silence / Inactivity Timers
  const silenceTimerRef = useRef<any>(null);
  const initialGreetingActiveRef = useRef<boolean>(false);
  const processingSpeechRef = useRef<boolean>(false);
  const isIvrSpeakingRef = useRef<boolean>(false);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Keep refs synchronized
  const updateLanguage = (newLang: 'kn-IN' | 'hi-IN' | 'en-IN') => {
    languageRef.current = newLang;
    setLanguage(newLang);
  };

  const updateStep = (newStep: string) => {
    ivrStepRef.current = newStep;
    setIvrStep(newStep);
  };

  const updateCollectedData = (data: any) => {
    const merged = { ...collectedDataRef.current, ...data };
    collectedDataRef.current = merged;
    setCollectedData(merged);
  };

  // Web Audio Context initialization
  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        audioCtxRef.current = new AudioCtx();
      }
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  // Play realistic DTMF Tone
  const playDTMFTone = (digit: string) => {
    try {
      const ctx = getAudioContext();
      if (!ctx || !DTMF_FREQS[digit]) return;

      const [freq1, freq2] = DTMF_FREQS[digit];
      const now = ctx.currentTime;
      const duration = 0.12;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.frequency.value = freq1;
      osc2.frequency.value = freq2;

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + duration);
      osc2.stop(now + duration);
    } catch (e) {
      console.warn("DTMF tone error:", e);
    }
  };

  // Play authentic Telephone Beep Tone (Press 7 trigger)
  const playBeepSound = (): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const ctx = getAudioContext();
        if (!ctx) {
          resolve();
          return;
        }

        setIsBeepPlaying(true);
        const now = ctx.currentTime;
        const duration = 0.45;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, now);

        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + duration);

        setTimeout(() => {
          setIsBeepPlaying(false);
          resolve();
        }, duration * 1000);
      } catch (e) {
        setIsBeepPlaying(false);
        resolve();
      }
    });
  };

  // Clear all silence timers
  const clearSilenceTimers = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  // Reset and start silence watch when IVR finishes speaking (45s duration)
  const startSilenceWatch = () => {
    clearSilenceTimers();
    if (!callActiveRef.current || isRecordingNote) return;

    silenceTimerRef.current = setTimeout(() => {
      handleSilenceWarning();
    }, 45000); // 45 seconds before polite nudge
  };

  // 45s silence fired: speak warning in current language
  const handleSilenceWarning = () => {
    clearSilenceTimers();
    if (!callActiveRef.current) return;

    let warningText = "We could not hear your voice clearly. Please speak your food safety issue.";
    if (languageRef.current === 'kn-IN') {
      warningText = "ತಾವು ಹೇಳುವುದು ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸುತ್ತಿಲ್ಲ, ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ತಮ್ಮ ದೂರಿನ ಬಗ್ಗೆ ತಿಳಿಸಿ.";
    } else if (languageRef.current === 'hi-IN') {
      warningText = "आपकी आवाज़ स्पष्ट नहीं आ रही है, कृपया अपनी शिकायत फिर से बताएं।";
    }

    speakIVR(warningText, undefined, languageRef.current, () => {
      startSilenceWatch();
    }, true);
  };

  // Internal audio/speech stopper
  const stopSpeechOnly = () => {
    if (audioPlayerRef.current) {
      try {
        audioPlayerRef.current.pause();
        audioPlayerRef.current.currentTime = 0;
      } catch {}
    }
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    activeUtteranceRef.current = null;
    isIvrSpeakingRef.current = false;
    setIsIvrSpeaking(false);
    // Let the capture engine go back to normal sensitivity
    if (voiceEngineRef.current) voiceEngineRef.current.setIvrSpeaking(false);
  };

  // Interruption Handler: Stop IVR Speaking when user interrupts or hangs up
  const interruptSpeaking = () => {
    initialGreetingActiveRef.current = false;
    stopSpeechOnly();
  };

  // Browser Web Speech API TTS
  const speakWithBrowserGoogle = (text: string, langCode: string, onEnd: () => void): boolean => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return false;
    try {
      window.speechSynthesis.cancel();
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }

      const cleanText = stripEmojis(text);
      if (!cleanText) {
        onEnd();
        return false;
      }

      const prefix = langCode.slice(0, 2).toLowerCase();
      const voices = window.speechSynthesis.getVoices();

      // Priority 1: Natural / Edge / Indian voices
      let voiceMatch = voices.find(v => {
        const vLang = v.lang.toLowerCase().replace('_', '-');
        const vName = v.name.toLowerCase();
        const matchesLang = vLang.startsWith(prefix) || vName.includes(prefix);
        return matchesLang && (vName.includes('microsoft') || vName.includes('edge') || vName.includes('natural'));
      });

      // Priority 2: Google voice
      if (!voiceMatch) {
        voiceMatch = voices.find(v => {
          const vLang = v.lang.toLowerCase().replace('_', '-');
          const vName = v.name.toLowerCase();
          const matchesLang = vLang.startsWith(prefix) || vName.includes(prefix);
          return matchesLang && vName.includes('google');
        });
      }

      // Priority 3: Any voice matching target language
      if (!voiceMatch) {
        voiceMatch = voices.find(v => {
          const vLang = v.lang.toLowerCase().replace('_', '-');
          return vLang.startsWith(prefix);
        });
      }

      // If Kannada or Hindi and no native voice on device, prefer high-fidelity audio fallback
      if ((prefix === 'kn' || prefix === 'hi') && !voiceMatch) {
        return false;
      }

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = langCode;
      utterance.rate = 1.15;
      utterance.pitch = 1.0;
      if (voiceMatch) utterance.voice = voiceMatch;

      activeUtteranceRef.current = utterance;
      utterance.onend = () => {
        activeUtteranceRef.current = null;
        onEnd();
      };
      utterance.onerror = (e) => {
        console.warn("SpeechSynthesis notice:", e);
        activeUtteranceRef.current = null;
        onEnd();
      };

      window.speechSynthesis.speak(utterance);
      return true;
    } catch (e) {
      console.warn("Browser SpeechSynthesis attempt notice:", e);
      return false;
    }
  };

  // Play speech: server neural audioUrl -> Browser SpeechSynthesis -> /api/tts
  const speakIVR = async (
    text: string, 
    audioUrl?: string, 
    targetLang?: string,
    onFinish?: () => void,
    shouldStartListening: boolean = true
  ) => {
    stopSpeechOnly();
    clearSilenceTimers();

    // The previous utterance is fully handled the moment we start replying.
    // Keeping this false is what allows natural barge-in ("two people talking").
    processingSpeechRef.current = false;

    // Keep the microphone live while the assistant speaks, but raise the
    // trigger bar (echo-cancelled) so it cannot hear itself - and the caller
    // can still simply start talking to interrupt, like a real phone call.
    if (voiceEngineRef.current) voiceEngineRef.current.setIvrSpeaking(true);

    const effectiveLang = targetLang || languageRef.current;
    const cleanPrompt = stripEmojis(text);
    if (!cleanPrompt) {
      if (onFinish) onFinish();
      if (shouldStartListening && callActiveRef.current && !isRecordingNote) {
        startUserListening();
      }
      return;
    }

    isIvrSpeakingRef.current = true;
    setIsIvrSpeaking(true);
    setStatusMessage(text);
    setLastIvrResponse(text);

    let hasHandledEnd = false;
    const handleSpeechEnd = () => {
      if (hasHandledEnd) return;
      hasHandledEnd = true;
      isIvrSpeakingRef.current = false;
      setIsIvrSpeaking(false);
      if (voiceEngineRef.current) voiceEngineRef.current.setIvrSpeaking(false);

      if (onFinish) {
        onFinish();
      }
      if (shouldStartListening && callActiveRef.current && !isRecordingNote) {
        startUserListening();
        startSilenceWatch();
      }
    };

    // 1ST PRIORITY: server-synthesised neural audio from /api/ivr/dialogue
    if (audioUrl) {
      try {
        if (!audioPlayerRef.current) {
          audioPlayerRef.current = new Audio();
        }
        audioPlayerRef.current.src = audioUrl;
        audioPlayerRef.current.onended = handleSpeechEnd;
        audioPlayerRef.current.onerror = () => {
          // Fallback to browser synthesis if audio URL playback has an issue
          fallbackSpeech(cleanPrompt, effectiveLang, handleSpeechEnd);
        };
        await audioPlayerRef.current.play();
        return;
      } catch (err) {
        console.warn("Audio URL playback notice:", err);
      }
    }

    // 2ND PRIORITY: Browser Google Web Speech API
    const spokeWithBrowser = speakWithBrowserGoogle(cleanPrompt, effectiveLang, handleSpeechEnd);
    if (spokeWithBrowser) {
      return;
    }

    // 3RD PRIORITY: /api/tts fallback fetch
    fallbackSpeech(cleanPrompt, effectiveLang, handleSpeechEnd);
  };

  const fallbackSpeech = async (text: string, targetLang: string, onEnd: () => void) => {
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      onEnd();
      return;
    }

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanText, language: targetLang })
      });

      if (res.ok) {
        const data = await res.json();
        const audioSrc = data.audioUrl || (data.audioBase64 ? `data:audio/wav;base64,${data.audioBase64}` : null);
        if (audioSrc) {
          if (!audioPlayerRef.current) {
            audioPlayerRef.current = new Audio();
          }
          audioPlayerRef.current.src = audioSrc;
          audioPlayerRef.current.onended = () => onEnd();
          audioPlayerRef.current.onerror = () => onEnd();
          await audioPlayerRef.current.play();
          return;
        }
      }
    } catch (apiErr) {
      console.warn("Fallback /api/tts request notice:", apiErr);
    }

    // Direct browser synthesis attempt
    try {
      if (window.speechSynthesis) {
        const utt = new SpeechSynthesisUtterance(cleanText);
        utt.lang = targetLang;
        utt.onend = () => onEnd();
        utt.onerror = () => onEnd();
        window.speechSynthesis.speak(utt);
        return;
      }
    } catch {}

    onEnd();
  };

  // ---------------------------------------------------------------------------
  // Voice capture engine
  // Persistent microphone + real voice-activity detection + ONE dispatch per
  // utterance. The mic stays open for the whole call, so it never blinks
  // on/off between turns, and every utterance is transcribed by the server with
  // the language FORCED (Kannada/Hindi included) instead of silently falling
  // back to the device language (English).
  // ---------------------------------------------------------------------------

  const transcribeUtterance = async (audio: Blob, lang: VoiceLang): Promise<string> => {
    // 1) Server speech-to-text (Groq Whisper large-v3-turbo) with the
    //    language forced, so Kannada is never transcribed as English.
    try {
      const form = new FormData();
      form.append('audio', audio, 'utterance.webm');
      form.append('language', lang);
      form.append('hint', IVR_STT_HINTS[lang] || '');
      const res = await fetch('/api/stt', { method: 'POST', body: form });
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        const text = String(data?.transcript || '').trim();
        if (text) return text;
      } else {
        console.warn('Server STT unavailable:', res.status);
      }
    } catch (err) {
      console.warn('Server STT request failed:', err);
    }

    // 2) On-device Whisper (free, runs in the browser, no API credits).
    //    Keeps the helpline hearing callers even when the cloud speech keys are
    //    out of quota. Loaded lazily so it costs nothing until it is needed.
    try {
      setNotice(
        lang === 'kn-IN'
          ? 'ಧ್ವನಿಯನ್ನು ಗುರುತಿಸುತ್ತಿದೆ...'
          : lang === 'hi-IN'
          ? 'आवाज़ पहचान रहा है...'
          : 'Recognising your speech...'
      );
      const { transcribeAudioInBrowser } = await import('../lib/clientWhisper');
      const onDeviceText = await transcribeAudioInBrowser(audio, lang);
      if (onDeviceText && onDeviceText.trim()) return onDeviceText.trim();
    } catch (err) {
      console.warn('On-device speech recognition unavailable:', err);
    }

    return '';
  };

  const getVoiceEngine = (): VoiceCapture => {
    if (!voiceEngineRef.current) {
      voiceEngineRef.current = new VoiceCapture({
        getLanguage: () => languageRef.current,
        transcribe: transcribeUtterance,
        onUtterance: (transcript) => {
          if (!callActiveRef.current || isRecordingNote) return;
          clearSilenceTimers();

          if (processingSpeechRef.current) {
            // A reply is already being composed - never answer one sentence twice.
            setNotice('One moment please, I am answering...');
            return;
          }

          setNotice('');
          setLastCallerSpoken(transcript);
          processingSpeechRef.current = true;
          handleCallerSpeech(transcript);
        },
        onStateChange: (s) => {
          setIsListening(s.capturing);
          setCallerSpeaking(s.callerSpeaking);
          setMicLevel(s.level);
        },
        onSpeechStart: () => {
          // Barge-in: the caller can simply start talking over the assistant,
          // exactly like interrupting a real person on a phone call.
          if (isIvrSpeakingRef.current) interruptSpeaking();
        },
        onNotice: (msg) => setNotice(msg),
        endSilenceMs: 900,   // answer almost immediately after the caller stops
        maxUtteranceMs: 20000,
        minUtteranceMs: 250, // short answers like "ಹೌದು" / "yes" must count
        minBlobBytes: 700,
        allowBargeIn: true,
        bargeInHoldMs: 520,
      });
    }
    return voiceEngineRef.current;
  };

  // Start / resume listening. The microphone is opened once per call and kept
  // warm, so the recogniser is ready the instant the assistant stops speaking.
  const startUserListening = () => {
    if (!callActiveRef.current || isRecordingNote) return;
    processingSpeechRef.current = false;
    const engine = getVoiceEngine();
    engine.setIvrSpeaking(isIvrSpeakingRef.current);

    if (engine.isRunning) {
      engine.resume();
      return;
    }

    engine.start().then((ok) => {
      if (!callActiveRef.current) return;
      if (!ok) {
        setNotice('Microphone blocked - tap the mic button and allow access.');
        return;
      }
      setNotice('');
      startSilenceWatch();
    });
  };

  // Pause listening without closing the microphone
  const stopUserListening = () => {
    if (voiceEngineRef.current) voiceEngineRef.current.pause();
    setCallerSpeaking(false);
    setIsListening(false);
  };

  // Release the microphone completely (hang up / unmount)
  const releaseVoiceEngine = () => {
    if (voiceEngineRef.current) {
      voiceEngineRef.current.dispose();
      voiceEngineRef.current = null;
    }
    setCallerSpeaking(false);
    setMicLevel(0);
    setIsListening(false);
  };

  // Play Language Prompts 1, 2, 3 at startup
  const playTrilingualGreeting = async () => {
    initialGreetingActiveRef.current = true;
    clearSilenceTimers();

    const options = [
      { text: "ಆಹಾರ ಸುರಕ್ಷತಾ ಸಹಾಯವಾಣಿ. ಕನ್ನಡಕ್ಕಾಗಿ 1 ಒತ್ತಿ.", lang: "kn-IN" },
      { text: "खाद्य सुरक्षा हेल्पलाइन। हिंदी के लिए 2 दबाएँ।", lang: "hi-IN" },
      { text: "Food Safety Helpline. For English, press 3.", lang: "en-IN" }
    ];

    for (let i = 0; i < options.length; i++) {
      if (!initialGreetingActiveRef.current || !callActiveRef.current) break;
      const opt = options[i];

      await new Promise<void>((resolve) => {
        speakIVR(opt.text, undefined, opt.lang, () => {
          resolve();
        }, false);
      });

      if (i < options.length - 1 && initialGreetingActiveRef.current && callActiveRef.current) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (initialGreetingActiveRef.current && callActiveRef.current) {
      initialGreetingActiveRef.current = false;
      startUserListening();
      startSilenceWatch();
    }
  };

  // Start Call Flow
  const startCall = async () => {
    getAudioContext();
    clearSilenceTimers();
    dialogueHistoryRef.current = [];
    callActiveRef.current = true;
    setCallActive(true);
    setCallDuration(0);
    updateStep('welcome');
    updateCollectedData({});
    setAudioNoteUrl('');
    setLastCallerSpoken('');
    setLastIvrResponse('');
    setNotice('');
    setCallerSpeaking(false);
    processingSpeechRef.current = false;

    // New conversation id: every turn of this call is persisted in the database
    callIdRef.current = `IVR-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
    turnIndexRef.current = 0;

    // Open the microphone ONCE and keep it open for the whole call, so the mic
    // never has to be re-armed (no on/off blinking) and is instant between turns.
    const engine = getVoiceEngine();
    engine.setIvrSpeaking(true);
    const micReady = await engine.start();
    if (!micReady) {
      setNotice('Microphone blocked - tap the mic button and allow access.');
    }
    engine.setIvrSpeaking(true);

    // Register the call in the database (caller identity + language + transcript)
    fetch('/api/ivr/call/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callId: callIdRef.current,
        profile,
        language: languageRef.current,
      }),
    }).catch(() => {});

    // Call timer
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    callTimerRef.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);

    // Start trilingual greeting
    playTrilingualGreeting();
  };

  // Hang Up Call
  const endCall = () => {
    initialGreetingActiveRef.current = false;
    callActiveRef.current = false;
    isIvrSpeakingRef.current = false;
    stopSpeechOnly();
    stopUserListening();
    releaseVoiceEngine();
    clearSilenceTimers();
    processingSpeechRef.current = false;

    if (callTimerRef.current) clearInterval(callTimerRef.current);
    if (noteTimerRef.current) clearInterval(noteTimerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch {}
    }

    // Close the call record in the database with the full transcript
    if (callIdRef.current) {
      fetch('/api/ivr/call/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId: callIdRef.current,
          language: languageRef.current,
          collectedData: collectedDataRef.current,
          history: dialogueHistoryRef.current,
        }),
      }).catch(() => {});
    }

    dialogueHistoryRef.current = [];
    setCallActive(false);
    setIsListening(false);
    setIsRecordingNote(false);
    setCallerSpeaking(false);
    setMicLevel(0);
    setStatusMessage('Call Ended');
  };

  // Handle DTMF Dialpad Press
  const handleKeypadPress = async (digit: string) => {
    initialGreetingActiveRef.current = false;
    playDTMFTone(digit);
    stopSpeechOnly();
    clearSilenceTimers();
    // Drop any half-captured speech so a keypad press can never be mixed with it
    if (voiceEngineRef.current) voiceEngineRef.current.abortCurrent();
    processingSpeechRef.current = false;

    // Immediately reflect selected language
    if (digit === '1') {
      updateLanguage('kn-IN');
      setNotice('ಕನ್ನಡ ಆಯ್ಕೆ ಮಾಡಲಾಗಿದೆ - ಈಗ ಮಾತನಾಡಿ.');
    } else if (digit === '2') {
      updateLanguage('hi-IN');
      setNotice('हिंदी चुना गया - अब बोलिए।');
    } else if (digit === '3') {
      updateLanguage('en-IN');
      setNotice('English selected - please speak now.');
    }

    // The caller picked a language: make sure the mic is live straight away so
    // the first sentence is never missed while the prompt is still playing.
    const engine = getVoiceEngine();
    if (!engine.isRunning) {
      void engine.start();
    }

    sendIVRInput({ digits: digit });
  };

  // Handle Caller Speech
  const handleCallerSpeech = (text: string) => {
    if (!text || !text.trim()) return;
    clearSilenceTimers();
    sendIVRInput({ message: text });
  };

  // Central IVR State Transition Caller
  const sendIVRInput = async ({ 
    digits, 
    message, 
    audioNoteUrl: inputAudioUrl, 
    isVoiceNote 
  }: { 
    digits?: string; 
    message?: string; 
    audioNoteUrl?: string; 
    isVoiceNote?: boolean; 
  }) => {
    clearSilenceTimers();
    setStatusMessage('One moment...');

    const activeLanguage = languageRef.current;
    const activeStep = ivrStepRef.current;
    const currentData = collectedDataRef.current;

    const userTurnText = message || (digits ? `Pressed ${digits}` : (isVoiceNote ? 'Attached voice note' : ''));
    if (userTurnText) {
      dialogueHistoryRef.current.push({ role: 'user', text: userTurnText });
    }
    turnIndexRef.current += 1;

    try {
      const response = await fetch('/api/ivr/dialogue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          digits,
          step: activeStep,
          language: activeLanguage,
          history: dialogueHistoryRef.current,
          profile,
          collectedData: currentData,
          audioNoteUrl: inputAudioUrl,
          isVoiceNote,
          callId: callIdRef.current,
          turnIndex: turnIndexRef.current
        })
      });

      const data = await response.json();
      setStatusMessage('Connected');
      if (!data) return;

      if (data.text) {
        dialogueHistoryRef.current.push({ role: 'assistant', text: data.text });
      }

      const nextLang = (data.language || activeLanguage) as 'kn-IN' | 'hi-IN' | 'en-IN';
      updateLanguage(nextLang);

      if (data.collectedData) {
        updateCollectedData(data.collectedData);
      }
      if (data.nextStep) {
        updateStep(data.nextStep);
      }

      // Handle Press 7 Flow (Voice Note Recording)
      if (data.nextStep === 'ready_for_beep' || digits === '7') {
        await speakIVR(data.text, data.audioUrl, nextLang, async () => {
          setTimeout(async () => {
            await playBeepSound();
            startVoiceNoteRecording();
          }, 200);
        }, false);
        return;
      }

      // Speak IVR response and then immediately enable listening in target language
      if (data.text) {
        speakIVR(data.text, data.audioUrl, nextLang, undefined, true);
      }
    } catch (err) {
      console.error("IVR interaction failed:", err);
      setStatusMessage('Connected');
      setNotice('Connection hiccup - please say that again.');
      processingSpeechRef.current = false;
      if (voiceEngineRef.current) voiceEngineRef.current.setIvrSpeaking(false);
      // If error occurs, ensure user listening is restored
      if (callActiveRef.current) {
        startUserListening();
      }
    }
  };

  // Start High-Fidelity Recording for Voice Note (Press 7)
  const startVoiceNoteRecording = async () => {
    try {
      clearSilenceTimers();
      stopUserListening();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach((t) => t.stop());
        await uploadVoiceNote(audioBlob);
      };

      mediaRecorder.start(250);
      setIsRecordingNote(true);
      setRecordingSeconds(0);

      if (noteTimerRef.current) clearInterval(noteTimerRef.current);
      noteTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Could not access microphone for voice note:", err);
    }
  };

  // Stop Recording Voice Note
  const stopVoiceNoteRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (noteTimerRef.current) clearInterval(noteTimerRef.current);
    setIsRecordingNote(false);
  };

  // Transcribe recorded voice with STT, upload audio file, and react in IVR
  const uploadVoiceNote = async (audioBlob: Blob) => {
    try {
      setStatusMessage('Processing your recorded voice note...');

      // 1. Transcribe the recorded voice with STT
      let transcript = '';
      try {
        const sttForm = new FormData();
        sttForm.append('audio', audioBlob, 'recording.webm');
        const langName = languageRef.current === 'kn-IN' ? 'Kannada' : (languageRef.current === 'hi-IN' ? 'Hindi' : 'English');
        sttForm.append('language', langName);

        const sttRes = await fetch('/api/stt', { method: 'POST', body: sttForm });
        if (sttRes.ok) {
          const sttData = await sttRes.json();
          transcript = sttData.transcript?.trim() || '';
        }
      } catch (sttErr) {
        console.warn("STT on recorded voice note notice:", sttErr);
      }

      // 2. Upload to Cloudinary for permanent MP3 audio evidence link
      let uploadedUrl = '';
      try {
        const uploadForm = new FormData();
        uploadForm.append('audio', audioBlob, 'voice_note.webm');
        const uploadRes = await fetch('/api/upload-audio', { method: 'POST', body: uploadForm });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          uploadedUrl = uploadData.url || '';
        }
      } catch (upErr) {
        console.warn("Upload audio notice:", upErr);
      }

      if (transcript) {
        setLastCallerSpoken(transcript);
      }
      if (uploadedUrl) {
        setAudioNoteUrl(uploadedUrl);
      }

      const updated = { 
        ...collectedDataRef.current, 
        audioNoteUrl: uploadedUrl || collectedDataRef.current.audioNoteUrl,
        cause: transcript || collectedDataRef.current.cause
      };
      updateCollectedData(updated);

      // React properly to what the caller said in their voice note
      sendIVRInput({
        message: transcript || "Voice note recorded and attached.",
        audioNoteUrl: uploadedUrl,
        isVoiceNote: true
      });
    } catch (err) {
      console.error("Voice note handling error:", err);
      sendIVRInput({
        message: "Voice note recorded.",
        isVoiceNote: true
      });
    }
  };

  // Format seconds to mm:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      endCall();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  return (
    <div className="max-w-md mx-auto px-4 py-2 flex flex-col items-center justify-between min-h-[calc(100vh-6rem)]">
      {/* Top Floating Back Button */}
      <div className="w-full flex items-center justify-between pt-1 pb-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-white/20 hover:bg-white/30 backdrop-blur-xl border border-white/30 px-3.5 py-1.5 rounded-full shadow-md transition-all active:scale-95"
        >
          <ArrowLeft size={14} /> Back
        </Link>
        {callActive && (
          <div className="flex items-center gap-2 px-3 py-1 bg-white/20 backdrop-blur-xl border border-white/30 rounded-full text-white text-xs font-bold shadow-md">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
            <span>{formatTime(callDuration)}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/30 uppercase font-black">
              {language === 'kn-IN' ? 'ಕನ್ನಡ' : language === 'hi-IN' ? 'हिंदी' : 'ENG'}
            </span>
          </div>
        )}
      </div>

      {/* Huge Header: HELPLINE */}
      <div className="pt-2 pb-2 text-center select-none">
        <h1 className="font-brand-display text-6xl sm:text-7xl md:text-8xl tracking-tighter text-white drop-shadow-md transform -skew-x-6 leading-none inline-block">
          HELPLINE
        </h1>
        <p className="text-white/80 font-bold text-xs tracking-wider uppercase mt-1 drop-shadow-sm">
          Toll-Free 1800-FOOD-VOX
        </p>
      </div>

      {/* Transparent Glass Status Pill */}
      <div className="w-full max-w-xs my-1 text-center">
        <div className="bg-white/15 backdrop-blur-2xl border border-white/25 rounded-2xl px-4 py-2.5 shadow-lg text-white">
          {isBeepPlaying ? (
            <div className="text-amber-300 font-bold text-xs flex items-center justify-center gap-1.5">
              <span>🔔</span> Beep Tone Playing...
            </div>
          ) : isRecordingNote ? (
            <div className="text-rose-300 font-bold text-xs flex items-center justify-center gap-1.5 animate-pulse">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-400" />
              Recording Voice Note ({formatTime(recordingSeconds)}) — Press # to Stop
            </div>
          ) : isIvrSpeaking ? (
            <div className="space-y-1.5">
              <div className="text-amber-200 font-medium text-xs flex items-center justify-center gap-1.5">
                <Volume2 size={15} className="animate-pulse text-amber-300 shrink-0" />
                <span className="truncate">
                  {language === 'kn-IN' ? 'ಮಾತನಾಡುತ್ತಿದೆ... (ಮಾತನಾಡಿ, ನಿಲ್ಲಿಸುತ್ತೇನೆ)' : language === 'hi-IN' ? 'बोल रहा है... (बोलिए, रुक जाऊँगा)' : 'Speaking... (just start talking to interrupt)'}
                </span>
              </div>
              {isListening && (
                <div className="text-[10px] text-emerald-300/90 font-semibold flex items-center justify-center gap-1">
                  <Mic size={11} className="text-emerald-400 shrink-0" />
                  <span>Mic live</span>
                </div>
              )}
            </div>
          ) : callerSpeaking ? (
            <div className="space-y-1.5">
              <div className="text-sky-200 font-bold text-xs flex items-center justify-center gap-1.5">
                <Mic size={16} className="text-sky-300 shrink-0" />
                <span>
                  {language === 'kn-IN' ? 'ಕೇಳಿಸುತ್ತಿದೆ... ಮಾತನಾಡಿ' : language === 'hi-IN' ? 'सुन रहा हूँ... बोलिए' : 'I am listening... go ahead'}
                </span>
              </div>
              <div className="h-1 w-full rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all duration-150"
                  style={{ width: `${Math.min(100, Math.round(micLevel * 140))}%` }}
                />
              </div>
            </div>
          ) : isListening ? (
            <div className="text-emerald-300 font-semibold text-xs flex items-center justify-center gap-1.5">
              <Mic size={16} className="text-emerald-400 shrink-0" />
              <span>
                {language === 'kn-IN' ? 'ಧ್ವನಿ ಆಲಿಸುತ್ತಿದೆ... ಮಾತನಾಡಿ' : language === 'hi-IN' ? 'सुन रहा है... बोलिए' : 'Listening... speak any time'}
              </span>
            </div>
          ) : (
            <div className="text-white/80 text-xs font-medium truncate">
              {notice
                ? notice
                : callActive
                ? 'Awaiting keypad press or speech'
                : 'Press Start Call below'}
            </div>
          )}
          {callActive && notice && (isIvrSpeaking || callerSpeaking || isListening) && (
            <div className="mt-1 text-[10px] text-amber-200/90 font-semibold truncate">{notice}</div>
          )}
        </div>
      </div>

      {/* Live Conversation Transcript Card */}
      {callActive && (lastIvrResponse || lastCallerSpoken) && (
        <div className="w-full max-w-xs my-1.5 bg-black/30 backdrop-blur-xl border border-white/20 rounded-2xl p-3 shadow-lg text-left space-y-1.5 transition-all text-xs">
          {lastIvrResponse && (
            <div className="text-white/95 flex items-start gap-1.5">
              <span className="shrink-0 text-amber-300 font-black">🤖 IVR:</span>
              <span className="line-clamp-2 leading-relaxed">{lastIvrResponse}</span>
            </div>
          )}
          {lastCallerSpoken && (
            <div className="text-emerald-300 flex items-start gap-1.5 font-medium">
              <span className="shrink-0 text-emerald-400 font-black">🎙️ You:</span>
              <span className="line-clamp-2 leading-relaxed">"{lastCallerSpoken}"</span>
            </div>
          )}
        </div>
      )}

      {/* Dialpad: Independent, Glassmorphism Transparent Buttons */}
      <div className="w-full max-w-xs my-3">
        <div className="grid grid-cols-3 gap-3">
          {[
            { digit: '1', sub: 'ಕನ್ನಡ' },
            { digit: '2', sub: 'हिंदी' },
            { digit: '3', sub: 'English' },
            { digit: '4', sub: 'GHI' },
            { digit: '5', sub: 'JKL' },
            { digit: '6', sub: 'MNO' },
            { digit: '7', sub: '🎙️ Voice' },
            { digit: '8', sub: 'TUV' },
            { digit: '9', sub: 'Submit' },
            { digit: '*', sub: 'Clear' },
            { digit: '0', sub: '+' },
            { digit: '#', sub: 'Stop' },
          ].map(({ digit, sub }) => (
            <button
              key={digit}
              disabled={!callActive}
              onClick={() => {
                if (digit === '#' && isRecordingNote) {
                  stopVoiceNoteRecording();
                } else {
                  handleKeypadPress(digit);
                }
              }}
              className={`flex flex-col items-center justify-center h-16 sm:h-18 rounded-2xl transition-all select-none active:scale-95 cursor-pointer backdrop-blur-xl ${
                !callActive
                  ? 'bg-white/10 hover:bg-white/15 border border-white/15 text-white/50 cursor-not-allowed'
                  : digit === '1' && language === 'kn-IN'
                  ? 'bg-amber-500/40 border-2 border-amber-300 text-white shadow-xl ring-2 ring-amber-400/50'
                  : digit === '2' && language === 'hi-IN'
                  ? 'bg-amber-500/40 border-2 border-amber-300 text-white shadow-xl ring-2 ring-amber-400/50'
                  : digit === '3' && language === 'en-IN'
                  ? 'bg-amber-500/40 border-2 border-amber-300 text-white shadow-xl ring-2 ring-amber-400/50'
                  : digit === '7'
                  ? 'bg-white/25 hover:bg-white/35 border border-white/40 text-white shadow-lg ring-1 ring-white/30'
                  : 'bg-white/15 hover:bg-white/25 border border-white/20 text-white shadow-lg hover:shadow-xl'
              }`}
            >
              <span className="text-2xl font-black tracking-tight leading-none drop-shadow-sm">{digit}</span>
              <span className="text-[10px] text-white/80 tracking-wider uppercase font-bold mt-1 drop-shadow-xs">
                {sub}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Call Action Controls */}
      <div className="w-full max-w-xs flex items-center justify-center gap-2.5 pt-2 pb-4">
        {callActive ? (
          <>
            {/* Direct Mic Listening Toggle Button */}
            <button
              onClick={() => {
                if (isListening) {
                  stopUserListening();
                } else {
                  stopSpeechOnly();
                  startUserListening();
                }
              }}
              title={isListening ? "Mute Microphone" : "Enable Microphone & Speak"}
              className={`p-3.5 rounded-2xl border backdrop-blur-xl shadow-lg transition-all active:scale-95 cursor-pointer ${
                isListening
                  ? 'bg-emerald-500/40 text-emerald-200 border-emerald-400 ring-2 ring-emerald-400/40 animate-pulse'
                  : 'bg-white/20 hover:bg-white/30 text-white border-white/30'
              }`}
            >
              {isListening ? <Mic size={18} /> : <MicOff size={18} />}
            </button>

            {/* Interrupt Speech Button */}
            <button
              onClick={interruptSpeaking}
              title="Mute / Stop IVR voice"
              className="p-3.5 rounded-2xl bg-white/20 hover:bg-white/30 text-white border border-white/30 backdrop-blur-xl shadow-lg transition-all active:scale-95 cursor-pointer"
            >
              <VolumeX size={18} />
            </button>

            {/* Red Glass End Call Button */}
            <button
              onClick={endCall}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-rose-600/90 hover:bg-rose-600 text-white font-bold text-sm shadow-xl shadow-rose-950/40 border border-white/30 backdrop-blur-xl transition-all active:scale-95 cursor-pointer"
            >
              <PhoneOff size={18} />
              <span>End Call</span>
            </button>

            {/* Record Toggle Button (7 or #) */}
            {isRecordingNote ? (
              <button
                onClick={stopVoiceNoteRecording}
                className="px-4 py-3.5 rounded-2xl bg-amber-500/90 hover:bg-amber-500 text-slate-950 font-bold text-xs backdrop-blur-xl shadow-lg border border-white/30 transition-all active:scale-95 cursor-pointer"
              >
                Stop (#)
              </button>
            ) : (
              <button
                onClick={() => handleKeypadPress('7')}
                className="px-4 py-3.5 rounded-2xl bg-white/20 hover:bg-white/30 text-white font-bold text-xs backdrop-blur-xl shadow-lg border border-white/30 transition-all active:scale-95 cursor-pointer"
              >
                Record (7)
              </button>
            )}
          </>
        ) : (
          <button
            onClick={startCall}
            className="w-full flex items-center justify-center gap-2.5 py-4 rounded-2xl bg-white/25 hover:bg-white/35 text-white font-black text-base shadow-xl shadow-black/15 border border-white/40 backdrop-blur-2xl transition-all active:scale-95 cursor-pointer"
          >
            <Phone size={20} className="fill-white" />
            <span>Start Helpline Call</span>
          </button>
        )}
      </div>
    </div>
  );
};
