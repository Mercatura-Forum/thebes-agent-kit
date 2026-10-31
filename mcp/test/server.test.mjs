// Drives the server over stdio exactly as an MCP client does. Needs network access
// (live read-only queries, git fetch) and thebes-deploy >= 0.1.13 (THEBES_DEPLOY),
// and moc on PATH for the build check. No test spends credits or deploys.

import { test, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = new URL('../src/server.mjs', import.meta.url).pathname;
const INDEX = JSON.parse(fs.readFileSync(new URL('../../index.json', import.meta.url), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thebes-mcp-test-'));
const HOME_NO_KEY = path.join(TMP, 'home-no-key');
const HOME_KEY = path.join(TMP, 'home-key');
fs.mkdirSync(HOME_NO_KEY, { recursive: true });
fs.mkdirSync(path.join(HOME_KEY, '.thebes'), { recursive: true });
fs.writeFileSync(path.join(HOME_KEY, '.thebes', 'credentials.toml'), 'api_key = "tbk_test_not_a_real_key"\n');

async function connect(env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

const body = (r) => JSON.parse(r.content[0].text);
const refusal = (r, code) => { assert.equal(r.isError, true, JSON.stringify(r)); assert.equal(body(r).code, code); assert.ok(body(r).fix); };

// The tests that run thebes-deploy (or build Motoko) need the right tools. With
// the wrong ones each fails with this one line, never with an assertion about
// a field the old CLI does not print, and never by being skipped.
const { MIN_CLI, cliPath } = await import('../src/cli.mjs');
function toolProblem(needsMoc) {
  let out;
  try {
    out = execFileSync(cliPath(), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return `thebes-deploy not found at "${cliPath()}": set THEBES_DEPLOY to a thebes-deploy ${MIN_CLI.join('.')} or later`;
  }
  const v = (out.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const older = v.length !== 3 || v.reduce((cmp, x, i) => cmp || Math.sign(x - MIN_CLI[i]), 0) < 0;
  if (older) return `CLI ${v.join('.') || out.trim()} at "${cliPath()}" is older than ${MIN_CLI.join('.')}: set THEBES_DEPLOY to a thebes-deploy ${MIN_CLI.join('.')} or later`;
  if (needsMoc) {
    let moc = '';
    try { moc = execFileSync('moc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch {}
    if (!moc.includes('Motoko compiler')) return 'moc on PATH is not the Motoko compiler: put the directory of Motoko moc 1.4.1 first on PATH';
  }
  return null;
}
const CLI_PROBLEM = toolProblem(false);
const BUILD_PROBLEM = toolProblem(true);
if (CLI_PROBLEM || BUILD_PROBLEM) console.error(`# live tests will fail: ${CLI_PROBLEM ?? BUILD_PROBLEM}`);
function live(name, { build = false, ...opts }, fn) {
  test(name, opts, async (t) => {
    const problem = build ? BUILD_PROBLEM : CLI_PROBLEM;
    if (problem) assert.fail(problem);
    await fn(t);
  });
}

let c, cNoKey, cKey;
before(async () => {
  c = await connect();
  cNoKey = await connect({ HOME: HOME_NO_KEY, THEBES_API_KEY: '' });
  cKey = await connect({ HOME: HOME_KEY });
});
after(async () => {
  await Promise.all([c, cNoKey, cKey].map((x) => x?.close()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('every tool is listed with annotations and an input schema', async () => {
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['call', 'check_project', 'connect_domain', 'create_payment_link', 'create_site', 'credits', 'deploy', 'find_examples', 'get_example', 'get_interface', 'get_lib_module', 'list_capabilities', 'list_sites', 'payment_status', 'query', 'read_receipt', 'redeploy_site', 'scaffold_project', 'set_contact_details', 'sign_in', 'sign_in_status', 'sign_out', 'start_from_example', 'start_trial', 'upgrade']);
  for (const t of tools) { assert.ok(t.annotations, t.name); assert.ok(t.description.length > 40, t.name); }
  const ro = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(ro, ['credits', 'find_examples', 'get_example', 'get_interface', 'get_lib_module', 'list_capabilities', 'list_sites', 'payment_status', 'query', 'read_receipt']);
});

test('the guide and the index are readable as resources', async () => {
  const g = await c.readResource({ uri: 'thebes://guide' });
  assert.match(g.contents[0].text, /^# AGENTS\.md/);
  const i = await c.readResource({ uri: 'thebes://index' });
  assert.equal(JSON.parse(i.contents[0].text).examples.length, INDEX.examples.length);
});

test('find_examples lists everything, filters by words and by capability', async () => {
  const all = body(await c.callTool({ name: 'find_examples', arguments: {} }));
  assert.equal(all.examples.length, INDEX.examples.length);
  assert.equal(all.starters.length, INDEX.starters.length);
  const rnd = body(await c.callTool({ name: 'find_examples', arguments: { capability: 'randomness' } }));
  assert.deepEqual(rnd.examples.map((e) => e.id), ['cards']);
  const words = body(await c.callTool({ name: 'find_examples', arguments: { query: 'reservation' } }));
  assert.ok(words.examples.some((e) => e.id === 'booking'));
  refusal(await c.callTool({ name: 'find_examples', arguments: { capability: 'teleport' } }), 'UNKNOWN_CAPABILITY');
});

test('get_example and get_interface answer from the index', async () => {
  const b = body(await c.callTool({ name: 'get_example', arguments: { id: 'booking' } }));
  const want = INDEX.examples.find((e) => e.id === 'booking');
  assert.deepEqual(b, want);
  refusal(await c.callTool({ name: 'get_example', arguments: { id: 'nope' } }), 'UNKNOWN_EXAMPLE');
  const did = (await c.callTool({ name: 'get_interface', arguments: { example: 'crm' } })).content[0].text;
  assert.equal(did, fs.readFileSync(new URL('../../interfaces/crm/crm.did', import.meta.url), 'utf8'));
  refusal(await c.callTool({ name: 'get_interface', arguments: { example: 'crm', contract: 'web' } }), 'NO_INTERFACE');
});

test('get_lib_module lists modules and returns one', async () => {
  const list = body(await c.callTool({ name: 'get_lib_module', arguments: {} }));
  assert.deepEqual(list.modules.map((m) => m.name), INDEX.lib.modules.map((m) => m.name));
  const m = body(await c.callTool({ name: 'get_lib_module', arguments: { name: 'memphisauth' } }));
  assert.equal(m.import, 'mo:thebes-lib/MemphisAuth');
  assert.ok(m.functions.some((f) => f.name === 'verifyWithAudience'));
  refusal(await c.callTool({ name: 'get_lib_module', arguments: { name: 'Nope' } }), 'UNKNOWN_MODULE');
});

live('query reads a live example contract by cid', {}, async () => {
  const crm = INDEX.examples.find((e) => e.id === 'crm').contracts.find((x) => x.name === 'crm');
  const r = body(await c.callTool({ name: 'query', arguments: { cid: crm.cid, method: 'getOwner' } }));
  assert.match(r.reply, /^\(opt principal "[a-z0-9-]+"\)$/);
  refusal(await c.callTool({ name: 'query', arguments: { cid: crm.cid, method: 'noSuchMethod' } }), 'QUERY_FAILED');
  refusal(await c.callTool({ name: 'query', arguments: { method: 'getOwner' } }), 'NO_TARGET');
});

live('scaffold_project then check_project: a clean project builds', { timeout: 900000, build: true }, async () => {
  const s = body(await c.callTool({ name: 'scaffold_project', arguments: { name: 'demo', parent_dir: TMP, backend: 'motoko', frontend: 'none' } }));
  assert.deepEqual(s.findings, []);
  assert.ok(fs.existsSync(path.join(s.dir, 'thebes.toml')));
  refusal(await c.callTool({ name: 'scaffold_project', arguments: { name: 'demo', parent_dir: TMP, frontend: 'none' } }), 'EXISTS');
  const chk = body(await c.callTool({ name: 'check_project', arguments: { dir: s.dir } }));
  assert.equal(chk.ok, true, JSON.stringify(chk));
  assert.ok(chk.build.built.length >= 1 && chk.build.built[0].bytes > 0);
  assert.match(chk.toolchain.moc, /Motoko compiler/);
});

live('start_from_example gives every contract a fresh id and a clean manifest', { timeout: 300000 }, async () => {
  const ex = INDEX.examples.find((e) => e.id === 'crm');
  const r = body(await c.callTool({ name: 'start_from_example', arguments: { example: 'crm', parent_dir: TMP, name: 'mycrm' } }));
  assert.deepEqual(r.findings, []);
  assert.equal(r.contracts.length, ex.contracts.length);
  for (const x of r.contracts) {
    assert.notEqual(x.cid, x.example_cid);
    assert.equal(x.example_cid, ex.contracts.find((y) => y.name === x.contract).cid);
  }
  const backend = ex.contracts.find((y) => y.type === 'backend-motoko').cid;
  const config = fs.readFileSync(path.join(r.dir, 'frontend/src/lib/config.ts'), 'utf8');
  assert.ok(!config.includes(String(backend)), 'frontend still points at the example backend');
  const manifest = fs.readFileSync(path.join(r.dir, 'thebes.toml'), 'utf8');
  assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(manifest));
  assert.match(manifest, /--legacy-persistence/);
});

live('deploy and upgrade refuse before anything is sent', { timeout: 300000 }, async () => {
  const dir = path.join(TMP, 'bad');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'thebes.toml'), '[project]\nname = "bad"\ndefault_network = "n"\nchain_id = 2026\n\n[networks.n]\nvalidators = ["http://10.0.0.1:18080"]\n\n[canisters.b]\ntype = "backend-motoko"\ncid = "auto"\nbuild = "moc $(mops sources) -o b.wasm main.mo"\nwasm = "b.wasm"\n');
  const r = await cKey.callTool({ name: 'deploy', arguments: { dir, mode: 'metered', confirm_spend: true } });
  refusal(r, 'CHECK_FAILED');
  assert.match(body(r).message, /legacy-persistence/);
  assert.match(body(r).message, /no-node-addresses/);
  refusal(await cKey.callTool({ name: 'upgrade', arguments: { dir, contract: 'b' } }), 'CHECK_FAILED');
  refusal(await cKey.callTool({ name: 'upgrade', arguments: { dir, contract: 'zz' } }), 'UNKNOWN_CONTRACT');

  const good = body(await c.callTool({ name: 'scaffold_project', arguments: { name: 'good', parent_dir: TMP, frontend: 'none' } })).dir;
  refusal(await cNoKey.callTool({ name: 'deploy', arguments: { dir: good, mode: 'metered', confirm_spend: true } }), 'NO_API_KEY');
  refusal(await cKey.callTool({ name: 'deploy', arguments: { dir: good, mode: 'metered', confirm_spend: false } }), 'CONFIRM_SPEND');
  refusal(await cNoKey.callTool({ name: 'redeploy_site', arguments: { dir: good, site_id: 7 } }), 'NO_API_KEY');
  refusal(await cKey.callTool({ name: 'redeploy_site', arguments: { dir, site_id: 7 } }), 'CHECK_FAILED');
  refusal(await cNoKey.callTool({ name: 'credits', arguments: {} }), 'NO_API_KEY');
  refusal(await c.callTool({ name: 'deploy', arguments: { dir: path.join(TMP, 'nowhere'), mode: 'own-key', confirm_spend: false } }), 'NO_MANIFEST');
});

test('an old or missing CLI is refused with the install line', async () => {
  const fake = path.join(TMP, 'old-cli');
  fs.writeFileSync(fake, '#!/bin/sh\necho "thebes-deploy 0.1.10"\n', { mode: 0o755 });
  const dir = path.join(TMP, 'old-cli-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'thebes.toml'), '[project]\nname = "p"\n');
  const cOld = await connect({ THEBES_DEPLOY: fake });
  try {
    refusal(await cOld.callTool({ name: 'check_project', arguments: { dir } }), 'CLI_TOO_OLD');
  } finally {
    await cOld.close();
  }
  const cNone = await connect({ THEBES_DEPLOY: path.join(TMP, 'no-such-cli') });
  try {
    refusal(await cNone.callTool({ name: 'credits', arguments: {} }), 'CLI_MISSING');
  } finally {
    await cNone.close();
  }
});

test('the CLI is never given a key or a seed on its command line', async () => {
  // A stand-in thebes-deploy that records every command line it is started
  // with. Every tool that runs the CLI is called with a stored API key present.
  const log = path.join(TMP, 'argv.log');
  const fake = path.join(TMP, 'recording-cli');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$1" = "--version" ] && echo "thebes-deploy 0.1.13"\nexit 0\n`, { mode: 0o755 });
  const dir = path.join(TMP, 'argv-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'thebes.toml'), '[project]\nname = "p"\n\n[canisters.backend]\ntype = "backend-motoko"\ncid = 123\nsource = "main.mo"\n');
  const cx = await connect({ THEBES_DEPLOY: fake, HOME: HOME_KEY, THEBES_API_KEY: 'tbk_env_key_must_not_reach_argv' });
  try {
    await cx.callTool({ name: 'scaffold_project', arguments: { name: 'argvproj', parent_dir: TMP, frontend: 'none' } });
    await cx.callTool({ name: 'check_project', arguments: { dir } });
    await cx.callTool({ name: 'credits', arguments: {} });
    await cx.callTool({ name: 'deploy', arguments: { dir, mode: 'metered', confirm_spend: true } });
    await cx.callTool({ name: 'deploy', arguments: { dir, mode: 'own-key', confirm_spend: true } });
    await cx.callTool({ name: 'redeploy_site', arguments: { dir, site_id: 4 } });
    await cx.callTool({ name: 'upgrade', arguments: { dir, contract: 'backend' } });
    await cx.callTool({ name: 'query', arguments: { cid: 5, method: 'm' } });
    await cx.callTool({ name: 'call', arguments: { dir, contract: 'backend', method: 'm', arg: '(1 : nat)' } });
  } finally {
    await cx.close();
  }
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const verbs = new Set(lines.map((l) => l.split(' ')[0]));
  for (const v of ['new', 'build', 'credits', 'deploy', 'upgrade', 'query', 'call']) assert.ok(verbs.has(v), `the CLI was never run for ${v}: ${[...verbs]}`);
  assert.ok(lines.includes('deploy --no-facts --json --site 4'), 'redeploy_site ran the CLI');
  for (const l of lines) {
    assert.doesNotMatch(l, /tbk_/, `an API key on the command line: ${l}`);
    assert.doesNotMatch(l, /--api-key|--seed-hex|--signing-key-hex|\blogin\b/, `a secret flag on the command line: ${l}`);
    assert.doesNotMatch(l, /\b[0-9a-f]{64}\b/i, `a 64-hex value on the command line: ${l}`);
  }
});

test('output never carries an API key', async () => {
  const { clean } = await import('../src/cli.mjs');
  assert.equal(clean('key tbk_abcDEF123_x stored'), 'key tbk_[hidden] stored');
  assert.equal(clean('--seed-hex ' + 'ab'.repeat(32)), '--seed-hex [hidden]');
  const hash = 'cd'.repeat(32);
  assert.equal(clean(`module_hash ${hash}`), `module_hash ${hash}`);
});

test('output never states how many validators there are', async () => {
  const { clean } = await import('../src/cli.mjs');
  const n = String(Math.floor(Math.random() * 9) + 1);
  const note = `  note: https://gateway.example does not serve /api/submit_signed (its boundary predates that route); routing submits directly to the ${n} validator(s) it publishes\n`;
  assert.equal(clean(note + '[deploy] web\n'), '[deploy] web\n');
  assert.equal(clean(`sent to ${n} validator(s)`), 'sent to the validators');
  assert.equal(clean('[deploy] web\n  verify: ok\n'), '[deploy] web\n  verify: ok\n');
});
