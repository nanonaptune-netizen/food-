/**
 * voiceCapture.ts
 * ---------------------------------------------------------------------------
 * Real-time, telephone-grade voice capture engine for the IVR screen.
 *
 * Why this exists (replaces the old Web Speech API loop in IVRDialer):
 *
 *  1. The browser Web Speech API does NOT support Kannada (kn-IN) on almost
 *     every desktop build. When you ask for `recognition.lang = 'kn-IN'` it
 *     silently falls back to the device language (English), which is exactly
 *     why a caller who pressed "1" was still transcribed in English.
 *     -> Here, every utterance is recorded and transcribed by the server STT
 *        with the language FORCED (Groq Whisper large-v3 knows Kannada).
 *
 *  2. A persistent microphone stream + local voice-activity detection (VAD)
 *     replaces the recogniser start/stop churn. The mic never "blinks"
 *     on/off and never has to be re-armed between turns.
 *
 *  3. Exactly ONE dispatch per spoken utterance. The old code could fire the
 *     same sentence 2-3 times (interim result + 2s timer + onend + server
 *     fallback). Here the utterance is closed by real silence detection and
 *     dispatched once, with a duplicate guard as a second line of defence.
 */

export type VoiceLang = 'kn-IN' | 'hi-IN' | 'en-IN';

export interface VoiceCaptureState {
  /** Mic stream is open and the engine is watching for speech */
  capturing: boolean;
  /** Caller is actively speaking right now */
  callerSpeaking: boolean;
  /** IVR audio is currently playing (used for barge-in logic) */
  ivrSpeaking: boolean;
  /** 0..1 input loudness, for UI metering */
  level: number;
}

export interface UtteranceInfo {
  audioMs: number;
  language: VoiceLang;
}

export interface VoiceCaptureOptions {
  /** Current IVR language, read at dispatch time */
  getLanguage: () => VoiceLang;
  /** Send the recorded utterance to the server for transcription */
  transcribe: (audio: Blob, language: VoiceLang) => Promise<string>;
  /** Called exactly once per finished utterance that produced text */
  onUtterance: (transcript: string, info: UtteranceInfo) => void;
  onStateChange?: (state: VoiceCaptureState) => void;
  /** Fired when the caller starts talking (used to barge in over the IVR) */
  onSpeechStart?: () => void;
  /** Human readable status for the UI */
  onNotice?: (message: string) => void;
  /** Silence that closes an utterance, in ms */
  endSilenceMs?: number;
  /** Absolute cap for a single utterance, in ms */
  maxUtteranceMs?: number;
  /** Utterances shorter than this are treated as noise, in ms */
  minUtteranceMs?: number;
  /** Minimum recording size to bother transcribing, in bytes */
  minBlobBytes?: number;
  /** Let the caller interrupt the IVR just by speaking */
  allowBargeIn?: boolean;
  /** Sustained speech required to trigger a barge-in, in ms */
  bargeInHoldMs?: number;
}

