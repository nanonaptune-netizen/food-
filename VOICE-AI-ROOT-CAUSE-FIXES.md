# Voice AI Helpline — Root Causes and Fixes

Each of your four complaints traced back to a **specific, separate defect in the code**
(not one vague bug). Below is symptom → root cause → what changed.

Verification: `npm run lint` (`tsc --noEmit`) passes on every edited file, and
`npm run build` (vite + esbuild) completes successfully.

---

## 1. "Words doubling — speaking 2 lines turns into 10 lines or more"

**Root cause — the transcript accumulator was append-only.** In `src/components/VoiceAssistant.tsx`,
`recognition.onresult` appended every final result onto a running string
(`accumulatedFinalRef`) and only guarded against re-appending with a **substring** test:

```js
if (!accumulatedFinalRef.current.includes(cleanFinal)) { ... }
```

Two things went wrong together:

1. Chrome ends recognition by itself after a pause; `onend` restarted it. On restart Chrome
   **re-delivers results it has already reported**, so the same words were appended again.
2. `cleanSpeechTranscript()` rewrites the accumulated text (it collapses repeated phrases),
   so the old text is often no longer a literal substring — the guard failed to block the
   duplicate and the sentence was added a second time.

Each restart cycle re-added the sentence, so 2 spoken lines became 4, then 8, then "10+".
The duplicated text was then sent to the LLM, whose reply mirrors it — so the *spoken* output
was inflated too.

**Fix** ([VoiceAssistant.tsx:371](src/components/VoiceAssistant.tsx:371), [:376](src/components/VoiceAssistant.tsx:376)):
the whole session transcript is now **rebuilt idempotently on every event** from
`event.results` instead of appended, and each recognition session is banked into a prefix and
merged with `mergeTranscripts()` — a seam-safe merge (already in `src/utils/text.ts` but
**imported and never used**) that folds the overlapping words instead of repeating them.

---

## 2. "It's dumb, doesn't listen carefully, doesn't remember what I said"

**Root cause — a duplicate dispatch plus a stateless request.** Three separate issues:

- **One sentence produced two user turns.** After already sending the browser transcript,
  `stopListeningAndSend` also fired `stopAndTranscribeAudio()` for the *same* audio, adding a
  second transcription path. The assistant could answer the same utterance twice.
- **The AI had almost no memory.** `/api/chat` is stateless: the client sent only
  `messages.slice(-8)`, the server kept `history.slice(-6)`, and the client's
  `queryCacheRef` returned a **context-free cached reply** even mid-conversation — so asking
  the same thing twice returned the same answer as if nothing had been said.
- **Garbled input.** Defect #1 fed it corrupted, doubled sentences, so it "listened" to noise.

**Fix**
- Duplicate transcription path removed ([VoiceAssistant.tsx:625](src/components/VoiceAssistant.tsx:625)) → one utterance = exactly one turn.
- History window widened 8 → 16 client-side, 6 → 12 server-side.
- The server now states the caller's memory **explicitly** in the prompt
  ([server.ts:1080](server.ts:1080)): previously-stated facts (location / when / cause / item /
  name / city) plus the caller's own earlier words, followed by hard rules —
  *never ask again for a detail already known*, *ask at most one missing detail per turn*,
  *resolve back-references like "that place" from the conversation*.
- The local cache is now only served on a **context-free first turn**
  ([VoiceAssistant.tsx:824](src/components/VoiceAssistant.tsx:824)).

---

## 3. "IVR keeps wasting time asking the same thing again"

**Root cause — unanchored substring matching on menu answers.** In `server.ts` the language
menu was tested with alternations like:

```js
/1|one|kannada|ಕನ್ನಡ|ಒಂದು/i.test(message)
```

A bare `/1/` matches the `1` in "2025" or "₹100", and `/one/` matches inside **"phone",
"someone", "money", "done"**. So a caller who simply described their problem —
*"someone sold me stale food at 7pm"* — re-triggered the language branch, the welcome prompt
was replayed, `nextStep` was reset to `collecting_info`, and the caller had to start over.
The key-7 branch had the same `/7|seven|record|.../i` problem, and the submit branch accepted
a bare **`ha`** substring — which matches "what", "have", "shall", "harsh", so the complaint
was **filed before the caller ever confirmed**.

**Fix** — a proper anchored matcher was added ([server.ts:1624](server.ts:1624)):
- Digits match the **whole utterance** only (`"9"`, `"press 9"`, `"option 9"`).
- Language words match as **whole words** (Latin via `\b`, Kannada/Devanagari bounded by their
  script range) — so "phone"/"someone"/"money"/"done" can no longer select a language.
