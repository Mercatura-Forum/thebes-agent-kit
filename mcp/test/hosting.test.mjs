// The hosting tools, end to end over stdio, against fake-chain.mjs: sign-in
// from a phone, sites, contact details, payment links, payment status, session
// refresh across processes, sign-out, and the refusals. No test here reaches
// the chain or the payment service.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callSigningPayload, signCall } from '../src/chain.mjs';
import { fakeChain, verifySignature } from './fake-chain.mjs';

const SERVER = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'server.mjs');
const HOSTING = 154804123815280;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thebes-mcp-hosting-'));
const outputs = [];
let chain, base;

async function connect(home, extra = {}) {
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, THEBES_BOUNDARY: base, THEBES_PAYMENTS: base, THEBES_HOSTING_CID: String(HOSTING), THEBES_API_KEY: '', ...extra };
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'pipe' }));
  return client;
}

async function callTool(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content) outputs.push(c.type === 'text' ? c.text : c.data);
  return r;
}
const body = (r) => JSON.parse(r.content[0].text);
function refusal(r, code) {
  assert.equal(r.isError, true, `expected ${code}, got ${r.content[0].text}`);
  assert.equal(body(r).code, code, r.content[0].text);
  assert.ok(body(r).fix, 'a refusal carries a fix');
}

async function signIn(client) {
  const s = body(await callTool(client, 'sign_in'));
  chain.approve(s.approve_url.split('#link=')[1]);
  const done = body(await callTool(client, 'sign_in_status', { wait_seconds: 5 }));
  assert.equal(done.signed_in, true);
  return done;
}

before(async () => {
  chain = fakeChain({ hostingCid: HOSTING });
  base = await chain.listen();
});
after(async () => {
  await chain.close();
  // Nothing the fake minted (access and refresh tokens, link secrets, pay
  // tokens) appears in anything any tool returned.
  const all = outputs.join('\n');
  for (const s of chain.st.secrets) assert.ok(!all.includes(s), `a secret appeared in a tool's output: ${s.slice(0, 8)}…`);
  assert.equal(chain.st.badSignatures, 0, 'every call the server sent was correctly signed');
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the signing payload matches the SDK passkey.js byte for byte, and a signature verifies', () => {
  // passkey.js callSigningPayload(921, "claim_device_link", DIDL..., [7; 32], 0), run unchanged.
  const want = '65677970742d6c312d696e67726573732d763102000000000000039900000011636c61696d5f6465766963655f6c696e6b000000094449444c00017101610000002007070707070707070707070707070707070707070707070707070707070707070000000000000000';
  const arg = new Uint8Array([0x44, 0x49, 0x44, 0x4c, 0, 1, 0x71, 1, 0x61]);
  assert.equal(callSigningPayload(921, 'claim_device_link', arg, new Uint8Array(32).fill(7), 0).toString('hex'), want);
  const s = signCall(921, 'claim_device_link', arg);
  const msg = { canister_id: 921, method: 'claim_device_link', arg: Buffer.from(arg).toString('hex'), sender: s.senderHex, nonce: 0, signature: s.signatureHex };
  assert.equal(verifySignature(msg), true);
  // The fake's verifier is not a rubber stamp: one changed byte fails.
  assert.equal(verifySignature({ ...msg, arg: msg.arg.replace(/61$/, '62') }), false);
  // Every message has its own key.
  assert.notEqual(signCall(921, 'm', arg).senderHex, s.senderHex);
});

test('without a sign-in every hosting tool refuses with NOT_SIGNED_IN', async () => {
  const c = await connect(path.join(TMP, 'nobody'));
  try {
    refusal(await callTool(c, 'list_sites'), 'NOT_SIGNED_IN');
    refusal(await callTool(c, 'create_site', { name: 'x' }), 'NOT_SIGNED_IN');
    refusal(await callTool(c, 'create_payment_link', { site_id: 1 }), 'NOT_SIGNED_IN');
    refusal(await callTool(c, 'payment_status', { site_id: 1 }), 'NOT_SIGNED_IN');
    refusal(await callTool(c, 'connect_domain', { action: 'list' }), 'NOT_SIGNED_IN');
    assert.deepEqual(body(await callTool(c, 'sign_in_status')), { signed_in: false });
    assert.equal(body(await callTool(c, 'sign_out')).revoked_on_chain, false);
  } finally {
    await c.close();
  }
});

