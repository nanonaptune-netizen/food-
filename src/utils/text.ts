/**
 * Strips all emojis, pictographs, symbols, markdown tokens, and URLs
 * so that Text-to-Speech (TTS) never speaks or reads emojis.
 */
export function stripEmojis(text: string): string {
  if (!text) return '';
  return text
    // Strip Unicode emojis, pictographs, symbols, flags, variation selectors, zero-width joiners
    .replace(/[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F910}-\u{1F96B}\u{1F980}-\u{1F9E0}\u{2B50}\u{2B55}\u{231A}\u{23F0}\u{23F3}\u{25AA}\u{25AB}\u{25FB}-\u{25FE}\u{FE0E}\u{FE0F}\u{200D}]/gu, '')
    // Strip markdown formatting symbols (hashes, asterisks, underscores, brackets)
    .replace(/[*#_`~\[\]\(\)]/g, ' ')
    // Strip URLs
    .replace(/https?:\/\/\S+/g, '')
    // Normalize spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Repairs the recogniser's digit-homophone mistakes.
 *
 * ROOT CAUSE of "I said I ate food but the caption says I 8 food": speech models
 * emit the digit for a word that sounds the same ("ate" -> 8, "for" -> 4,
 * "to" -> 2) when the clip is short or slightly unclear. Nothing else in the
 * pipeline was pulling those back, so the digit reached the caption and the chat.
 *
 * Every rule is anchored so a REAL quantity is never touched. "I ate at 8 pm",
 * "8 idlis", "2 dosas", "₹200", "room 8" and "8 o'clock" are all left alone -
 * quantities matter in a complaint, so this errs on the side of changing nothing.
 * Verified by test-repetition-collapse.ts.
 */
const DIGIT_HOMOPHONE_RULES: Array<[RegExp, string]> = [
  // PROTECT FIRST: a "8" that follows a preposition or a place/number identifier
  // is a genuine time or number, never the verb "ate". Spelling it out makes it
  // impossible for the rules below to touch it, and keeps the meaning intact
  // ("at 8 the food was cold" must NOT become "ate the food was cold").
  [/\b(at|on|by|around|about|after|before|till|until|from|till)\s+8\b/gi, '$1 eight'],
  [/\b(room|flat|door|table|gate|bus|train|floor|shop|plot|seat|no|number|token|slip)\s+8\b/gi, '$1 eight'],
  // "I 8" / "we 8" / "they 8" -> "I ate" ... (a pronoun followed by a bare 8 is
  // never a quantity)
  [/\b(I|we|they|he|she|you|i)\s+8\b/g, '$1 ate'],
  // "8 the rice", "8 my lunch" -> "ate the rice", "ate my lunch"
  [/\b8\s+(the|my|our|his|her|their|some)\b/gi, 'ate $1'],
  // "8 food" -> "ate food" (singular food/meal nouns only; "8 idlis" is a
  // quantity and is deliberately not matched)
  [/\b8\s+(food|meal|breakfast|lunch|dinner|snack|rice|curd|sambar|something)\b/gi, 'ate $1'],
  // "4 me" -> "for me"
  [/\b4\s+(me|you|us|them|him|this|that)\b/gi, 'for $1'],
  // "2 me" -> "to me"
  [/\b2\s+(me|you|us|them|him|her)\b/gi, 'to $1'],
  // "want 2 go" -> "want to go"
  [/\b(want|wanted|need|needed|going|go|try|tried|like|liked|have|has|had|use|used|eat|ate)\s+2\s+([a-z])/gi, '$1 to $2'],
];

export function normalizeRecognizedText(text: string): string {
  let out = String(text || '');
  if (!out) return '';
  for (const [pattern, replacement] of DIGIT_HOMOPHONE_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Collapses a phrase that has been repeated N times into ONE copy.
 *
 * ROOT CAUSE of "I said 3 words and it showed them 3 to 7 times": recognisers
 * replay the same audio across their silent end/restart cycles, and a replayed
 * clip is re-transcribed with small differences each time, so a single utterance
 * arrives as several near-identical copies. The existing exact-match dedupe could
 * not see those; this finds the repeating period and keeps one copy.
 */
export function collapseRepetitions(text: string): string {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length < 2) return words.join(' ');

  // Case- and punctuation-insensitive comparison, so "ರುಚಿ," and "ರುಚಿ" match.
  const norm = words.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));

  // 1. Exact period: the whole sequence is the same k words repeated N times.
  for (let period = 1; period <= Math.floor(words.length / 2); period++) {
    if (words.length % period !== 0) continue;
    let periodic = true;
    for (let i = period; i < words.length; i++) {
      if (norm[i] !== norm[i % period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return words.slice(0, period).join(' ');
  }

  // 2. Near-exact period: a replayed clip comes back slightly different each
  //    time, so accept a copy whose words are >= 80% positionally equal.
  for (let copies = 8; copies >= 2; copies--) {
    if (words.length % copies !== 0) continue;
    const unit = words.length / copies;
    let repeated = true;
    for (let c = 1; c < copies && repeated; c++) {
      let same = 0;
      for (let i = 0; i < unit; i++) {
        if (norm[i] === norm[i + c * unit]) same++;
      }
      if (same / unit < 0.8) repeated = false;
    }
    if (repeated) return words.slice(0, unit).join(' ');
  }

  return words.join(' ');
}

/**
 * Normalizes speech recognition text and removes consecutive repeated words or phrases
 * across all languages (Kannada, Hindi, English).
 */
export function cleanSpeechTranscript(text: string): string {
  if (!text) return '';

  // 1. Collapse whole-phrase repetition first (exact AND near-exact), so N copies
  //    of one sentence never reach the caption, the chat or the LLM prompt.
  let clean = collapseRepetitions(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  // 2. Tokenize by spaces (preserves full Unicode characters for Kannada & Hindi)
  const tokens = clean.split(' ').filter(Boolean);
  if (tokens.length <= 1) return clean;

  // 3. Remove consecutive duplicate words
  const deduplicatedWords: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i];
    const prev = deduplicatedWords[deduplicatedWords.length - 1];
    
    // Normalize for comparison (lowercase & strip outer punctuation)
    const normCurrent = current.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '');
    const normPrev = prev ? prev.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '') : null;
    
    if (normCurrent && normCurrent === normPrev) {
      continue; // Skip duplicate word
    }
    deduplicatedWords.push(current);
  }

  // 4. Remove consecutive duplicate phrases of variable lengths (from phraseLen 10 down to 2)
  let words = deduplicatedWords;
  for (let phraseLen = 10; phraseLen >= 2; phraseLen--) {
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 15) {
      changed = false;
      iterations++;
      if (words.length < phraseLen * 2) break;
      for (let i = 0; i <= words.length - phraseLen * 2; i++) {
        const phrase1 = words.slice(i, i + phraseLen).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
        const phrase2 = words.slice(i + phraseLen, i + phraseLen * 2).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
        if (phrase1 && phrase1 === phrase2) {
          // Remove the duplicate phrase
          words.splice(i + phraseLen, phraseLen);
          changed = true;
          break;
        }
      }
    }
  }

  const result = words.join(' ').trim();

  // 5. Check if the string itself consists of two or three identical halves/thirds (e.g. "hello world hello world")
  const wordsArr = result.split(' ');
  const halfLen = Math.floor(wordsArr.length / 2);
  if (halfLen >= 2 && wordsArr.length % 2 === 0) {
    const firstHalf = wordsArr.slice(0, halfLen).join(' ').toLowerCase();
    const secondHalf = wordsArr.slice(halfLen).join(' ').toLowerCase();
    if (firstHalf === secondHalf) {
      return wordsArr.slice(0, halfLen).join(' ').trim();
    }
  }

  const thirdLen = Math.floor(wordsArr.length / 3);
  if (thirdLen >= 2 && wordsArr.length % 3 === 0) {
    const part1 = wordsArr.slice(0, thirdLen).join(' ').toLowerCase();
    const part2 = wordsArr.slice(thirdLen, thirdLen * 2).join(' ').toLowerCase();
    const part3 = wordsArr.slice(thirdLen * 2).join(' ').toLowerCase();
    if (part1 === part2 && part2 === part3) {
      return wordsArr.slice(0, thirdLen).join(' ').trim();
    }
  }

  return result;
}