- Confirmation is a whole-utterance check ([server.ts:1647](server.ts:1647)), replacing the
  loose `press_7_prompt` branch that was defeating the strict one right below it.
- Deliberately excluded at step `welcome`, so a stray "ok" cannot file an empty complaint.

---

## 4. "Auto listen while speaking doesn't work — main page orb and IVR"

**Main page orb — two separate defects.**

- **The orb never saw your voice.** `ParticleBall` is driven by `audioStream={micStream}`, but
  `micStream` was only ever created inside `startRecording()` — which is **skipped** whenever
  the browser has native `SpeechRecognition`. On desktop Chrome it always received `null`, so
  the sphere animated synthetic waves instead of your microphone.
  → A dedicated, kept-warm analyser stream is now opened ([VoiceAssistant.tsx:670](src/components/VoiceAssistant.tsx:670)).
- **Listening never re-armed after a reply.** Nothing called the listen path when TTS ended, so
  you had to click the orb again every single turn.
  → Listening is now re-armed automatically the moment the assistant stops speaking
  ([VoiceAssistant.tsx:686](src/components/VoiceAssistant.tsx:686)), on all three TTS tiers.
  Also fixed: a failed `recognition.start()` used to leave the UI claiming "Listening" while
  capturing nothing — it now clears the state instead.

**IVR — the mic went dead after you interrupted.**

Pausing the `<audio>` element and calling `speechSynthesis.cancel()` **never fire `onended`**.
`speakIVR`'s `handleSpeechEnd()` was therefore never reached, so `startUserListening()` never
ran — the call went silent until you pressed a button. On top of that, while the assistant
spoke the voice-activity bar was raised to `max(noiseFloor*3.2, 0.03)` and barge-in required
**520 ms** of sustained speech — so a short, quiet reply like "ಹೌದು" / "yes" **never registered
at all**.

**Fix**
- Interrupting now re-arms listening explicitly ([IVRDialer.tsx:282](src/components/IVRDialer.tsx:282)) — closes the hole for every interrupt path.
- Barge-in threshold lowered to `max(noiseFloor*1.9, 0.016)` ([voiceCapture.ts:316](src/lib/voiceCapture.ts:316)) and the hold shortened to 240 ms ([voiceCapture.ts:335](src/lib/voiceCapture.ts:335)).
- `isRecordingNote` was read from a **stale render closure** inside async callbacks, which
  skipped re-arming; it now reads through a ref ([IVRDialer.tsx:72](src/components/IVRDialer.tsx:72)).

---

# Round 2 — remaining defects found and fixed

A second pass over the whole codebase (not just the four reported symptoms).

## 5. CRITICAL: every admin and PII endpoint was unauthenticated

`GET /api/admin/complaints` returned **every citizen's name, phone number, location,
complaint text and full IVR call transcript** to anyone who could reach the API — no
credentials at all. The same applied to `/api/admin/ivr-calls`, and `DELETE`/`PATCH`/
`POST /api/admin/...` let anyone erase or rewrite records. The dashboard PIN was a
constant living in the browser bundle (`Admin.tsx`: `const correctPin = '0000'`), so it
only hid the UI — the API it protected was wide open.

**Fix — real server-side sessions:**
- `POST /api/admin/login` verifies the PIN with `crypto.timingSafeEqual` against
  `ADMIN_PIN` (env var, no longer in the bundle) and returns a 24-byte random token
  (12-hour expiry, swept in the background).
- `requireAdmin` now guards **12 routes**: all `/api/admin/*`, all `/api/knowledge*`
  mutations and reads, and `/api/process-document`.
- `src/lib/adminAuth.ts` (new) handles login/logout and `adminFetch()`, which attaches
  the token and clears the local session on `401`. `Admin.tsx`, `Dashboard.tsx` and
  `UploadData.tsx` all use it; the token is kept in `sessionStorage`.

Verified at runtime against the running server:

```
GET  /api/admin/complaints  (no token)     -> 401      (was 200 + full PII)
GET  /api/knowledge         (no token)     -> 401
GET  /api/admin/ivr-calls   (no token)     -> 401
POST /api/process-document  (no token)     -> 401
POST /api/admin/login       (wrong pin)    -> 401
GET  /api/admin/complaints  (with token)   -> 200
GET  /api/admin/complaints  (after logout) -> 401
```

