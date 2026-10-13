# Speech stack decision — Kannada / Hindi / English

**Updated:** 2026-09-25 (supersedes the 2026-09-08 version) · **Scope:** what actually powers listening and speaking in this app.

> **Decision: Groq only for AI, Edge neural voices for speech output. Sarvam AI has been removed from the project entirely.**

## TL;DR

| Job | Provider | Key needed | Notes |
| --- | --- | --- | --- |
| **Speaking (TTS)** | **Microsoft Edge "Read Aloud" neural voices** via the `msedge-tts` npm package (MIT) | **No key** | Speaks Kannada, Hindi and Indian English natively. MP3 24 kHz / 48 kbps. One WebSocket reused per voice. |
| **Listening (STT)** | **Groq `whisper-large-v3-turbo`** | `GROQ_API_KEY` | Language is **forced** (`kn` / `hi` / `en`) and a domain hint is sent, so Kannada can never come back as English. |
| **Listening — fallback** | **On-device Whisper** (`@xenova/transformers`, `Xenova/whisper-tiny`, WASM) in `src/lib/clientWhisper.ts` | none | Runs inside the browser. Used automatically when the cloud STT returns nothing, so the helpline keeps hearing callers with zero API credits. |
| **LLM answers** | **Groq** (`qwen/qwen3.8-27b`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`) | `GROQ_API_KEY` | JSON mode, ~320 tokens on live voice turns. If the key is missing/expired the IVR still answers from `knowledge_base` / `qa_cache`. |

### Model catalog — verify before assuming

The account's Groq key exposes a **newer catalog**; the older `llama-3.x` and `mixtral` IDs are **not available** on it:

```
allam-2-7b                              meta-llama/llama-prompt-guard-2-22m
canopylabs/orpheus-arabic-saudi          meta-llama/llama-prompt-guard-2-86m
canopylabs/orpheus-v1-english            openai/gpt-oss-120b
openai/gpt-oss-20b                       openai/gpt-oss-safeguard-20b
qwen/qwen3.8-27b                         whisper-large-v3
whisper-large-v3-turbo
```

**Measured latency on a Kannada JSON voice turn** (same prompt):

| Model | Time | Notes |
| --- | --- | --- |
| `qwen/qwen3.8-27b` | **264–315 ms** | fastest, correct Kannada and JSON — leads the voice chain |
| `openai/gpt-oss-120b` | ~800 ms | best-quality prose, used for longer non-voice text |
| `openai/gpt-oss-20b` | ~765–923 ms | second fallback |
| `allam-2-7b` | ~415 ms | unusable: fails JSON mode, loops/repeats |

Model chains live in `GROQ_VOICE_MODELS` / `GROQ_TEXT_MODELS` / `GROQ_STT_MODEL` in `server.ts`. The boot check prints which of them the current key actually supports, so a key from a different tier can never fail silently.

### Latency protection

On a live voice turn the **first** model gets a short leash (3500 ms) and later attempts get 9000 ms. A stalled first model therefore costs ~3.5 s instead of 6 s — this alone took one measured turn from 9.4 s down to 2.6 s.

## Why Sarvam was removed

- The account key returned **HTTP 402 `insufficient_quota_error`** — chat, TTS and STT all failed.
- Because the failures were silent, they looked like speech-recognition bugs (Kannada transcribed as English, no audio, slow replies).
- Every Sarvam capability now has a working replacement: TTS → Edge neural (free, no key), STT → Groq Whisper (same key as the LLM).

## Why the browser Web Speech API is NOT used for listening

`recognition.lang = 'kn-IN'` is accepted but **silently ignored** on desktop Chrome, which falls back to the device language (English). That was the original cause of "I pressed 1 for Kannada but it hears English". The browser recogniser has therefore been removed from the dispatch path entirely.

## Voice map (Edge neural)

| Language | Voice | Override env var |
| --- | --- | --- |
| Kannada `kn-IN` | `kn-IN-SapnaNeural` | `TTS_EDGE_VOICE_KN` |
| Hindi `hi-IN` | `hi-IN-SwaraNeural` | `TTS_EDGE_VOICE_HI` |
| English `en-IN` | `en-IN-NeerjaNeural` | `TTS_EDGE_VOICE_EN` |

## Configuration

```bash
# .env  — the only AI credential the app needs
GROQ_API_KEY="gsk_..."
```

On boot the server verifies the key against Groq's `/models` endpoint and logs a clear result, e.g.:

```
[Provider check] GROQ_API_KEY is valid - LLM and speech-to-text are ready.
[Provider check] 11 models on this key; usable here: qwen/qwen3.8-27b, openai/gpt-oss-20b, openai/gpt-oss-120b, whisper-large-v3-turbo
```

or `rejected with status 401`. Provider failures are always logged with their HTTP status, so a dead key can never masquerade as a voice-quality problem again.

### Measured end-to-end (verified 2026-09-25)

| Flow | Result |
| --- | --- |
| Voice round-trip: Edge TTS Kannada → Groq Whisper | 529 ms + 260 ms, Kannada script returned correctly |
| Kannada complaint turn | ~2.7 s incl. audio; extracted `location`, `when`, `cause`, `item` correctly |
| Hindi question turn | ~1.5 s incl. audio, answered in Devanagari |
| English question turn | ~2.6–3.3 s incl. audio |
| Complaint submission | reference ID issued, call + turns persisted |

## Latency notes

- Speech output is cached in memory per language + text, so recurring prompts (welcome menu, "press 9 to submit") replay instantly.
- Live voice turns use the low-latency model first with JSON mode and a small token budget.
- TTS is capped by a hard timeout; if it misses the deadline the client speaks locally instead of stalling the call.
