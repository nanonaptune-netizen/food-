// Verify TOPIC memory: a follow-up question must be answered about the subject
// that was being discussed (FSSAI, licensing, complaints ...), never about the
// app itself.
//
// The reported bug: "1st I asked about FSSAI, 2nd I asked how it works - it
// explained how the APP works instead."
//
// Run with the dev server up:  node test-topic-memory.mjs
const base = 'http://127.0.0.1:3000';

const STAMP = Date.now().toString().slice(-8);
const PHONE = `97${STAMP}`;

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

async function chat(message, { conversationId, language = 'English', clientTopics } = {}) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      message,
      language,
      conversationId: conversationId || undefined,
      clientTopics,
      profile: { name: 'Test', phone: PHONE },
    }),
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, ...body };
}

const text = (r) => String(r.response || '');
// Anything that would mean the assistant answered about itself.
const TALKS_ABOUT_ITSELF = /(this app|the app works|chatbot|website works|I am an AI|as an AI|this platform|my features)/i;

// wait for the server
let up = false;
for (let i = 0; i < 60; i++) {
  try { await fetch(`${base}/api/complaints`); up = true; break; }
  catch { await new Promise((r) => setTimeout(r, 800)); }
}
if (!up) { console.log('SERVER NOT UP'); process.exit(1); }

// ---------------------------------------------------------------- English
console.log('\n--- English: "what is FSSAI?" then "how does it work?" ---');
const convEn = `topic-en-${STAMP}`;

const def = await chat('What is FSSAI?', { conversationId: convEn });
check('1. definition names the authority', /Food Safety and Standards Authority/i.test(text(def)), text(def).slice(0, 120));
check('1b. topic recorded as fssai', def.topic === 'fssai', JSON.stringify(def.topic));

const how = await chat('How does it work?', { conversationId: convEn });
check('2. follow-up answers about FSSAI, not the app', /licen|inspect|test|standard/i.test(text(how)), text(how).slice(0, 160));
check('2b. follow-up does NOT describe the app', !TALKS_ABOUT_ITSELF.test(text(how)), text(how).slice(0, 160));
check('2c. follow-up is not a repeat of the definition', text(how) !== text(def), 'identical reply');
check('2d. topic still fssai', how.topic === 'fssai', JSON.stringify(how.topic));

const more = await chat('tell me more', { conversationId: convEn });
check('3. "tell me more" stays on the same subject', more.topic === 'fssai' && text(more).length > 20, text(more).slice(0, 120));
check('3b. "tell me more" does not describe the app', !TALKS_ABOUT_ITSELF.test(text(more)), text(more).slice(0, 160));

// ---------------------------------------------------------------- Hindi
console.log('\n--- Hindi ---');
const convHi = `topic-hi-${STAMP}`;
const defHi = await chat('FSSAI क्या है?', { conversationId: convHi, language: 'Hindi' });
check('4. Hindi definition is in Hindi and about FSSAI', /खाद्य/.test(text(defHi)) && /प्राधिकरण/.test(text(defHi)), text(defHi).slice(0, 120));

const howHi = await chat('यह कैसे काम करता है?', { conversationId: convHi, language: 'Hindi' });
check('5. Hindi follow-up answers about FSSAI', /लाइसेंस|जाँच|मानक/.test(text(howHi)), text(howHi).slice(0, 160));
check('5b. Hindi follow-up is not about the app', !/(यह ऐप|चैटबॉट|वेबसाइट)/.test(text(howHi)), text(howHi).slice(0, 160));

// ---------------------------------------------------------------- Kannada
console.log('\n--- Kannada ---');
const convKn = `topic-kn-${STAMP}`;
const defKn = await chat('FSSAI ಎಂದರೆ ಏನು?', { conversationId: convKn, language: 'Kannada' });
check('6. Kannada definition is in Kannada and about FSSAI', /ಆಹಾರ/.test(text(defKn)) && /ಪ್ರಾಧಿಕಾರ/.test(text(defKn)), text(defKn).slice(0, 120));

const howKn = await chat('ಅದು ಹೇಗೆ ಕೆಲಸ ಮಾಡುತ್ತದೆ?', { conversationId: convKn, language: 'Kannada' });
check('7. Kannada follow-up answers about FSSAI', /ಪರವಾನಗಿ|ತಪಾಸಣೆ|ಮಾನದಂಡ/.test(text(howKn)), text(howKn).slice(0, 160));
check('7b. Kannada follow-up is not about the app', !/(ಈ ಆ್ಯಪ್|ಚಾಟ್‌ಬಾಟ್)/.test(text(howKn)), text(howKn).slice(0, 160));

// ---------------------------------------------------------------- topic switch
console.log('\n--- topic switch: FSSAI -> complaint -> "how does it work?" ---');
const convSwitch = `topic-switch-${STAMP}`;
await chat('What is FSSAI?', { conversationId: convSwitch });
const complaintHow = await chat('How do I register a complaint?', { conversationId: convSwitch });
check('8. complaint question switches the topic', complaintHow.topic === 'complaint', JSON.stringify(complaintHow.topic));
check('8b. complaint answer is about filing, not about FSSAI', /Food Safety Connect|helpline|complaints@fssai/i.test(text(complaintHow)), text(complaintHow).slice(0, 160));

const afterSwitch = await chat('How does it work?', { conversationId: convSwitch });
check('9. follow-up now resolves to the NEW topic', afterSwitch.topic === 'complaint', JSON.stringify(afterSwitch.topic));
check('9b. and answers about filing a complaint', /Food Safety Connect|helpline|inspect|sample/i.test(text(afterSwitch)), text(afterSwitch).slice(0, 160));

// ---------------------------------------------------------------- explicit app question
console.log('\n--- explicit question about the app ---');
const appAsk = await chat('How does this app work?', { conversationId: `topic-app-${STAMP}` });
check('10. asking about the app explicitly is answered as such', appAsk.topic === 'app', JSON.stringify(appAsk.topic));
check('10b. and it describes the helpline', /Food Safety Assistant|voice and text|complaint/i.test(text(appAsk)), text(appAsk).slice(0, 160));

// ---------------------------------------------------------------- browser-only memory
console.log('\n--- browser carries the topic when the server has no turns ---');
const browserOnly = await chat('How does it work?', {
  conversationId: `topic-fresh-${STAMP}`,
  clientTopics: ['fssai'],
});
check('11. browser topic list resolves the follow-up', browserOnly.topic === 'fssai' && /licen|inspect|test/i.test(text(browserOnly)), text(browserOnly).slice(0, 160));
check('11b. it does not describe the app', !TALKS_ABOUT_ITSELF.test(text(browserOnly)), text(browserOnly).slice(0, 160));

// ---------------------------------------------------------------- no false positive
console.log('\n--- no topic at all: must not invent one ---');
const noTopic = await chat('How does it work?', { conversationId: `topic-none-${STAMP}` });
check('12. with no topic it does not claim to be describing FSSAI', !/Food Safety and Standards Authority/i.test(text(noTopic)), text(noTopic).slice(0, 160));

console.log(`\n=== topic memory: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