## 6. CRITICAL: complaint lookup leaked data by partial phone number

`GET /api/complaints?phone=...` ran `phoneNumber LIKE '%<input>%'`, so `?phone=9`
dumped every citizen whose number contains a 9. A full 10-digit number is now
required, the query is an exact match, and the validation runs **before** the database
call (it originally sat after a `!turso` early-return, so it was skipped entirely when
the DB was unavailable). Verified: `?phone=9` → **400**, `?phone=9876543210` → 200,
no key → `[]`.

## 7. CRITICAL: live credentials committed to the repository

- `patch_stt.py` contained a **hard-coded Groq API key** (`gsk_3W75NE44...`) as a
  fallback. Removed; it now reads `process.env.GROQ_API_KEY` only.
- `.env.example` (tracked, because `.gitignore` has `!.env.example`) contained a real
  **Turso `TURSO_AUTH_TOKEN` JWT**, a real **Cloudinary API secret**, and the live DB
  URL. All replaced with placeholders, and `ADMIN_PIN` documented.

**These three credentials are still in git history and must be rotated** — replacing
them in the working tree does not revoke them.

## 8. No rate limiting anywhere

Every endpoint that costs money (Groq tokens, Cloudinary storage) was unlimited, so a
single script could exhaust the account's quota. Added a small fixed-window per-IP
limiter to `/api/admin/login` (10 per 15 min — a 4-digit PIN is otherwise only 10,000
guesses), `/api/upload`, `/api/upload-audio`, `/api/complaints/add` (30 per 10 min),
and `/api/chat`, `/api/tts`, `/api/stt`, `/api/ivr/dialogue` (60–90 per min).
Verified: the 9th rapid wrong-PIN attempt onward returns **429**.

## 9. Smaller correctness fixes

- **Misleading complaint confirmation.** The success message promised "we will review
  your audio" even when no audio was attached — which is the normal case on desktop
  Chrome, because `stopAndUploadAudio()` needs a `MediaRecorder` that never exists on
  the native-recognition path. The wording is now conditional on a clip existing.
- **Silent lookup failure.** `TrackComplaints` showed "no complaints" when the server
  refused a partial number; it now surfaces the reason.
- **Dead one-off patch scripts.** `patch_stt.py`, `patch_tts.py`, `patch_tts_cache.py`
  and `patch_va.py` rewrite whole function bodies by string matching and have already
  been applied — re-running them silently undoes later fixes (`patch_va.py` re-adds the
  transcript-doubling bug). Each now carries a DEPRECATED banner.

## Not fixed, and why

- `src/lib/firebase.ts` fails `tsc` because the `firebase` package is not in
  `package.json`. Nothing imports that file, so I left it alone rather than adding a
  large dependency — but it will need attention if Firebase is actually intended.
- The servers keep admin sessions and rate-limit counters **in memory**, which is
  correct for a single instance but resets on restart and is not shared across
  instances. A multi-instance deployment needs a shared store.

## Files changed

| File | Change |
|---|---|
| `src/components/VoiceAssistant.tsx` | Idempotent transcript rebuild + seam merge, single dispatch, real orb audio stream, auto re-arm, whole-utterance confirmation, wider history |
| `src/utils/text.ts` | New `isAffirmation()` whole-utterance confirmation matcher |
| `src/components/IVRDialer.tsx` | Re-arm listening on interrupt, ref-based note-recording state |
| `src/lib/voiceCapture.ts` | Lower barge-in threshold and shorter hold |
| `src/lib/adminAuth.ts` | **New** — admin session token handling and `adminFetch()` |
| `src/components/Admin.tsx` | PIN verified by the server; logout invalidates the session |
| `src/components/Dashboard.tsx` | Admin calls go through `adminFetch` |
| `src/components/UploadData.tsx` | Admin calls go through `adminFetch` |
| `src/components/TrackComplaints.tsx` | Surfaces the lookup error instead of showing an empty list |
| `server.ts` | Admin sessions + `requireAdmin` on 12 routes, rate limiting, exact-match complaint lookup, anchored IVR matching, conversation memory, credentials removed |
| `.env.example` | Live credentials replaced with placeholders; `ADMIN_PIN` documented |
| `patch_*.py` | Hard-coded Groq key removed; deprecated banners added |

---

# Round 3 — natural voices, accurate captions, real memory

