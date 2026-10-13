// Deterministic test for the repetition collapsing that fixes
// "I said 3 words and it showed them 3 to 7 times".
import { collapseRepetitions, cleanSpeechTranscript, mergeTranscripts, normalizeRecognizedText } from './src/utils/text';

let pass = 0;
let fail = 0;

function check(label: string, actual: string, expected: string) {
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual  : ${JSON.stringify(actual)}`);
  }
}

const idli = 'ಇಡ್ಲಿ ತುಂಬಾ ರುಚಿ';           // 3 words, Kannada
const idliNear = 'ಇಡ್ಲಿ ತುಂಬ ರುಚಿ';          // near-exact variant (ತುಂಬಾ -> ತುಂಬ)

// --- The reported symptom: 3 words shown N times ---------------------------
console.log('\n--- exact copies of a 3-word utterance (Kannada) ---');
for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  check(`${n}x exact "${idli}"`, collapseRepetitions(Array(n).fill(idli).join(' ')), idli);
}

console.log('\n--- near-exact copies (re-transcribed slightly differently) ---');
check('3x near-exact mixed', collapseRepetitions([idli, idliNear, idliNear].join(' ')), idli);
check('5x near-exact mixed', collapseRepetitions([idli, idliNear, idli, idliNear, idliNear].join(' ')), idli);

console.log('\n--- single word repeated ---');
check('7x "ಇಡ್ಲಿ"', collapseRepetitions(Array(7).fill('ಇಡ್ಲಿ').join(' ')), 'ಇಡ್ಲಿ');
check('5x "yes"', collapseRepetitions(Array(5).fill('yes').join(' ')), 'yes');

console.log('\n--- English utterance repeated ---');
check('3x "I ate idli"', collapseRepetitions(Array(3).fill('I ate idli').join(' ')), 'I ate idli');
check('2x "hello world"', collapseRepetitions('hello world hello world'), 'hello world');
check('4x "the worm was"', collapseRepetitions(Array(4).fill('the worm was').join(' ')), 'the worm was');

console.log('\n--- punctuation / whitespace variants ---');
check('"ರುಚಿ, ರುಚಿ ರುಚಿ"', collapseRepetitions('ರುಚಿ, ರುಚಿ ರುಚಿ'), 'ರುಚಿ,');
check('double spaces', collapseRepetitions('  idli   idli   idli  '), 'idli');

// --- MUST NOT change legitimate text (no false positives) ------------------
console.log('\n--- non-repetitive text must pass through untouched ---');
const untouched: Array<[string, string]> = [
  ['single word', 'ಇಡ್ಲಿ'],
  ['short English', 'yes'],
  ['normal Kannada sentence', 'ಅನ್ನಪೂರ್ಣ ಹೋಟೆಲ್‌ನಲ್ಲಿ ಇಡ್ಲಿಯಲ್ಲಿ ಹುಳು ಇತ್ತು ಎಂದು ನಾನು ಹೇಳುತ್ತೇನೆ'],
  ['normal English sentence', 'I found a worm in the idli at Annapurna hotel yesterday'],
  ['normal Hindi sentence', 'मैंने कल होटल में खाना खाया था और उसमें कीड़ा था'],
  ['words repeat non-adjacently', 'one two one two three'],
  ['repeated single word inside sentence', 'the food the food was bad today honestly'],
  ['half-similar halves (50%)', 'idli dosa worm hair'],
  ['three-quarter-similar halves (75%)', 'idli dosa worm idli dosa hair'],
];
for (const [label, text] of untouched) {
  check(label, collapseRepetitions(text), text);
}

// --- The full pipeline the app actually uses -------------------------------
console.log('\n--- cleanSpeechTranscript (adds consecutive-word and phrase dedupe) ---');
check('3x via cleanSpeechTranscript', cleanSpeechTranscript(Array(3).fill(idli).join(' ')), idli);
check('doubled consecutive words', cleanSpeechTranscript('the the the worm was in in the idli'), 'the worm was in the idli');

console.log('\n--- mergeTranscripts seams (browser restart overlap) ---');
check('identical seam', mergeTranscripts(idli, idli), idli);
check('partial seam', mergeTranscripts('ಇಡ್ಲಿ ತುಂಬಾ ರುಚಿ', 'ರುಚಿ ಆದರೆ ಹುಳು'), 'ಇಡ್ಲಿ ತುಂಬಾ ರುಚಿ ಆದರೆ ಹುಳು');
check('no overlap keeps both', mergeTranscripts('ಇಡ್ಲಿ ಚೆನ್ನಾಗಿತ್ತು', 'ಹುಳು ಇತ್ತು'), 'ಇಡ್ಲಿ ಚೆನ್ನಾಗಿತ್ತು ಹುಳು ಇತ್ತು');

// --- Digit homophones: "I 8 food" -> "I ate food" --------------------------
console.log('\n--- digit homophones that MUST be corrected ---');
const corrected: Array<[string, string]> = [
  ['I 8 food', 'I ate food'],
  ['i 8 food', 'i ate food'],
  ['I 8 idli and it was stale', 'I ate idli and it was stale'],
  ['we 8 breakfast', 'we ate breakfast'],
  ['they 8 the rice', 'they ate the rice'],
  ['8 my lunch', 'ate my lunch'],
  ['8 food', 'ate food'],
  ['give it 4 me', 'give it for me'],
  ['come 2 me', 'come to me'],
  ['I want 2 go', 'I want to go'],
  ['I 8 at 8 pm', 'I ate at eight pm'],
];
for (const [input, expected] of corrected) {
  check(`"${input}"`, normalizeRecognizedText(input), expected);
}

console.log('\n--- real quantities that MUST NOT be touched ---');
const quantities: Array<[string, string]> = [
  ['I ate at 8 pm', 'I ate at eight pm'],           // only "8" -> "eight", meaning kept
  ['at 8 the food was cold', 'at eight the food was cold'],
  ['8 idlis were served', '8 idlis were served'],
  ['2 dosas and 4 vadas', '2 dosas and 4 vadas'],
  ['I paid 200 rupees', 'I paid 200 rupees'],
  ['room 8 was dirty', 'room eight was dirty'],
  ['8 kg rice', '8 kg rice'],
  ['on 8 August', 'on eight August'],
  ['table 8 had hair', 'table eight had hair'],
  ['I waited 9 minutes', 'I waited 9 minutes'],
];
for (const [input, expected] of quantities) {
  check(`"${input}"`, normalizeRecognizedText(input), expected);
}

// The full pipeline the app applies to a final transcript.
console.log('\n--- combined: collapse then normalise ---');
check(
  'repeated + homophone',
  normalizeRecognizedText(collapseRepetitions('I 8 food I 8 food I 8 food')),
  'I ate food'
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
