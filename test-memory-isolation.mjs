// Verify that conversation memory can NEVER leak between phone numbers, and that
// it DOES follow the same caller to a new device. Uses the deterministic recall
// path, so no LLM key is required.
const base = 'http://127.0.0.1:3000';

// Unique phone numbers per run, so earlier runs cannot contaminate the results.
const STAMP = Date.now().toString().slice(-8);
const PHONE_A = `98${STAMP}`;
const PHONE_B = `90${STAMP}`;
const CONV_A = 'iso-A-' + STAMP;

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

async function chat(message, phone, conversationId) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      message,
      language: 'English',
      conversationId: conversationId || undefined,
      profile: { name: 'Test', phone },
    }),
  });
  return res.json();
}

const saysNothingYet = (r) => /haven't told me anything yet/i.test(String(r.response || ''));

// wait for the server
let up = false;
for (let i = 0; i < 60; i++) {
  try { await fetch(`${base}/api/complaints`); up = true; break; }
  catch { await new Promise((r) => setTimeout(r, 800)); }
}
if (!up) { console.log('SERVER NOT UP'); process.exit(1); }

// 1. Caller A describes the incident.
const seed = await chat('I found a worm in the idli', PHONE_A, CONV_A);
check('A can store a turn', !!seed.conversationId, JSON.stringify(seed).slice(0, 160));

// 2. PRIVACY: caller B presents A's conversation id and asks what they said.
const bPeek = await chat('what did I say?', PHONE_B, CONV_A);
check(
  'B with A\'s conversationId sees NOTHING',
  bPeek.recalled === true && saysNothingYet(bPeek),
  JSON.stringify(bPeek.response)
);

// 3. PRIVACY: B's reply must not contain any of A's content.
check('B\'s reply contains no A content', !String(bPeek.response || '').includes('idli'));

// 4. The owner CAN read their own thread.
const aRead = await chat('what did I say?', PHONE_A, CONV_A);
check(
  'A with their own id CAN read it',
  aRead.recalled === true && String(aRead.response).includes('idli'),
  JSON.stringify(aRead.response).slice(0, 200)
);

// 5. Cross-device: A returns with NO conversationId (new phone/browser) and must
//    continue their OWN latest thread.
const aNewDevice = await chat('what did I say?', PHONE_A, '');
check(
  'A on a new device resumes their own memory',
  aNewDevice.recalled === true && String(aNewDevice.response).includes('idli'),
  JSON.stringify(aNewDevice.response).slice(0, 200)
);

// 6. A stranger with no id must still start empty (nothing to adopt).
const bFresh = await chat('what did I say?', PHONE_B, '');
check(
  'B with no id has no history to adopt',
  bFresh.recalled === true && saysNothingYet(bFresh),
  JSON.stringify(bFresh.response)
);

// 7. "New conversation" closes the old thread, and a BRAND-NEW id sent afterwards
//    must start empty rather than resurrecting an older thread.
await fetch(`${base}/api/chat/new`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ conversationId: CONV_A, profile: { phone: PHONE_A } }),
});
const afterClose = await chat('what did I say?', PHONE_A, 'fresh-' + STAMP);
check(
  'a fresh id after closing starts empty',
  afterClose.recalled === true && saysNothingYet(afterClose),
  JSON.stringify(afterClose.response)
);

// 7b. With no id at all, the caller may adopt their latest OPEN thread only - the
//     closed one must never come back.
const noIdAfterClose = await chat('what did I say?', PHONE_A, '');
const closedResurrected = String(noIdAfterClose.response || '').includes('worm in the idli');
check(
  'the closed thread is never resurrected',
  noIdAfterClose.recalled === true && !closedResurrected,
  JSON.stringify(noIdAfterClose.response).slice(0, 140)
);

// 8. A stranger cannot close someone else's thread.
const CONV_C = 'iso-C-' + Date.now();
await chat('I found a worm in the idli', PHONE_A, CONV_C);
await fetch(`${base}/api/chat/new`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ conversationId: CONV_C, profile: { phone: PHONE_B } }),
});
const cStillThere = await chat('what did I say?', PHONE_A, CONV_C);
check(
  'B cannot close or break A\'s thread',
  cStillThere.recalled === true && String(cStillThere.response).includes('idli'),
  JSON.stringify(cStillThere.response).slice(0, 200)
);

console.log(`\n=== isolation: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