Covers: "you're not using any microsoft neural voices", "it's not memorized what I
said", "Kannada: understand perfectly but captions are incorrect", "if talking about
idli … it asked what you eat?", "I asked tell me what I said but it said I don't
know", and "voice in three languages must be natural".

## 10. The neural voices worked all along — the client never used them

I tested the existing Edge TTS directly: `kn-IN-SapnaNeural`, `hi-IN-SwaraNeural` and
`en-IN-NeerjaNeural` all synthesise real audio (~0.9–1.5 s per sentence, 322 voices
available). So the voice engine was never the problem — **tier ordering was**:

- `VoiceAssistant.speak()` tried the browser's `speechSynthesis` **first**, and it
  claimed *every* English reply. So the robotic on-device SAPI voice spoke instead of
  the neural one, and the neural audio that `/api/chat` had already generated was
  thrown away.
- `IVRDialer.speakIVR()` tried the browser voice **second**, ahead of `/api/tts` — so
  whenever the `/api/ivr/dialogue` TTS race was lost, the call dropped to the robotic
  voice too.

**Fix** — neural audio is now tried first on both surfaces:
`audioUrl` → `/api/tts` (cached per language+text, bounded to 40 entries) → on-device
voice as a logged last resort. Interrupting bumps a generation counter so an
in-flight TTS fetch from a cancelled turn can never start playing late.

Verified against the running server:

```
Kannada  -> 22608 bytes (906ms)
Hindi    -> 23616 bytes (912ms)
English  -> 29808 bytes (1550ms)
```

## 11. Captions were wrong because the browser recogniser was the caption

`src/components/VoiceAssistant.tsx` used the browser Web Speech API as both the
**dispatched transcript** and the **on-screen caption**. Your own
`speech-api-research.md` records that `recognition.lang = 'kn-IN'` is silently ignored
on desktop Chrome — so Kannada captions were garbled, exactly as you described.

Worse, the silence timer that *sends* a turn lived inside `recognition.onresult`. When
the recogniser returns nothing — the normal case for Kannada on desktop — **the turn
was never dispatched at all**.

**Fix**
- Each utterance is recorded from the single persistent microphone stream, and
  **server Whisper is now the authoritative transcript** for both the caption and the
  dispatched text; the browser text is only a fallback.
- Turn-taking is driven by **real microphone energy** (RMS VAD: send after 2.5 s of
  silence once speech was detected, hard cap at 20 s), which behaves identically in all
  three languages and no longer depends on `onresult` firing.

## 12. Real memory, and "what did I say?" can no longer fail

The chat was stateless: memory was whatever the browser chose to resend, and the
assistant had **never been given the transcript**, so "what did I say?" was answered
from nothing.

**Fix**
- Conversations are stored **server-side** (Turso `conversations` table, in-memory
  fallback, 40-turn cap), keyed by a `conversationId` the client persists in
  `localStorage`. Memory now survives a reload and many turns.
- Facts are derived from the **whole stored conversation**, not the browser's window —
  this is what stops "I said idli" being followed by "what did you eat?".
- The prompt now carries a `FACTS ALREADY ESTABLISHED (treat as known, never ask
  again)` ledger plus your own recent replies marked *do NOT repeat these questions*,
  and the food item is now part of the known-details list.
- **Deterministic recall**: "what did I say / ನಾನು ಏನು ಹೇಳಿದೆ / मैंने क्या कहा" is
  answered from the stored turns verbatim — no model guess, so it cannot say "I don't
  know".

Verified over HTTP with correct UTF-8, in all four phrasings:

```
[Kannada] "ನಾನು ಏನು ಹೇಳಿದೆ"        recalled=true  containsCallerWords=true
[Kannada] "ನನ್ನ ಮಾತು ನೆನಪಿದೆಯಾ"    recalled=true  containsCallerWords=true
[Hindi]   "मैंने क्या कहा"           recalled=true  containsCallerWords=true
[English] "what did I say"          recalled=true  containsCallerWords=true
```

## 13. Better STT for Indic languages

`/api/stt` used one model for everything: `whisper-large-v3-turbo`, which is distilled
for English. **Fix:** a per-language chain — Kannada and Hindi prefer
`whisper-large-v3` (materially better Indic accuracy), English keeps `-turbo` for
latency, and each falls back to the other. The decoder is now always seeded with a
domain lexicon in the target script (food items, hotel words, FSSAI terms, complaint
vocabulary) instead of relying on a short IVR-only hint, and the startup credential
check validates **both** STT models so an unavailable one fails loudly instead of
silently degrading captions. `/api/stt` now reports which model produced the text.