const POLL_MS = 60;
const DEFAULT_END_SILENCE_MS = 900;
const DEFAULT_MAX_UTTERANCE_MS = 20000;
const DEFAULT_MIN_UTTERANCE_MS = 320;
const DEFAULT_MIN_BLOB_BYTES = 1400;
const DEFAULT_BARGE_IN_HOLD_MS = 520;
const DEDUPE_WINDOW_MS = 5000;

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class VoiceCapture {
  private opts: Required<Pick<VoiceCaptureOptions,
    'endSilenceMs' | 'maxUtteranceMs' | 'minUtteranceMs' | 'minBlobBytes' |
    'allowBargeIn' | 'bargeInHoldMs'>> & VoiceCaptureOptions;

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timeData: Float32Array | null = null;
  private pollTimer: any = null;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recording = false;
  private utteranceStartedAt = 0;
  private silenceMs = 0;
  private loudMs = 0;
  private bargeInFired = false;
  private noiseFloor = 0.006;
  private calibrating = false;
  private calibrateSamples: number[] = [];
  private levelEmitTick = 0;

  private running = false;
  private paused = false;
  private ivrSpeaking = false;
  private dispatching = false;

  private lastTranscriptKey = '';
  private lastTranscriptAt = 0;
  private lastState: VoiceCaptureState = {
    capturing: false,
    callerSpeaking: false,
    ivrSpeaking: false,
    level: 0,
  };

  constructor(options: VoiceCaptureOptions) {
    this.opts = {
      endSilenceMs: DEFAULT_END_SILENCE_MS,
      maxUtteranceMs: DEFAULT_MAX_UTTERANCE_MS,
      minUtteranceMs: DEFAULT_MIN_UTTERANCE_MS,
      minBlobBytes: DEFAULT_MIN_BLOB_BYTES,
      allowBargeIn: true,
      bargeInHoldMs: DEFAULT_BARGE_IN_HOLD_MS,
      ...options,
    } as any;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 0..1 perceived loudness of the input */
  get level(): number {
    return this.lastState.level;
  }

  /**
   * Opens the microphone once and keeps it open for the whole call.
   * Uses echo cancellation so the IVR speaker output is not captured back.
   */
  async start(): Promise<boolean> {
    if (this.running) return true;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.opts.onNotice?.('Microphone is not available in this browser.');
      return false;
    }

    try {
      if (!this.stream || !this.stream.active) {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
      }

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx && (!this.audioCtx || this.audioCtx.state === 'closed')) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx?.state === 'suspended') {
        try { await this.audioCtx.resume(); } catch { /* ignore */ }
      }

      if (this.audioCtx && this.stream) {
        const source = this.audioCtx.createMediaStreamSource(this.stream);
        const analyser = this.audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.55;
        source.connect(analyser);
        this.analyser = analyser;
        this.timeData = new Float32Array(analyser.fftSize);
      }
    } catch (err: any) {
      this.opts.onNotice?.(
        err?.name === 'NotAllowedError'
          ? 'Microphone permission is blocked. Allow the mic and try again.'
          : 'Could not open the microphone. Please check your device.'
      );
      this.stream = null;
      return false;
    }

    this.running = true;
    this.paused = false;
    this.calibrating = true;
    this.calibrateSamples = [];
    this.silenceMs = 0;
    this.loudMs = 0;
    this.emitState({ capturing: true });
    this.startPolling();
    return true;
  }

  /** Temporarily stop watching for speech (e.g. while recording a voice note). */
  pause() {
    this.paused = true;
    this.abortUtterance();
    this.emitState({ capturing: false, callerSpeaking: false });
  }

  resume() {
    if (!this.running) return;
    this.paused = false;
    this.silenceMs = 0;
    this.loudMs = 0;
    this.emitState({ capturing: true });
  }

  /** Throw away whatever is being recorded right now (e.g. caller pressed a key). */
  abortCurrent() {
    this.abortUtterance();
    this.emitState({ callerSpeaking: false });
  }

  /** Tell the engine whether the IVR is talking right now. */
  setIvrSpeaking(speaking: boolean) {
    this.ivrSpeaking = speaking;
    this.bargeInFired = false;
    this.emitState({ ivrSpeaking: speaking });
  }

  /** Fully tear down the engine: recorder, audio graph and mic track. */
  dispose() {
    this.running = false;
    this.paused = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.abortUtterance();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
    this.audioCtx = null;
    this.analyser = null;
    this.timeData = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    this.stream = null;
    this.emitState({ capturing: false, callerSpeaking: false, level: 0 });
  }

  // ------------------------------------------------------------------ internals

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.tick(), POLL_MS);
  }

  private tick() {
    if (!this.running || !this.analyser || !this.timeData) return;

    this.analyser.getFloatTimeDomainData(this.timeData as any);
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = this.timeData[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.timeData.length);

    // --- noise floor calibration on the first ~500ms of the call
    if (this.calibrating) {
      this.calibrateSamples.push(rms);
      if (this.calibrateSamples.length >= 8) {
        const avg = this.calibrateSamples.reduce((a, b) => a + b, 0) / this.calibrateSamples.length;
        this.noiseFloor = Math.min(0.03, Math.max(0.004, avg * 2.2));
        this.calibrating = false;
      }
      this.emitState({ level: Math.min(1, rms * 12) });
      return;
    }

    if (this.paused) {
      this.emitState({ level: Math.min(1, rms * 12) });
      return;
    }

    // Higher bar while the IVR is talking, so its own voice cannot trigger us.
    const threshold = this.ivrSpeaking
      ? Math.max(this.noiseFloor * 3.2, 0.03)
      : Math.max(this.noiseFloor * 2.4, 0.012);

    const isLoud = rms > threshold;

    if (isLoud) {
      this.loudMs += POLL_MS;
      this.silenceMs = 0;
    } else {
      this.loudMs = 0;
      if (this.recording) this.silenceMs += POLL_MS;
    }

    // --- start of an utterance
    if (!this.recording && isLoud) {
      const holdNeeded = this.ivrSpeaking ? this.opts.bargeInHoldMs : POLL_MS * 2;
      if (this.loudMs >= holdNeeded) {
        if (this.ivrSpeaking) {
          if (!this.opts.allowBargeIn) return;
          if (this.bargeInFired) return;
          this.bargeInFired = true;
          this.opts.onSpeechStart?.();
        }
        this.beginUtterance();
      }
    }

    // --- end of an utterance
    if (this.recording) {
      const elapsed = Date.now() - this.utteranceStartedAt;
      if (this.silenceMs >= this.opts.endSilenceMs || elapsed >= this.opts.maxUtteranceMs) {
        this.closeUtterance();
      }
    }

    this.levelEmitTick++;
    if (this.levelEmitTick % 3 === 0) {
      this.emitState({ level: Math.min(1, rms * 12) });
    }
  }

  private beginUtterance() {
    if (!this.stream || this.recording) return;

    const mimeType = pickMimeType();
    try {
      this.recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType })
        : new MediaRecorder(this.stream);
    } catch {
      try {
        this.recorder = new MediaRecorder(this.stream);
      } catch {
        this.recorder = null;
        return;
      }
    }

    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onerror = () => { /* keep the call alive */ };

    try {
      this.recorder.start(250);
    } catch {
      this.recorder = null;
      return;
    }

    this.recording = true;
    this.utteranceStartedAt = Date.now();
    this.silenceMs = 0;
    this.emitState({ callerSpeaking: true });
  }

  private closeUtterance() {
    const startedAt = this.utteranceStartedAt;
    const recorder = this.recorder;
    this.recording = false;
    this.recorder = null;
    this.silenceMs = 0;
    this.emitState({ callerSpeaking: false });

    if (!recorder) return;

    const audioMs = Date.now() - startedAt;
    const mimeType = recorder.mimeType || 'audio/webm';

    const finish = async () => {
      const chunks = this.chunks;
      this.chunks = [];
      if (audioMs < this.opts.minUtteranceMs) return;

      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size < this.opts.minBlobBytes) return;
      if (this.dispatching) return;

      this.dispatching = true;
      try {
        const language = this.opts.getLanguage();
        const text = (await this.opts.transcribe(blob, language))?.trim();
        if (!text) {
          this.opts.onNotice?.('I could not hear that clearly. Please speak once more.');
          return;
        }
        const key = normalizeForDedupe(text);
        const now = Date.now();
        if (key && key === this.lastTranscriptKey && now - this.lastTranscriptAt < DEDUPE_WINDOW_MS) {
          return; // same sentence already handled - never answer twice
        }
        this.lastTranscriptKey = key;
        this.lastTranscriptAt = now;
        this.opts.onUtterance(text, { audioMs, language });
      } catch (err: any) {
        this.opts.onNotice?.('Voice recognition had a problem. Please try again.');
      } finally {
        this.dispatching = false;
      }
    };

    try {
      recorder.onstop = () => { void finish(); };
      if (recorder.state !== 'inactive') recorder.stop();
      else void finish();
    } catch {
      void finish();
    }
  }

  private abortUtterance() {
    this.recording = false;
    this.silenceMs = 0;
    this.loudMs = 0;
    if (this.recorder) {
      try { this.recorder.onstop = null; } catch { /* ignore */ }
      try {
        if (this.recorder.state !== 'inactive') this.recorder.stop();
      } catch { /* ignore */ }
    }
    this.recorder = null;
    this.chunks = [];
  }

  private emitState(patch: Partial<VoiceCaptureState>) {
    const next = { ...this.lastState, ...patch };
    const changed =
      next.capturing !== this.lastState.capturing ||
      next.callerSpeaking !== this.lastState.callerSpeaking ||
      next.ivrSpeaking !== this.lastState.ivrSpeaking ||
      Math.abs(next.level - this.lastState.level) > 0.05;
    if (changed) {
      this.lastState = next;
      this.opts.onStateChange?.(next);
    }
  }
}
