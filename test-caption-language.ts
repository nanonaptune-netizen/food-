// Verify the live-caption trust rules.
//
// Reported bug: "Kannada is understood well, but the caption shows improper /
// unrelated Kannada." The cause was that the caption came from Chrome's own
// recogniser (which ignores lang='kn-IN' on desktop) while the text sent to the
// model came from Whisper. These rules make Whisper the only caption source for
// Kannada/Hindi.
//
// Run: npx tsx test-caption-language.ts
import {
  browserPreviewIsTrustworthy,
  matchesSelectedScript,
  chooseCaption,
  LISTENING_HINT,
  RECOGNISING_HINT,
  REPEAT_HINT,
} from './src/utils/text';

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail = '') {
  if (condition) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

console.log('--- which engine may be trusted as a caption? ---');
check('English browser preview is trusted', browserPreviewIsTrustworthy('English') === true);
check('Kannada browser preview is NOT trusted', browserPreviewIsTrustworthy('Kannada') === false);
check('Hindi browser preview is NOT trusted', browserPreviewIsTrustworthy('Hindi') === false);

console.log('\n--- script matching ---');
const KN = 'ಇಡ್ಲಿ ತುಂಬಾ ರುಚಿಯಾಗಿತ್ತು';
const HI = 'आज खाना ठीक नहीं था';
check('Kannada text matches Kannada', matchesSelectedScript(KN, 'Kannada') === true);
check('Kannada text does NOT match Hindi', matchesSelectedScript(KN, 'Hindi') === false);
check('Hindi text matches Hindi', matchesSelectedScript(HI, 'Hindi') === true);
check('Hindi text does NOT match Kannada', matchesSelectedScript(HI, 'Kannada') === false);
check('English text matches English', matchesSelectedScript('I ate idli', 'English') === true);
check('Kannada text does NOT match English', matchesSelectedScript(KN, 'English') === false);
check('empty text matches nothing', matchesSelectedScript('   ', 'Kannada') === false);

console.log('\n--- the reported bug: Kannada speech, wrong browser guess ---');
// Chrome ignored kn-IN and produced unrelated words; Whisper heard the caller.
const browserGarbage = 'idli dosa hotel yesterday worm hai';
const whisperCorrect = 'ನಿನ್ನೆ ಹೋಟೆಲ್‌ನಲ್ಲಿ ಇಡ್ಲಿಯಲ್ಲಿ ಹುಳು ಇತ್ತು';
const captionKn = chooseCaption(whisperCorrect, browserGarbage, 'Kannada');
check('caption uses the Whisper text', captionKn === whisperCorrect, captionKn);
check('caption is proper Kannada', /[\u0C80-\u0CFF]/.test(captionKn), captionKn);
check('browser text never appears in the caption', !captionKn.includes('dosa'), captionKn);

console.log('\n--- Whisper empty: caption must stay empty, not fall back to the browser ---');
check('Kannada: no browser fallback', chooseCaption('', browserGarbage, 'Kannada') === '');
check('Hindi: no browser fallback', chooseCaption('', 'aaj khana kharab tha', 'Hindi') === '');
check('English: browser fallback is allowed', chooseCaption('', 'I ate idli', 'English') === 'I ate idli');
check('English: non-Latin fallback rejected', chooseCaption('', KN, 'English') === '');

console.log('\n--- placeholders are in the caller\'s language ---');
for (const lang of ['English', 'Hindi', 'Kannada']) {
  check(`${lang}: listening hint present`, !!LISTENING_HINT[lang]);
  check(`${lang}: recognising hint present`, !!RECOGNISING_HINT[lang]);
  check(`${lang}: repeat hint present`, !!REPEAT_HINT[lang]);
}
check('Kannada listening hint is Kannada', /[\u0C80-\u0CFF]/.test(LISTENING_HINT.Kannada), LISTENING_HINT.Kannada);
check('Kannada repeat hint is Kannada', /[\u0C80-\u0CFF]/.test(REPEAT_HINT.Kannada), REPEAT_HINT.Kannada);
check('Hindi listening hint is Hindi', /[\u0900-\u097F]/.test(LISTENING_HINT.Hindi), LISTENING_HINT.Hindi);
check('Kannada hint is not Hindi', !/[\u0900-\u097F]/.test(LISTENING_HINT.Kannada), LISTENING_HINT.Kannada);

console.log(`\n=== caption language: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