## How close this is to a "live" conversation

Implemented: hands-free turn taking from real audio energy, automatic re-arming of
listening the moment the assistant stops speaking, barge-in (start talking and it stops
mid-sentence), and neural voice output in all three languages.

**Not implemented, and worth being clear about:** true full-duplex streaming. Replies
are still synthesised as a whole sentence rather than streamed token-by-token, so
time-to-first-word is ~1–2 s rather than the near-instant feel of a native live
conversation. Doing that properly means streaming the LLM output and speaking it
sentence-by-sentence as it arrives — a larger change I did not want to fold into this
round without your go-ahead.

## Verified vs not verified

Verified locally against the running server: neural TTS in 3 languages, deterministic
recall in 3 languages, memory surviving a client that resends no history, the anchored
IVR matching, the rate limiter, and all admin/PII endpoints returning 401.

**Not verified locally:** the model's *adherence* to the facts ledger (i.e. that it
stops asking "what did you eat?") — `GROQ_API_KEY` is not set in this environment, so
no LLM call could run here. The transcript it receives is verified correct; the
behaviour depends on the deployed model. Worth confirming on your deployment.

## Files changed in this round

| File | Change |
|---|---|
| `server.ts` | Per-language STT chains + domain hints, expanded startup model check, conversations table, memory-aware `/api/chat`, deterministic recall, food item added to the known-details ledger |
| `src/components/VoiceAssistant.tsx` | Neural-first TTS with bounded cache + generation-cancelled fetches, Whisper-authoritative captions, energy-based turn detection, single persistent mic stream for orb + recording, per-language STT hints, persistent conversationId |
| `src/components/IVRDialer.tsx` | Neural `/api/tts` tried before the on-device voice |

---

# Round 4 — why one utterance came back 3 to 7 times

The question was: *"if I talked 3 words but it displayed 3 to 7 times … why not
understanding single word single time?"* There are **two independent multipliers**, and
the reason it survived Round 3 is that nothing collapsed repetition on the paths that
actually ship text.

## 14. Multiplier A — the recogniser re-delivers the same audio, and near-exact copies slipped through

Chrome ends continuous recognition by itself after a pause, and `onend` restarts it —
which **re-feeds the buffered audio**. So one utterance is transcribed again on each
restart cycle.

`cleanSpeechTranscript()` *did* already collapse repeats, but only **exact** ones: it
compares normalised phrases for strict equality. A replayed clip is re-transcribed
*slightly differently* each time (a word ending, a syllable, punctuation), so the copies
never matched and every cycle appended another copy. Your "3 words, 3 to 7 times" is
exactly this: 2 copies, then 3, then more, each one a hair different from the last.

**Fix** — new `collapseRepetitions()` in [src/utils/text.ts](src/utils/text.ts) finds the
**repeating period** rather than matching copies literally:

- *Exact period*: the whole sequence is the same k words repeated N times
  (`words.length % period === 0` and `norm[i] === norm[i % period]`) → keep one period.
- *Near-exact period*: accept a copy whose words are **≥80% positionally equal**, which
  catches the slightly-different re-transcriptions.

It runs first inside `cleanSpeechTranscript()`, so every existing caller
(`mergeTranscripts`, the live caption, the IVR echo) inherits it.

## 15. Multiplier B — the authoritative paths had NO collapsing at all

This is the bigger one, and it is why the symptom persisted:

- `/api/stt` returned Whisper's text **completely raw**, so any repetition the model
  produced went straight into the caption *and* the chat message *and* the LLM prompt
  (which then mirrored it back).
- `stopListeningAndSend()` dispatched `serverText` raw for the same reason.
- If server STT returned nothing (no key, quota, or hallucination-filtered), the code
  **silently fell back to the accumulated browser string** — the very string that had
  been accumulating the extra copies. So the repeats appeared in both places at once.

**Fix**
- `/api/stt` collapses before returning.
- **Whisper loop retry**: a long decoder prompt conditioned on silence is the classic
  trigger for Whisper repetition loops, so when the first result `looksRepetitive()` the
  request is **re-sent without the prompt** and the non-repetitive result wins.
- `/api/chat` and `/api/ivr/dialogue` collapse their incoming message, so the model never
  sees `idli idli idli` and memory stores the clean sentence.
- The client collapses the caption, the Whisper result, and the browser fallback.

## 16. Two more things that were adding copies

