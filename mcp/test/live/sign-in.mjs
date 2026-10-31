#!/usr/bin/env node
// Live sign-in gate: the real thebes-mcp server, the real Memphis, the live
// connect page, and the live hosting contract read without writing.
//
//   L1 sign_in returns a connect link, a code and a QR
//   L2 the phone (phone.py: a new identity, a virtual passkey) approves
//   L3 sign_in_status completes the sign-in; the session file is mode 600
//   L4 the stored token resolves on Memphis for https://thebesprotocol.com and
//      is refused for any other origin
//   L5 list_sites reads the live hosting contract with it (a new identity: no
//      sites, no orders); start_trial on a site that is not theirs is refused
//      before anything is written
//   L6 an access token at its end is exchanged: list_sites still works and the
//      stored refresh token has changed
//   L7 sign_out revokes on the chain: every token this run held is refused
//   L8 no token from the session file appears in any tool output
//
//   node test/live/sign-in.mjs [--out <dir>]      (needs python3 + Playwright)
//
// It writes nothing to the hosting contract. Memphis gains one identity named
// mcp-live-<n>.thebes, as every run of memphis-connect's own test does.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { whoamiScoped } from '../../src/memphis.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thebes-mcp-live-'));
const file = path.join(home, '.thebes', 'memphis-session.json');
const outputs = [], tokens = new Set(), rows = [];
const row = (name, pass, detail = '') => { rows.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const snapshot = () => { const s = JSON.parse(fs.readFileSync(file, 'utf8')); tokens.add(s.access_token_hex); tokens.add(s.refresh_token_hex); return s; };

const env = { ...process.env, HOME: home };
for (const k of ['THEBES_BOUNDARY', 'THEBES_HOSTING_CID', 'THEBES_PAYMENTS', 'THEBES_API_KEY']) delete env[k];
const c = new Client({ name: 'live', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, '..', '..', 'src', 'server.mjs')], env, stderr: 'pipe' }));
async function tool(name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  for (const x of r.content) outputs.push(x.type === 'text' ? x.text : x.data);
  return { r, b: JSON.parse(r.content[0].text) };
}

try {
  const { r, b: s } = await tool('sign_in');
  row('L1 sign_in: connect link, code, QR', /^https:\/\/memphis\.mercaturaforum\.com\/connect\/#link=[0-9a-f]{64}$/.test(s.approve_url) && /^[A-Z0-9]{6}$/.test(s.code) && r.content.some((x) => x.type === 'image'), `${s.approve_url?.slice(0, 60)}… code ${s.code}`);

  let phone;
  try {
    phone = JSON.parse(execFileSync('python3', [path.join(HERE, 'phone.py'), s.approve_url, s.code], { encoding: 'utf8', timeout: 300000 }).trim().split('\n').pop());
  } catch (e) {
    phone = JSON.parse(String(e.stdout || '{}').trim().split('\n').pop() || '{}');
  }
  row('L2 the phone creates an identity and approves', phone.ok === true, phone.said?.slice(0, 120));

  let st = (await tool('sign_in_status', { wait_seconds: 50 })).b;
  for (let i = 0; i < 3 && st.waiting_for_phone; i++) st = (await tool('sign_in_status', { wait_seconds: 50 })).b;
  const mode = fs.existsSync(file) ? (fs.statSync(file).mode & 0o777).toString(8) : 'none';
  row('L3 sign_in_status completes; session file mode 600', st.signed_in === true && mode === '600', `name ${st.name}, mode ${mode}`);

  const s1 = snapshot();
  const here = await whoamiScoped(s1.access_token_hex);
  const there = await whoamiScoped(s1.access_token_hex, 'https://example.org');
  row('L4 the token resolves for thebesprotocol.com and is refused elsewhere', !here.err && here.anchor_id_hex === s1.anchor_id_hex && there.err !== undefined, `elsewhere: ${there.err}`);

  const p = await tool('list_sites');
  const t = await tool('start_trial', { site_id: 999999 });
  row('L5 list_sites reads the live hosting contract; start_trial refuses before writing',
    !p.r.isError && typeof p.b.principal === 'string' && p.b.sites.length === 0 && p.b.orders.length === 0
      && t.r.isError && ['TRIAL_CLOSED', 'CONTACT_MISSING', 'UNKNOWN_SITE'].includes(t.b.code),
    `principal ${p.b.principal?.slice(0, 11)}…, start_trial ${t.b.code}`);

  fs.writeFileSync(file, JSON.stringify({ ...s1, access_expires_at_ns: String(BigInt(Date.now()) * 1_000_000n) }, null, 2), { mode: 0o600 });
  const again = await tool('list_sites');
  const s2 = snapshot();
  row('L6 an access token at its end is exchanged and the call still works', !again.r.isError && s2.refresh_token_hex !== s1.refresh_token_hex && s2.access_token_hex !== s1.access_token_hex);

  const out = (await tool('sign_out')).b;
  const refused = [];
  for (const tok of [s1.access_token_hex, s2.access_token_hex]) refused.push((await whoamiScoped(tok)).err !== undefined);
  row('L7 sign_out revokes on the chain', out.revoked_on_chain === true && out.access_refused_after === true && refused.every(Boolean) && !fs.existsSync(file), JSON.stringify(out));

  const all = outputs.join('\n');
  row('L8 no token appears in any tool output', [...tokens].every((x) => !all.includes(x)), `${tokens.size} tokens checked against ${outputs.length} outputs`);
} finally {
  await c.close();
  fs.rmSync(home, { recursive: true, force: true });
}
const failed = rows.filter((x) => !x).length;
console.log(`live sign-in: ${rows.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