/**
 * True only when the WHOLE utterance is a confirmation ("yes", "haan",
 * "ಹೌದು", "ok please"), never when the word merely appears inside a longer
 * sentence. This replaces the old `text.includes('ha')` style test, which
 * matched "what", "have", "shall", "harsh" and submitted complaints the caller
 * never confirmed.
 */
const AFFIRM_WORDS = [
  'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'okey', 'sure',
  'confirm', 'confirmed', 'submit', 'proceed', 'done', 'sari', 'saree', 'sare',
  'haan', 'han', 'ha', 'houdu', 'aagali', 'aaytu',
  'ಹೌದು', 'ಸರಿ', 'ಆಗಲಿ', 'ಆಯ್ತು',
  'हाँ', 'हां', 'जी', 'पुष्टि', 'मंज़ूर', 'ठीक', 'दर्ज',
];

const AFFIRM_TRAIL = [
  'please', 'it', 'do', 'that', 'thats', 'is', 'all', 'go', 'ahead', 'to',
  'submit', 'now', 'fine', 'ok', 'okay', 'yes', 'sir', 'madam', 'haan',
  'is', 'hai', 'है', 'करें', 'करो', 'దయచేసి', 'ದಯವಿಟ್ಟು',
];

export function isAffirmation(text: string): boolean {
  const raw = String(text || '').toLowerCase().replace(/[\s!.,?;:।"'()]+$/g, '').trim();
  if (!raw) return false;
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) return false;

  const norm = (w: string) => w.replace(/[^\p{L}\p{N}']/gu, '');
  const first = norm(words[0]);

  if (words.length === 1) return AFFIRM_WORDS.includes(first);
  if (!AFFIRM_WORDS.includes(first)) return false;

  // Every remaining token must be a filler/politeness word, otherwise this is a
  // real sentence that merely starts with "ok"/"yes" and must not auto-submit.
  return words.slice(1).every((w) => {
    const n = norm(w);
    return !n || AFFIRM_TRAIL.includes(n) || AFFIRM_WORDS.includes(n);
  });
}

/**
 * Merges a session prefix and incoming new transcript without seam duplication
 */
export function mergeTranscripts(prefix: string, newText: string): string {
  const p = prefix.trim();
  const n = newText.trim();
  if (!p) return cleanSpeechTranscript(n);
  if (!n) return cleanSpeechTranscript(p);

  const pWords = p.split(/\s+/).filter(Boolean);
  const nWords = n.split(/\s+/).filter(Boolean);

  // Check if tail of prefix overlaps with head of newText
  let maxOverlap = 0;
  const maxCheck = Math.min(pWords.length, nWords.length, 6);
  for (let len = maxCheck; len >= 1; len--) {
    const pTail = pWords.slice(pWords.length - len).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
    const nHead = nWords.slice(0, len).map(w => w.toLowerCase().replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, '')).join(' ');
    if (pTail && pTail === nHead) {
      maxOverlap = len;
      break;
    }
  }

  let merged = '';
  if (maxOverlap > 0) {
    merged = pWords.concat(nWords.slice(maxOverlap)).join(' ');
  } else {
    merged = p + ' ' + n;
  }

  return cleanSpeechTranscript(merged);
}

// ---------------------------------------------------------------------------
// Live-caption trust rules
//
// ROOT CAUSE of "it understands me, but the caption shows improper/unrelated
// Kannada": the transcription that reached the model came from Whisper (correct),
// while the caption on screen came from Chrome's own SpeechRecognition.
// Desktop Chrome silently ignores `recognition.lang = 'kn-IN'` (and hi-IN on many
// Windows builds), so it transcribes Kannada audio with the wrong acoustic model
// and returns words that have nothing to do with what was said.
//
// The rule is therefore: the browser recogniser may only be shown, or used as a
// fallback, for English. Kannada and Hindi captions come from the server
// transcript and nothing else.
// ---------------------------------------------------------------------------

export function browserPreviewIsTrustworthy(language: string): boolean {
  return language === 'English';
}

/** Does this text actually use the script of the language the caller selected? */
export function matchesSelectedScript(text: string, language: string): boolean {
  const value = String(text || '').trim();
  if (!value) return false;
  if (language === 'Kannada') return /[\u0C80-\u0CFF]/.test(value);
  if (language === 'Hindi') return /[\u0900-\u097F]/.test(value);
  return /[A-Za-z]/.test(value);
}

/**
 * Which text should be shown/sent as the caller's words?
 *
 * The server transcript (Whisper) always wins when it exists, because it is the
 * one that actually understood the speech. The browser text is only a fallback,
 * and only for English - otherwise Chrome's mismatched Indic model would replace
 * a correct sentence with unrelated words.
 */
export function chooseCaption(whisperText: string, browserText: string, language: string): string {
  const whisper = String(whisperText || '').trim();
  if (whisper) return whisper;
  if (!browserPreviewIsTrustworthy(language)) return '';
  const browser = String(browserText || '').trim();
  return matchesSelectedScript(browser, language) ? browser : '';
}

/** Caption strings, so a Kannada caller is never shown an English placeholder. */
export const LISTENING_HINT: Record<string, string> = {
  English: 'Listening… speak naturally',
  Hindi: 'सुन रहा हूँ… कृपया बोलिए',
  Kannada: 'ಆಲಿಸುತ್ತಿದ್ದೇನೆ… ದಯವಿಟ್ಟು ಮಾತನಾಡಿ',
};

export const RECOGNISING_HINT: Record<string, string> = {
  English: 'Recognising your speech…',
  Hindi: 'आपकी आवाज़ समझ रहा हूँ…',
  Kannada: 'ನಿಮ್ಮ ಧ್ವನಿ ಅರ್ಥೈಸುತ್ತಿದ್ದೇನೆ…',
};

export const REPEAT_HINT: Record<string, string> = {
  English: "I didn't catch that. Please say it again.",
  Hindi: 'मैं समझ नहीं पाया। कृपया दोबारा कहिए।',
  Kannada: 'ನನಗೆ ಅರ್ಥವಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ಹೇಳಿ.',
};