- **Double dispatch.** The energy turn detector and the recogniser's own 3.5 s silence
  timer could BOTH fire for one utterance; the second entry found an already-stopped
  recorder, fell through to the browser text, and appended **another identical user
  message**. Now guarded by a per-turn `turnDispatchedRef`.
- **Cross-turn audio contamination.** `stop()` flushes a final `dataavailable`
  asynchronously, and every recorder pushed into one **shared** chunk array — so a late
  flush from the previous turn landed in the *next* turn's recording. Each recorder now
  owns its own buffer, and transcription pins the buffer it was armed with.

## Verification

Deterministic regression test — [test-repetition-collapse.ts](test-repetition-collapse.ts),
run with `npx tsx test-repetition-collapse.ts`:

```
--- exact copies of a 3-word utterance (Kannada) ---
PASS  2x / 3x / 4x / 5x / 6x / 7x / 8x "ಇಡ್ಲಿ ತುಂಬಾ ರುಚಿ"
--- near-exact copies (re-transcribed slightly differently) ---
PASS  3x near-exact mixed        PASS  5x near-exact mixed
--- single word repeated ---
PASS  7x "ಇಡ್ಲಿ"                 PASS  5x "yes"
--- English utterance repeated ---
PASS  3x "I ate idli"            PASS  2x "hello world"      PASS  4x "the worm was"
--- non-repetitive text must pass through untouched ---
PASS  normal Kannada / English / Hindi sentences
PASS  non-adjacent repeats ("one two one two three")
PASS  50% and 75% similar halves (must NOT collapse)
=== 30 passed, 0 failed ===
```

The no-false-positive cases matter as much as the fixes: a legitimate Kannada sentence,
a sentence with a word repeated in a non-adjacent position, and half-similar halves all
pass through **unchanged**, so collapsing cannot damage normal speech.

`tsc --noEmit` is clean on every edited file (only the pre-existing `firebase.ts` errors
remain) and the production build passes (2293 modules, `collapseRepetitions` present in
both the frontend and server bundles).

## Files changed in this round

| File | Change |
|---|---|
| `src/utils/text.ts` | New `collapseRepetitions()` (exact + near-exact period detection), applied first inside `cleanSpeechTranscript()` |
| `src/components/VoiceAssistant.tsx` | Collapsing on caption + Whisper result + browser fallback, single-dispatch guard, per-recorder chunk buffers |
| `src/components/IVRDialer.tsx` | Caller text collapsed before display and dispatch |
| `server.ts` | `collapseRepetitions()`/`looksRepetitive()`, collapse in `/api/stt` with a repetition-triggered prompt retry, collapse of incoming messages in `/api/chat` and `/api/ivr/dialogue` |
| `test-repetition-collapse.ts` | New — 30-case regression test for the repeated-word bug |

---

# Round 5 — caller-scoped memory, one shared memory, New conversation, and "I 8 food"

## 17. Your privacy question drove the whole design

You asked whether one user's information is ever discussed with another. It now
cannot be, and that is **enforced on the server**, not by hiding things in the UI:

- Every conversation row has an **owner** (`phone`).
- `loadConversation(id, phone)` returns a thread **only when the stored owner matches
  the caller**. Presenting someone else's conversation id is refused and logged
  (`[Memory] Refused to serve a conversation owned by a different phone number.`), and
  that caller gets a fresh, empty conversation.
- An unrecognised id may be **reused only if it is genuinely free**. An id that already
  belongs to another caller is never taken over — otherwise a stranger could have
  claimed (and overwritten) someone else's thread just by guessing an id.
- A caller with **no phone number** is treated as "different" from any registered owner,
  so an anonymous session can never claim a thread that belongs to someone.

I built this into the memory layer *before* the convenience features, because adding
cross-device memory without ownership checks is exactly how one person's complaint ends
up in another person's transcript.

Verified against the running server — [test-memory-isolation.mjs](test-memory-isolation.mjs)
(`node test-memory-isolation.mjs`, needs the dev server running):

```
PASS  A can store a turn
PASS  B with A's conversationId sees NOTHING
PASS  B's reply contains no A content
PASS  A with their own id CAN read it
PASS  A on a new device resumes their own memory
PASS  B with no id has no history to adopt
PASS  a fresh id after closing starts empty
PASS  the closed thread is never resurrected
PASS  B cannot close or break A's thread
=== isolation: 9 passed, 0 failed ===
```

## 18. Memory now follows the caller, not the browser

