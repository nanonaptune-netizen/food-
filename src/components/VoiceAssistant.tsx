import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Mic, MicOff, Send, AlertCircle, Loader2, Languages, Utensils, Upload, X, Volume2, VolumeX, Sparkles, ChevronDown, ChevronUp, Cpu, PhoneCall } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { VoiceInteraction, UserProfile } from '../types';
import ParticleBall from './ParticleBall';
import { RenderedMarkdown } from './RenderedMarkdown';
import { transcribeAudioInBrowser } from '../lib/clientWhisper';
import { stripEmojis, cleanSpeechTranscript, mergeTranscripts } from '../utils/text';

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
  const audioChunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef<string>('');
  const accumulatedFinalRef = useRef<string>('');
  const sessionPrefixRef = useRef<string>('');
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const silenceTimerRef = useRef<any>(null);
  const isListeningRef = useRef<boolean>(false);
  const isSpeakingRef = useRef<boolean>(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<any>(null);
  const hasSpokenRef = useRef<boolean>(false);
  const lastSoundTimeRef = useRef<number>(0);
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

  const stopSpeaking = () => {
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

  const startRecording = async () => {
    try {
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
      }
      if (vadIntervalRef.current) {
        clearInterval(vadIntervalRef.current);
        vadIntervalRef.current = null;
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch {}
        audioContextRef.current = null;
      }

      hasSpokenRef.current = false;
      lastSoundTimeRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : MediaRecorder.isTypeSupported('audio/webm') 
          ? 'audio/webm' 
          : 'audio/mp4';
      
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };
      
      recorder.start(100); // 100ms timeslice for responsive audio capture

      // AudioContext Voice Activity Detection (VAD) for particle energy & audio tracking
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.4;
          source.connect(analyser);

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          
          vadIntervalRef.current = setInterval(() => {
            if (!isListeningRef.current) return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const average = sum / dataArray.length;

            // Only track sound activity when speech text has actually started capturing
            if (average > 8 && transcriptRef.current.trim().length > 0) {
              hasSpokenRef.current = true;
              lastSoundTimeRef.current = Date.now();
            }
          }, 100);
        }
      } catch (vadErr) {
        console.warn("VAD audio analyser notice:", vadErr);
      }

      setMicError(null);
    } catch (e: any) { 
      console.warn("Microphone access error:", e);
      setMicError("Microphone access is unavailable or blocked. Please check browser permissions or type your question below.");
    }
  };

  const stopAndTranscribeAudio = async (): Promise<string | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        return resolve(null);
      }

      recorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) return resolve(null);
        
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          if (audioBlob.size < 500) {
            return resolve(null); // Too short to be voice
          }

          // 1. Send recorded audio to high-accuracy server STT (/api/stt: Groq Whisper STT)
          try {
            const formData = new FormData();
            formData.append('audio', audioBlob, 'speech.webm');
            formData.append('language', language);

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
      
      recorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) return resolve(undefined);
        const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
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
          updateListeningState(true);
          setMicError(null);
        };

        recognition.onresult = (event: any) => {
          let currentFinal = '';
          let currentInterim = '';
          
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const item = event.results[i];
            if (item && item[0]) {
              if (item.isFinal) {
                currentFinal += item[0].transcript + ' ';
              } else {
                currentInterim += item[0].transcript;
              }
            }
          }

          if (currentFinal) {
            const cleanFinal = currentFinal.trim();
            // Prevent duplicate appending of the exact same recognized chunk
            if (!accumulatedFinalRef.current.includes(cleanFinal)) {
              accumulatedFinalRef.current = cleanSpeechTranscript((accumulatedFinalRef.current + ' ' + cleanFinal).trim());
            }
          }

          const combined = cleanSpeechTranscript((accumulatedFinalRef.current + ' ' + currentInterim).trim());

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
            // Keep speech recognition continuously running while user is in active speaking mode
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
      window.speechSynthesis.cancel();
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
      };
      utterance.onerror = (e) => {
        console.warn("Browser speech synthesis error:", e);
        activeUtteranceRef.current = null;
        updateSpeakingState(false);
        setPlayingMsgId(null);
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

    // 1ST PRIORITY: Browser Google Speech Synthesis (Instant, Fast, 0ms network latency!)
    const browserSpoke = speakWithBrowserGoogle(textToSpeak, language);
    if (browserSpoke) {
      return;
    }

    // 2ND PRIORITY: Pre-generated audio URL (if device lacks native Kannada voice)
    if (audioUrl) {
      try {
        const audio = new Audio(audioUrl);
        audio.onplay = () => updateSpeakingState(true);
        audio.onended = () => {
          updateSpeakingState(false);
          setPlayingMsgId(null);
        };
        audio.onerror = () => {
          updateSpeakingState(false);
          setPlayingMsgId(null);
        };
        activeAudioRef.current = audio;
        await audio.play();
        return;
      } catch (e) {
        console.warn("Direct audio URL playback notice:", e);
      }
    }

    // 3RD PRIORITY: Server TTS (/api/tts)
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToSpeak, language })
      });

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (data && data.audioBase64) {
          const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
          audio.onplay = () => updateSpeakingState(true);
          audio.onended = () => {
            updateSpeakingState(false);
            setPlayingMsgId(null);
          };
          audio.onerror = () => {
            updateSpeakingState(false);
            setPlayingMsgId(null);
          };
          activeAudioRef.current = audio;
          await audio.play();
          return;
        }
      }
    } catch (err) {
      console.warn("Server TTS request notice (using browser speech fallback):", err);
    }
  };

  const stopListeningAndSend = async () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    sessionPrefixRef.current = '';
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
    
    // 1ST PRIORITY: Free native Browser Web Speech API (Chrome/Edge/Safari/Android/Kotlin-like)
    if (browserCaptured && !isHallucinatedText(browserCaptured)) {
      setTranscript(browserCaptured);
      transcriptRef.current = '';
      handleSendMessage(browserCaptured);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        stopAndTranscribeAudio().catch(() => {});
      }
      return;
    }

    // 2ND PRIORITY: Backend STT fallback (only if MediaRecorder was used on browsers lacking SpeechRecognition)
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      setIsLoading(true);
      const serverText = await stopAndTranscribeAudio();
      setIsLoading(false);

      if (serverText && serverText.trim() && !isHallucinatedText(serverText.trim())) {
        setTranscript(serverText.trim());
        transcriptRef.current = '';
        handleSendMessage(serverText.trim());
      } else {
        setTranscript('');
        transcriptRef.current = '';
      }
    } else {
      setTranscript('');
      transcriptRef.current = '';
    }
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
    updateListeningState(true);
    
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    // Direct Browser Web Speech API (Native, instant, 100% Kotlin-like clean behavior)
    // Avoid starting MediaRecorder simultaneously to eliminate mic hardware conflict & double "ding ding" sound on Chrome/Android!
    if (SpeechRecognition && recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch (e) {
        console.warn("Native speech recognition start notice:", e);
      }
    } else {
      // Fallback for browsers without native SpeechRecognition (e.g. Firefox desktop)
      try {
        await startRecording();
      } catch (recErr) {
        console.warn("Audio recorder initialization notice:", recErr);
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
    setIsLoading(true);
    setTranscript('');
    transcriptRef.current = '';
    setManualText('');

    // Check for confirmation if a complaint was drafted
    if (complaintDraft && (
      queryText.toLowerCase().includes('yes') || 
      queryText.toLowerCase().includes('confirm') || 
      queryText.toLowerCase().includes('okay') || 
      queryText.toLowerCase().includes('ha') || 
      queryText.toLowerCase().includes('sari')
    )) {
      await finalizeComplaint();
      return;
    }

    const recentHistory = messages.slice(-8).map(m => ({
      role: m.sender === 'user' ? 'user' : 'assistant',
      content: m.text
    }));

    const userTurnCount = messages.filter(m => m.sender === 'user').length + 1;

    // Check local response cache for immediate fast return on repeated queries
    const cacheKey = `${language}:${queryText.toLowerCase().trim()}`;
    const cachedResponse = queryCacheRef.current.get(cacheKey);
    if (cachedResponse && !complaintDraft) {
      const assistantMsg: VoiceInteraction = { 
        id: (Date.now() + 1).toString(), 
        text: cachedResponse.response, 
        sender: 'assistant', 
        timestamp: Date.now(),
        audioUrl: cachedResponse.audioUrl
      };
      setMessages(prev => [...prev, assistantMsg]);
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
          chatCount: userTurnCount
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

      // Store in memory cache
      queryCacheRef.current.set(cacheKey, {
        response: assistantReply,
        spokenText: spokenVoiceText,
        audioUrl: data.audioUrl || undefined,
        isComplaintDraft: !!data.isComplaintDraft,
        markdownReport: data.markdownReport
      });

      const assistantMsg: VoiceInteraction = { 
        id: (Date.now() + 1).toString(), 
        text: assistantReply, 
        sender: 'assistant', 
        timestamp: Date.now(),
        audioUrl: data.audioUrl || undefined
      };
      
      setMessages(prev => [...prev, assistantMsg]);
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
      
      const successMsg: VoiceInteraction = { 
        id: Date.now().toString(), 
        text: "Your report has been successfully registered! Our support team will review your audio and details. You can track progress anytime in Track Reports.", 
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

