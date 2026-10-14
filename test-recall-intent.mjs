// Verify recall triggers on natural phrasings, never claims empty memory, and
// still answers ordinary domain questions normally.
const base = 'http://127.0.0.1:3000';
const STAMP = Date.now().toString().slice(-8);
const PHONE = `97${STAMP}`;

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

async function chat(message, conversationId, language = 'English') {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ message, language, conversationId: conversationId || undefined, profile: { name: 'Test', phone: PHONE } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 429 means the suite ran too fast for the endpoint's own rate limit - report
    // it clearly instead of crashing on a missing field.
    throw new Error(`HTTP ${res.status}${body?.error ? ': ' + body.error : ''}`);
  }
  return body;
}

const SAID = 'I found a worm in the idli at Annapurna hotel';

// wait for the server
let up = false;
for (let i = 0; i < 60; i++) {
  try { await fetch(`${base}/api/health`); up = true; break; }
  catch { await new Promise((r) => setTimeout(r, 800)); }
}
if (!up) { console.log('SERVER NOT UP'); process.exit(1); }

// Empty conversation first: a bare "do you remember?" must NOT claim memory.
const fresh = await chat('do you remember?', 'recall-empty-' + STAMP);
check(
  '"do you remember?" on an EMPTY conversation refuses, does not claim',
  fresh.recalled === true
    && /haven't told me anything/i.test(String(fresh.response))
    && !/you said|you told me that|idli/i.test(String(fresh.response)),
  `${fresh.recalled} :: ${JSON.stringify(fresh.response).slice(0, 120)}`
);

// Now store something, then ask in several natural ways.
const seed = await chat(SAID, 'recall-' + STAMP);
const cid = seed.conversationId;

const phrasings = [
  'do you remember?',
  'do you remember me?',
  'do you remember what I said?',
  'did you remember?',
  'what did I say?',
  'tell me what I said',
  'what do you remember about me?',
  'can you recall?',
];
// Each phrasing gets its own thread seeded with the real complaint, so the
// question itself cannot push the content out of the recall window.
for (const [i, p] of phrasings.entries()) {
  const thread = `recall-x${i}-${STAMP}`;
  await chat(SAID, thread);
  const r = await chat(p, thread);
  check(
    `"${p}" recalls the real words`,
    r.recalled === true && String(r.response).includes('idli'),
    `recalled=${r.recalled} response=${JSON.stringify(String(r.response)).slice(0, 190)}`
  );
}

// Asking repeatedly must keep returning the CONTENT, never a list of the
// caller's own questions (the reported "it remembers but says nothing" bug).
const loopThread = `recall-loop-${STAMP}`;
await chat(SAID, loopThread);
await chat('do you remember?', loopThread);
await chat('what did I say?', loopThread);
await chat('do you remember?', loopThread);
const afterLoop = await chat('what did I say?', loopThread);
check(
  'repeated asks still return the content, not the questions',
  String(afterLoop.response).includes('idli') && !/• do you remember\?/i.test(String(afterLoop.response)),
  JSON.stringify(String(afterLoop.response)).slice(0, 220)
);

// Kannada + Hindi recall on a stored thread.
await chat(SAID, 'recall-kn-' + STAMP);
const rKn = await chat('ನೆನಪಿದೆಯಾ?', 'recall-kn-' + STAMP, 'Kannada');
check('Kannada "ನೆನಪಿದೆಯಾ?" recalls', rKn.recalled === true && String(rKn.response).includes('idli'), `recalled=${rKn.recalled} response=${JSON.stringify(String(rKn.response)).slice(0, 190)}`);

await chat(SAID, 'recall-hi-' + STAMP);
const rHi = await chat('क्या आपको याद है?', 'recall-hi-' + STAMP, 'Hindi');
check('Hindi "क्या आपको याद है?" recalls', rHi.recalled === true && String(rHi.response).includes('idli'), `recalled=${rHi.recalled} response=${JSON.stringify(String(rHi.response)).slice(0, 190)}`);

// A remember-question about the DOMAIN must stay a normal question, not a lookup.
const domainQ = await chat('do you remember what FSSAI is?', cid);
check(
  '"do you remember what FSSAI is?" is NOT treated as a memory lookup',
  domainQ.recalled !== true,
  `recalled=${domainQ.recalled}`
);

// Diagnostics endpoint must answer the "database issue?" question.
const health = await (await fetch(`${base}/api/health`)).json();
check('GET /api/health reports database status', typeof health.database === 'string', JSON.stringify(health).slice(0, 200));
console.log(`      health: database=${health.database} durable=${health.memoryIsDurable} inMemory=${health.conversationsInMemory} inDb=${health.conversationsInDb}`);
console.log(`      note: ${health.note}`);

console.log(`\n=== recall: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