`conversations.phone` + `findLatestConversationForPhone()` let a returning caller
continue their own thread from a new device. The client no longer invents an id on first
run: sending **no** id is the "I have nothing stored here" signal that triggers adoption
of the caller's own latest open thread. An id the server does not recognise instead means
"start fresh" — which is what the New conversation button does.

## 19. One memory across both surfaces

- `/api/chat` now injects the caller's **recent phone-call history** (last 3 calls and
  last 3 complaints, via the existing `loadCallerMemory`) into the prompt.
- `/api/ivr/dialogue` now injects what the caller already said on the **website chat**
  via the new `loadWebChatCallerMemory()` — compact derived facts (issue, food, place,
  when), never the raw transcript of another thread.

Both are keyed by phone number only, so the sharing is between *a caller's own*
sessions, never between callers.

## 20. New conversation

A `+` control in the chat header. It closes the old thread server-side
(`POST /api/chat/new`), rotates the id, clears the messages, the reply cache and the
in-flight listening state. Verified: a fresh id afterwards starts empty, and the closed
thread is not resurrected by the "latest open thread" lookup.

## 21. Why the caption said "I 8 food"

Speech models emit the **digit for a word that sounds the same** — "ate" → `8`,
"for" → `4`, "to" → `2` — when the clip is short or slightly unclear. Nothing in the
pipeline was pulling those back, and our decoder prompt listed food vocabulary but **no
verbs**, so there was nothing biasing the model toward "ate".

Two fixes:
1. **Prompt bias** — the English STT hint now leads with the verbs
   (*"I ate, we ate, had, ordered, drank…"*).
2. **A conservative corrector**, `normalizeRecognizedText()`, applied to the final
   transcript on both server and client. It only rewrites a digit where a quantity
   cannot be meant — and it **protects real numbers first**: an `8` after a preposition
   or an identifier (`at 8`, `room 8`, `table 8`, `on 8 August`) is spelled out so the
   later rules physically cannot touch it.

```
PASS  "I 8 food" -> "I ate food"          PASS  "we 8 breakfast" -> "we ate breakfast"
PASS  "8 my lunch" -> "ate my lunch"      PASS  "I want 2 go" -> "I want to go"
PASS  "I 8 at 8 pm" -> "I ate at eight pm"
--- real quantities left alone ---
PASS  "8 idlis were served"    PASS  "2 dosas and 4 vadas"    PASS  "I paid 200 rupees"
PASS  "at 8 the food was cold" -> "at eight the food was cold"   (meaning preserved)
PASS  "room 8 was dirty" -> "room eight was dirty"    PASS  "I waited 9 minutes"
```

`test-repetition-collapse.ts` is 52 cases, all passing.

## Verification summary for this round

| Check | Result |
|---|---|
| `tsc --noEmit` (all edited files) | clean (only the pre-existing `firebase.ts` errors) |
| `npm run build` | passes (frontend + server bundle) |
| `test-repetition-collapse.ts` | 52 / 52 |
| `test-memory-isolation.mjs` | 9 / 9 |

## Files changed in this round

| File | Change |
|---|---|
| `server.ts` | `phone` owner column + index, ownership-enforced `loadConversation`, `isConversationOwnedByOther`, `findLatestConversationForPhone`, `closeConversation`, `POST /api/chat/new`, cross-surface memory both ways, digit-homophone correction, verb-led English STT hint |
| `src/components/VoiceAssistant.tsx` | New conversation control + `startNewConversation()`, conversation id no longer invented client-side, homophone correction applied to the final transcript |
| `src/utils/text.ts` | `normalizeRecognizedText()` with quantity protection |
| `test-repetition-collapse.ts` | Extended to 52 cases (repetition, homophones, quantity protection) |
| `test-memory-isolation.mjs` | New — 9-case cross-caller privacy regression test |

## Still open, stated plainly

- **A known phone number is still enough to read that person's complaints** via
  `GET /api/complaints?phone=…`. It now needs the full 10-digit number (a partial one is
  refused), but there is no ownership proof. Real protection needs a one-time code sent
  to the phone. That needs an SMS provider and a UX decision, so I have not changed it.
- Shared-device caveat: if two people use the same browser and the *same phone number* is
  configured in the profile, the second person sees the first's thread — the app has one
  profile per install. Different phone numbers are now fully separated.

---

# Round 6 — "it said I remembered, but didn't tell me anything"

Reported: *"if I asked do you remember, it said I remembered but not tell anything and
said how can I help you? why? is it a database issue?"*