test('sign in from a phone: link, code and QR; waits; claims; stores the session 0600', async () => {
  const home = path.join(TMP, 'person');
  const c = await connect(home);
  try {
    const r = await callTool(c, 'sign_in');
    const s = body(r);
    assert.match(s.approve_url, /^https:\/\/memphis\.mercaturaforum\.com\/connect\/#link=[0-9a-f]{64}$/);
    assert.match(s.code, /^[ACDEFGHJKMNPQRTUVWXY34679]{6}$/);
    assert.ok(r.content.some((x) => x.type === 'image' && x.mimeType === 'image/png'), 'a QR image');
    assert.ok(r.content[1].text.includes('█'), 'a QR in text');
    // Before the phone approves: still waiting, nothing stored.
    const waiting = body(await callTool(c, 'sign_in_status', { wait_seconds: 1 }));
    assert.equal(waiting.waiting_for_phone, true);
    assert.ok(!fs.existsSync(path.join(home, '.thebes', 'memphis-session.json')));
    chain.approve(s.approve_url.split('#link=')[1]);
    const done = body(await callTool(c, 'sign_in_status', { wait_seconds: 5 }));
    assert.equal(done.signed_in, true);
    assert.equal(done.origin, 'https://thebesprotocol.com');
    assert.equal(done.name, 'tester');
    const file = path.join(home, '.thebes', 'memphis-session.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, '.thebes')).mode & 0o777, 0o700);
    // Signed in already: sign_in says so and opens no new request.
    const before = chain.st.links.size;
    assert.equal(body(await callTool(c, 'sign_in')).signed_in, true);
    assert.equal(chain.st.links.size, before);
  } finally {
    await c.close();
  }
});

test('a request nobody approves ends with LINK_EXPIRED', async () => {
  const c = await connect(path.join(TMP, 'slow'));
  try {
    // A link that vanishes before its end is a node that has not seen it yet: keep waiting.
    const s = body(await callTool(c, 'sign_in'));
    chain.expireLink(s.approve_url.split('#link=')[1]);
    assert.equal(body(await callTool(c, 'sign_in_status', { wait_seconds: 0 })).waiting_for_phone, true);
    // Past its end and unknown: ended.
    chain.st.linkLifeNs = 0n;
    body(await callTool(c, 'sign_in', { fresh: true }));
    chain.st.linkLifeNs = 120n * 1_000_000_000n;
    refusal(await callTool(c, 'sign_in_status', { wait_seconds: 0 }), 'LINK_EXPIRED');
    assert.deepEqual(body(await callTool(c, 'sign_in_status')), { signed_in: false });
  } finally {
    await c.close();
  }
});

test('site, contact details, payment link and payment status', async () => {
  const c = await connect(path.join(TMP, 'buyer'));
  try {
    await signIn(c);
    const created = body(await callTool(c, 'create_site', { name: 'Clinic bookings' }));
    assert.equal(created.site_id, 1);
    assert.equal(created.price.amount, '1.00 EGP');
    refusal(await callTool(c, 'create_payment_link', { site_id: 1 }), 'CONTACT_MISSING');
    const saved = body(await callTool(c, 'set_contact_details', { email: 'a@example.com' }));
    assert.equal(saved.email, 'a@example.com');
    refusal(await callTool(c, 'create_payment_link', { site_id: 1 }), 'CONTACT_MISSING');
    // A partial save keeps what was saved before.
    assert.equal(body(await callTool(c, 'set_contact_details', { phone: '+201000000000' })).email, 'a@example.com');
    const link = body(await callTool(c, 'create_payment_link', { site_id: 1 }));
    assert.match(link.checkout_url, /^https:\/\/accept\.paymob\.com\/unifiedcheckout\//);
    assert.equal(link.amount, '1.00 EGP');
    assert.equal(link.order_id, 1);
    // A second link reuses the order with a new token; the first token stops working.
    const firstHash = chain.st.orders[0].payTokenHash;
    body(await callTool(c, 'create_payment_link', { site_id: 1 }));
    assert.equal(chain.st.orders.length, 1);
    assert.notEqual(chain.st.orders[0].payTokenHash, firstHash);
    refusal(await callTool(c, 'create_payment_link', { site_id: 9 }), 'HOSTING_REFUSED');

    assert.equal(body(await callTool(c, 'payment_status', { site_id: 1 })).paid, false);
    const until = (BigInt(Date.now()) + 365n * 86400000n) * 1_000_000n;
    chain.markPaid(1, until);
    const st = body(await callTool(c, 'payment_status', { site_id: 1 }));
    assert.equal(st.paid, true);
    assert.equal(st.paid_until, new Date(Number(until / 1_000_000n)).toISOString());
    assert.equal(st.orders[0].transaction_id, '560939821');
    refusal(await callTool(c, 'create_payment_link', { site_id: 1 }), 'ALREADY_PAID');
    const renewal = body(await callTool(c, 'create_payment_link', { site_id: 1, renew: true }));
    assert.equal(renewal.order_id, 2, 'a renewal is a new order');
    refusal(await callTool(c, 'payment_status', { site_id: 7 }), 'UNKNOWN_SITE');

    const panel = body(await callTool(c, 'list_sites'));
    assert.equal(panel.sites[0].name, 'Clinic bookings');
    assert.equal(panel.contact.phone, '+201000000000');
    assert.equal(panel.orders[0].status, 'paid');
    assert.deepEqual(body(await callTool(c, 'connect_domain', { action: 'list' })), { domains: [] });
    refusal(await callTool(c, 'connect_domain', { action: 'attach', domain: 'x.example.com' }), 'MISSING_ARGUMENT');
  } finally {
    await c.close();
  }
});

test('start_trial: closed is said plainly; contact first; once per person; then the site is deployable', async () => {
  const c = await connect(path.join(TMP, 'trialist'));
  try {
    await signIn(c);
    const before = chain.st.sites.length;
    const site = body(await callTool(c, 'create_site', { name: 'Trial site' })).site_id;
    assert.equal(site, before + 1);
    chain.st.trialsOpen = false;
    refusal(await callTool(c, 'start_trial', { site_id: site }), 'TRIAL_CLOSED');
    assert.equal(chain.st.trials.length, 0);
    chain.st.trialsOpen = true;
    const saved = chain.st.profile;
    chain.st.profile = null;
    refusal(await callTool(c, 'start_trial', { site_id: site }), 'CONTACT_MISSING');
    chain.st.profile = saved ?? { email: 't@example.com', phone: '+201000000001', organisation: '', billingEmail: '', taxId: '' };
    refusal(await callTool(c, 'start_trial', { site_id: 999 }), 'UNKNOWN_SITE');
    const t = body(await callTool(c, 'start_trial', { site_id: site }));
    assert.equal(t.site_id, site);
    const days = (Date.parse(t.free_until) - Date.parse(t.started_at)) / 86400000;
    assert.equal(days, 90);
    assert.equal(body(await callTool(c, 'payment_status', { site_id: site })).paid, true);
    const again = await callTool(c, 'start_trial', { site_id: site });
    refusal(again, 'TRIAL_USED');
    assert.match(body(again).message, /Trial site/);
  } finally {
    chain.st.trialsOpen = false;
    await c.close();
  }
});

test('two processes sharing a sign-in exchange its refresh token once, never twice', async () => {
  const home = path.join(TMP, 'twins');
  const a = await connect(home);
  const b = await connect(home);
  try {
    // Claimed with a token inside the two-minute margin: the next call exchanges it.
    chain.st.accessLifeNs = 60n * 1_000_000_000n;
    await signIn(a);
    chain.st.accessLifeNs = 1800n * 1_000_000_000n;
    let before = chain.st.exchanges;
    let [ra, rb] = await Promise.all([callTool(a, 'list_sites'), callTool(b, 'list_sites')]);
    assert.ok(!ra.isError && !rb.isError, `${ra.content[0].text} / ${rb.content[0].text}`);
    assert.equal(chain.st.exchanges - before, 1, 'near its end: one exchange, under the lock');
    // The chain refuses a token that still looks fresh here: one exchange too.
    chain.expireAccessTokens();
    before = chain.st.exchanges;
    [ra, rb] = await Promise.all([callTool(a, 'list_sites'), callTool(b, 'list_sites')]);
    assert.ok(!ra.isError && !rb.isError, `${ra.content[0].text} / ${rb.content[0].text}`);
    assert.equal(chain.st.exchanges - before, 1, 'refused: one exchange, the other process uses its result');
    assert.equal(chain.st.reuseRevocations, 0, 'no refresh token presented twice');
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('a token the contract refuses is exchanged and the call made again', async () => {
  const c = await connect(path.join(TMP, 'revoked-access'));
  try {
    await signIn(c);
    const before = chain.st.exchanges;
    // The stored token still looks fresh locally; the chain no longer accepts it.
    chain.expireAccessTokens();
    const r = await callTool(c, 'list_sites');
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(chain.st.exchanges - before, 1);
  } finally {
    await c.close();
  }
});

test('sign out revokes every token of the sign-in on the chain and deletes the file', async () => {
  const home = path.join(TMP, 'leaver');
  const c = await connect(home);
  try {
    await signIn(c);
    const stored = JSON.parse(fs.readFileSync(path.join(home, '.thebes', 'memphis-session.json'), 'utf8'));
    const out = body(await callTool(c, 'sign_out'));
    assert.deepEqual(out, { signed_out: true, revoked_on_chain: true, access_refused_after: true });
    assert.ok(!fs.existsSync(path.join(home, '.thebes', 'memphis-session.json')));
    assert.ok(!chain.st.access.has(stored.access_token_hex), 'the stored access token is revoked');
    assert.ok(!chain.st.refresh.has(stored.refresh_token_hex), 'the stored refresh token is revoked');
    refusal(await callTool(c, 'list_sites'), 'NOT_SIGNED_IN');
  } finally {
    await c.close();
  }
});

test('a session file other users can read is refused, not used', async () => {
  const home = path.join(TMP, 'open-file');
  const c = await connect(home);
  try {
    await signIn(c);
    fs.chmodSync(path.join(home, '.thebes', 'memphis-session.json'), 0o644);
    refusal(await callTool(c, 'list_sites'), 'SESSION_FILE_OPEN');
  } finally {
    await c.close();
  }
});

test('a hosting build from before self-deploy (no backends in its panel) still lists sites', async () => {
  const old = fakeChain({ hostingCid: HOSTING, oldPanel: true });
  const oldBase = await old.listen();
  const c = await connect(path.join(TMP, 'old-build'), { THEBES_BOUNDARY: oldBase, THEBES_PAYMENTS: oldBase });
  try {
    const s = body(await callTool(c, 'sign_in'));
    old.approve(s.approve_url.split('#link=')[1]);
    assert.equal(body(await callTool(c, 'sign_in_status', { wait_seconds: 5 })).signed_in, true);
    body(await callTool(c, 'create_site', { name: 'Old build site' }));
    const panel = body(await callTool(c, 'list_sites'));
    assert.equal(panel.sites[0].backend_cid, null);
    refusal(await callTool(c, 'start_trial', { site_id: 1 }), 'TRIAL_UNAVAILABLE');
    for (const s2 of old.st.secrets) assert.ok(!outputs.join('\n').includes(s2));
  } finally {
    await c.close();
    await old.close();
  }
});

test('redeploy_site asks the contract first and stops before deploying an unpaid site', async () => {
  const home = path.join(TMP, 'deployer');
  const cliDir = path.join(TMP, 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  const log = path.join(cliDir, 'argv.log');
  const fake = path.join(cliDir, 'thebes-deploy');
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "thebes-deploy 0.1.14"; exit 0; fi\nprintf '%s\\n' "$*" >> ${log}\necho '{"ok":true}'\n`, { mode: 0o755 });
  const project = path.join(TMP, 'site-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'thebes.toml'), '[project]\nname = "p"\n');
  const c = await connect(home, { THEBES_DEPLOY: fake, THEBES_API_KEY: 'tbk_' + crypto.randomBytes(8).toString('hex') });
  try {
    await signIn(c);
    body(await callTool(c, 'create_site', { name: 'To deploy' }));
    const sites = body(await callTool(c, 'list_sites')).sites;
    const id = sites[sites.length - 1].id;
    refusal(await callTool(c, 'redeploy_site', { dir: project, site_id: id }), 'SITE_NOT_DEPLOYABLE');
    assert.ok(!fs.existsSync(log), 'nothing was deployed');
    chain.markPaid(id, (BigInt(Date.now()) + 86400000n) * 1_000_000n);
    const r = body(await callTool(c, 'redeploy_site', { dir: project, site_id: id }));
    assert.equal(r.site.site_id, id);
    assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`^deploy --no-facts --json --site ${id}$`, 'm'));
  } finally {
    await c.close();
  }
});
