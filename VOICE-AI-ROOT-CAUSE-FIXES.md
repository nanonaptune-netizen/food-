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