**Partly a bug, partly the database — both are real, and I could reproduce the first one.**

## 22. Bug A: "do you remember?" never reached the memory code

The recall trigger was `\bdo you remember what i\b` — it required the words **"what i"**
to follow. So a bare *"do you remember?"* did not match, fell through to the model, and
the model — having no instruction to be careful — agreed it remembered and then asked
"how can I help you?". That is exactly what you saw.

The patterns now cover natural phrasing: *do you remember / did you remember / can you
recall / do you remember me / what do you remember about me / you remember that / did I
already tell you*, plus Kannada and Hindi equivalents (*ನೆನಪಿದೆಯಾ, ನೆನಪಿದೆ, ಜ್ಞಾಪಕ,
याद है, मुझे याद*).

A bare remember-question is treated as a recall request **only when nothing substantial
follows it**, so *"do you remember what FSSAI is?"* is still answered as a normal
question rather than a memory lookup. Verified.

## 23. Bug B (the bigger one): it listed your *questions* instead of your complaint

This is the part that made it look like it remembered nothing. The recall reply listed
your **last 6 turns verbatim**. So the moment you asked twice, those questions filled the
list and pushed the actual complaint out — and the "memory" answer became a list of your
own questions:

```
Here is what you've told me so far:
• do you remember?
• what did I say?
• did you remember?
```

It now lists only **substantive statements**: questions, bare acknowledgements
("yes", "ok", "sari") and under-3-word fragments are filtered out, duplicates removed. If
nothing substantive remains it says so honestly instead of pretending.

## 24. Bug C: nothing stopped the model from claiming memory it didn't have

The prompt now carries a **honesty block driven by whether memory is actually empty**:

- Memory empty → *"You have NOT been told anything yet... do NOT say 'yes, I remember'."*
- Memory present → *"never claim to recall a specific thing unless it is actually written above."*

Plus: never invent a place, food item, date or complaint reference.

## 25. The database question — yes, this can be your real problem

If `TURSO_DATABASE_URL` is not set, conversation memory lives **only inside the running
server process**. It is lost on every restart, and on serverless hosting each instance
keeps its own copy — so consecutive messages can land on different instances and appear
to forget. That is indistinguishable from "the AI is dumb", and it is a database issue.

**Check it in one request:**

```
GET https://<your-deployment>/api/health
```

It reports `database: "configured" | "missing"`, `memoryIsDurable`, how many
conversations are in the DB vs in memory, and the LLM key state — no credentials
exposed. In this local environment it returns:

```
database=missing  durable=false  inMemory=43  inDb=null
note: TURSO_DATABASE_URL is NOT set. Memory lives only inside this running server
process: it is LOST on every restart ... This is the cause of 'it forgot what I said'.
```

The startup log now says the same thing, so a missing database can no longer be missed.

## Verified

| Check | Result |
|---|---|
| `test-recall-intent.mjs` (14 cases) | **14 / 14** |
| `test-memory-isolation.mjs` | **9 / 9** (re-run after the recall change) |
| `test-repetition-collapse.ts` | **52 / 52** |
| `tsc --noEmit` | clean (only the pre-existing `firebase.ts` errors) |
| `npm run build` | passes |

```
PASS  "do you remember?" on an EMPTY conversation refuses, does not claim
PASS  "do you remember?" recalls the real words
PASS  "did you remember?" recalls the real words
PASS  "can you recall?" recalls the real words
PASS  repeated asks still return the content, not the questions
PASS  Kannada "ನೆನಪಿದೆಯಾ?" recalls
PASS  Hindi "क्या आपको याद है?" recalls
PASS  "do you remember what FSSAI is?" is NOT treated as a memory lookup
```

## One side effect worth knowing

The per-IP rate limit I added earlier (60 requests/minute on `/api/chat`) throttles rapid
automated testing — my own test suite started receiving HTTP 429 until I spaced the runs
out. A human conversation never comes close to that limit, so this is expected
behaviour, not a bug.

## Files changed in this round

| File | Change |
|---|---|
| `server.ts` | Broadened `RECALL_PATTERNS` + bare remember-question handling, `isSubstantiveUtterance`, rewritten `buildRecallReply`, memory honesty block driven by `hasAnyMemory`, `GET /api/health`, clearer missing-database startup warning |
| `test-recall-intent.mjs` | New — 14-case recall-intent and honesty suite |
| `test-memory-isolation.mjs` | Assertion updated to the new refusal wording |
