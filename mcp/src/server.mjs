#!/usr/bin/env node
// thebes-mcp: an MCP server that lets an AI agent find a starting point on Thebes,
// check a project, deploy it and use the result. Runs over stdio:
//
//   { "mcpServers": { "thebes": { "command": "npx", "args": ["-y", "thebes-mcp"] } } }
//
// Tools that read the kit (examples, interfaces, capabilities, library modules)
// answer from index.json. Tools that build, deploy or call run thebes-deploy
// (THEBES_DEPLOY overrides its path) and never take a key as input. The hosting
// tools sign the person in to thebesprotocol.com from their phone (memphis.mjs)
// and act on their sites through the hosting contract (hosting.mjs); no tool
// ever returns a token.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import QRCode from 'qrcode';
import { receipt, BOUNDARY } from './chain.mjs';
import { Refusal, cliVersion, hasApiKey, mocOnPath, noKey, run } from './cli.mjs';
import * as hosting from './hosting.mjs';
import { NETWORK_BLOCK, addLegacyPersistence, manifestFindings, parseToml, useGatewayNetwork } from './manifest.mjs';
import * as memphis from './memphis.mjs';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const DATA = [path.join(HERE, '..', 'data'), path.join(HERE, '..', '..')].find((d) => fs.existsSync(path.join(d, 'index.json')));
if (!DATA) throw new Error('index.json not found next to thebes-mcp');
const INDEX = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
const GUIDE = fs.readFileSync(path.join(DATA, 'AGENTS.md'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const CHAIN_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CHAIN_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const refuse = (code, message, fix) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, fix }, null, 2) }] });

// Every handler runs through here: a Refusal becomes a coded answer the agent can
// act on; anything else is reported as INTERNAL with its message.
function tool(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      if (e instanceof Refusal) return refuse(e.code, e.message, e.fix);
      return refuse('INTERNAL', String(e && e.message ? e.message : e), 'Report this to the Thebes team with the tool name and arguments.');
    }
  };
}

function example(id) {
  const e = INDEX.examples.find((x) => x.id === id);
  if (!e) throw new Refusal('UNKNOWN_EXAMPLE', `No example "${id}".`, `Use one of: ${INDEX.examples.map((x) => x.id).join(', ')}.`);
  return e;
}

function projectDir(dir) {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(path.join(abs, 'thebes.toml'))) {
    throw new Refusal('NO_MANIFEST', `${abs} has no thebes.toml.`, 'Pass the project directory (the one holding thebes.toml), or create a project with scaffold_project.');
  }
  return abs;
}

function readManifest(dir) {
  const raw = fs.readFileSync(path.join(dir, 'thebes.toml'), 'utf8');
  const toml = parseToml(raw);
  return { raw, toml, findings: manifestFindings(toml, raw) };
}

function contractsOf(toml) {
  return Object.entries(toml.canisters ?? {}).map(([name, c]) => ({ name, type: c.type ?? null, cid: typeof c.cid === 'number' ? c.cid : c.cid ?? null }));
}

const server = new McpServer({ name: 'thebes', version: VERSION }, { instructions: 'Start with find_examples or read the guide resource (thebes://guide). Check a project with check_project before deploy. Never ask the person to paste an API key or a seed into the conversation.' });

server.registerResource('guide', 'thebes://guide', { title: 'Building on Thebes (AGENTS.md)', mimeType: 'text/markdown' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }));
server.registerResource('index', 'thebes://index', { title: 'The Thebes index (index.json)', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(INDEX) }] }));

// ── Reading the kit ─────────────────────────────────────────────────────────

server.registerTool('find_examples', {
  title: 'Find example applications',
  description: 'List the Thebes example applications, optionally filtered by words in what they do or by a platform capability (passkeys, http-outcalls, randomness, media, invoices, roles). Also lists the single-contract starters. Use it to pick a starting point.',
  inputSchema: {
    query: z.string().optional().describe('Words to match against the name, what it shows and its guard, e.g. "booking deposit"'),
    capability: z.string().optional().describe('A capability id from list_capabilities'),
  },
  annotations: READ,
}, tool(async ({ query, capability }) => {
  if (capability && !INDEX.capabilities.some((c) => c.id === capability)) {
    throw new Refusal('UNKNOWN_CAPABILITY', `No capability "${capability}".`, `Use one of: ${INDEX.capabilities.map((c) => c.id).join(', ')}.`);
  }
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const cap = capability ? INDEX.capabilities.find((c) => c.id === capability) : null;
  const match = (text) => words.every((w) => text.toLowerCase().includes(w));
  const examples = INDEX.examples
    .filter((e) => !cap || cap.used_by.includes(e.id))
    .filter((e) => match([e.id, e.name, e.shows, e.guard, e.summary].filter(Boolean).join(' ')))
    .map((e) => ({ id: e.id, name: e.name, shows: e.shows, guard: e.guard, live: e.live, uses: e.uses, methods: e.contracts.reduce((n, c) => n + (c.methods?.length ?? 0), 0), findings: e.findings.map((f) => f.rule) }));
  const starters = INDEX.starters.filter((s) => match([s.name, s.shows].join(' '))).map(({ name, shows, languages, url }) => ({ name, shows, languages, url }));
  return ok({ examples, starters });
}));

server.registerTool('get_example', {
  title: 'Get an example application',
  description: 'Everything about one example: its contracts and their ids, every method with its Candid signature and doc, the modules it uses, its live copy and repository, and any platform rule its manifest breaks.',
  inputSchema: { id: z.string().describe('Example id, e.g. "booking"') },
  annotations: READ,
}, tool(async ({ id }) => ok(example(id))));

server.registerTool('get_interface', {
  title: 'Get a contract interface',
  description: 'The Candid interface (.did) of an example backend, as the Motoko compiler produced it.',
  inputSchema: { example: z.string(), contract: z.string().optional().describe('Contract name; defaults to the example\'s backend') },
  annotations: READ,
}, tool(async ({ example: id, contract }) => {
  const e = example(id);
  const withIface = e.contracts.filter((c) => c.interface);
  const c = contract ? withIface.find((x) => x.name === contract) : withIface[0];
  if (!c) throw new Refusal('NO_INTERFACE', `${id} has no interface for "${contract}".`, `Contracts with an interface: ${withIface.map((x) => x.name).join(', ') || 'none'}.`);
  return { content: [{ type: 'text', text: fs.readFileSync(path.join(DATA, c.interface), 'utf8') }] };
}));

server.registerTool('list_capabilities', {
  title: 'List platform capabilities',
  description: 'What the Thebes platform offers (passkey sign-in, HTTP outcalls, randomness, media, invoices, roles, upgrades, deploying), the rules for each, where each is documented, and which examples use it.',
  annotations: READ,
}, tool(async () => ok(INDEX.capabilities)));

server.registerTool('get_lib_module', {
  title: 'Get a thebes-lib module',
  description: 'A Motoko module from thebes-lib (Admin, Users, Pagination, MemphisAuth, Invoices, Media): its import line, what it does and every public function with its signature. Without a name, lists the modules and the frontend SDK exports.',
  inputSchema: { name: z.string().optional() },
  annotations: READ,
}, tool(async ({ name }) => {
  if (!name) return ok({ modules: INDEX.lib.modules.map((m) => ({ name: m.name, import: m.import, summary: m.summary })), sdk: INDEX.sdk });
  const m = INDEX.lib.modules.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!m) throw new Refusal('UNKNOWN_MODULE', `No thebes-lib module "${name}".`, `Use one of: ${INDEX.lib.modules.map((x) => x.name).join(', ')}.`);
  return ok(m);
}));

// ── Projects on this machine ────────────────────────────────────────────────

server.registerTool('scaffold_project', {
  title: 'Create a new project',
  description: 'Create a new Thebes project with `thebes-deploy new`: a backend (Motoko or Rust), an optional frontend, optional passkey sign-in, a manifest and an AGENTS.md. The manifest already uses the upgrade-safe build.',
  inputSchema: {
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/).describe('Lowercase letter first, then lowercase letters, digits, - or _'),
    parent_dir: z.string().describe('Directory to create the project in'),
    backend: z.enum(['motoko', 'rust']).default('motoko'),
    frontend: z.enum(['react', 'vanilla', 'none']).default('react'),
    auth: z.enum(['memphis', 'none']).default('memphis').describe('memphis = passkey sign-in'),
  },
  annotations: LOCAL,
}, tool(async ({ name, parent_dir, backend, frontend, auth }) => {
  cliVersion();
  const parent = path.resolve(parent_dir.replace(/^~(?=$|\/)/, os.homedir()));
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(path.join(parent, name))) throw new Refusal('EXISTS', `${path.join(parent, name)} already exists.`, 'Choose another name or parent_dir.');
  const r = await run(['new', name, '--backend', backend, '--frontend', frontend, '--auth', frontend === 'none' ? 'none' : auth, '--no-facts'], { cwd: parent, timeoutMs: 300000 });
  const dir = path.join(parent, name);
  if (r.exitCode !== 0 || !fs.existsSync(path.join(dir, 'thebes.toml'))) {
    throw new Refusal('SCAFFOLD_FAILED', 'thebes-deploy new did not create the project.', r.log.slice(-3000));
  }
  const { toml, findings } = readManifest(dir);
  return ok({ dir, contracts: contractsOf(toml), findings, next: 'check_project, then deploy' });
}));

server.registerTool('start_from_example', {
  title: 'Copy an example to start from',
  description: 'Copy an example repository, at the commit the index describes, into a new directory as a new application: every contract gets a fresh id (the example\'s ids belong to its running copy), the manifest reaches the chain through the public gateway, and Motoko backends build with --legacy-persistence.',
  inputSchema: { example: z.string(), parent_dir: z.string(), name: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional().describe('Directory name; defaults to the example id') },
  annotations: { ...LOCAL, openWorldHint: true },
}, tool(async ({ example: id, parent_dir, name }) => {
  const e = example(id);
  cliVersion();
  const parent = path.resolve(parent_dir.replace(/^~(?=$|\/)/, os.homedir()));
  const dir = path.join(parent, name ?? e.id);
  if (fs.existsSync(dir)) throw new Refusal('EXISTS', `${dir} already exists.`, 'Choose another name or parent_dir.');
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['fetch', '-q', '--depth', '1', `https://github.com/${e.repo}.git`, e.ref]);
  git(['checkout', '-q', 'FETCH_HEAD']);
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  const tomlRel = ['thebes.toml', 'motoko/thebes.toml'].find((p) => fs.existsSync(path.join(dir, p)));
  if (!tomlRel) throw new Refusal('NO_MANIFEST', `${e.repo} has no thebes.toml.`, 'Start from scaffold_project instead.');
  const projectRoot = path.dirname(path.join(dir, tomlRel));

  const original = readManifest(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'thebes.toml'), addLegacyPersistence(useGatewayNetwork(original.raw)));
  // fresh-cid also rewrites every place the project bakes a cid in (frontend config).
  const ids = [];
  for (const c of contractsOf(original.toml)) {
    const r = await run(['fresh-cid', c.name, '--no-facts'], { cwd: projectRoot, timeoutMs: 60000 });
    if (r.exitCode !== 0) throw new Refusal('FRESH_CID_FAILED', `Could not give ${c.name} a fresh id.`, r.log.slice(-2000));
    ids.push({ contract: c.name, example_cid: c.cid });
  }
  const now = readManifest(projectRoot);
  for (const x of ids) {
    x.cid = now.toml.canisters[x.contract].cid;
    if (x.cid === x.example_cid) throw new Refusal('FRESH_CID_FAILED', `${x.contract} still has the example's id.`, 'Run `thebes-deploy fresh-cid <contract>` in the project.');
  }
  return ok({
    dir: projectRoot,
    from: { repo: e.repo, ref: e.ref },
    contracts: ids,
    changed: ['fresh contract ids in thebes.toml and the frontend config', 'network block → public gateway', 'Motoko build → --legacy-persistence'],
    findings: now.findings,
    next: 'Rename the project in thebes.toml [project] name, then check_project, then deploy.',
  });
}));

server.registerTool('check_project', {
  title: 'Check a project before deploying',
  description: 'Check the manifest against the platform rules, check the toolchain (thebes-deploy version, the Motoko compiler), and build every contract. A deploy should follow only a clean check.',
  inputSchema: { dir: z.string().describe('Project directory (holds thebes.toml)') },
  annotations: LOCAL,
}, tool(async ({ dir }) => {
  const abs = projectDir(dir);
  const cli = cliVersion();
  const { toml, findings } = readManifest(abs);
  const needsMoc = Object.values(toml.canisters ?? {}).some((c) => c.type === 'backend-motoko');
  const moc = needsMoc ? mocOnPath() : null;
  const toolchain = { thebes_deploy: cli, moc: moc ?? (needsMoc ? 'not found: `moc --version` must say "Motoko compiler" (Qt\'s moc is a different program)' : 'not needed') };
  const r = await run(['build', '--no-facts'], { cwd: abs, timeoutMs: 900000 });
  const built = [...r.log.matchAll(/✓\s+(\S+)\s+→\s+(\S+)\s+\((\d+) bytes\)/g)].map((m) => ({ contract: m[1], wasm: m[2], bytes: Number(m[3]) }));
  const clean = findings.length === 0 && r.exitCode === 0 && (!needsMoc || moc);
  return ok({ ok: Boolean(clean), contracts: contractsOf(toml), findings, toolchain, build: { exit_code: r.exitCode, built, log: r.exitCode === 0 ? undefined : r.log.slice(-4000) } });
}));

// ── The chain ───────────────────────────────────────────────────────────────

server.registerTool('credits', {
  title: 'Show deploy credits',
  description: 'The credit balance behind metered deploys and how many deploys it buys. Needs the person to have run `thebes-deploy login` once.',
  annotations: CHAIN_READ,
}, tool(async () => {
  const cli = cliVersion();
  if (!hasApiKey(cli)) throw noKey(cli);
  const r = await run(['credits', '--no-facts', '--json'], { timeoutMs: 60000 });
  if (r.exitCode !== 0) throw new Refusal('CREDITS_FAILED', 'Could not read the credit balance.', r.log.slice(-2000));
  return ok(r.json ?? { log: r.log });
}));

server.registerTool('deploy', {
  title: 'Deploy a project',
  description: 'Build and deploy every contract in the project. mode "metered" deploys through the gateway and is charged to the person\'s credits; "own-key" signs the install with the CLI\'s local identity. To deploy into a paid Thebes Hosting site use redeploy_site. Refuses while check_project would report a finding.',
  inputSchema: {
    dir: z.string(),
    mode: z.enum(['metered', 'own-key']),
    confirm_spend: z.boolean().describe('true only after the person agreed to spend credits on this deploy (metered)'),
  },
  annotations: CHAIN_WRITE,
}, tool(async ({ dir, mode, confirm_spend }) => {
  const abs = projectDir(dir);
  const cli = cliVersion();
  checked(abs);
  const metered = mode === 'metered';
  if (metered && !hasApiKey(cli)) throw noKey(cli);
  if (metered && confirm_spend !== true) throw new Refusal('CONFIRM_SPEND', 'A metered deploy spends credits.', 'Tell the person what will be deployed and its cost (see credits), and call again with confirm_spend: true once they agree.');
  const args = ['deploy', '--no-facts', '--json'];
  if (metered) args.push('--metered');
  return deployed(abs, await run(args, { cwd: abs, timeoutMs: 1800000 }));
}));

function checked(abs) {
  const { findings } = readManifest(abs);
  if (findings.length) throw new Refusal('CHECK_FAILED', `The manifest breaks ${findings.length} platform rule(s): ${findings.map((f) => f.rule).join(', ')}.`, findings.map((f) => f.fix).join('\n\n'));
}

function deployed(abs, r, site) {
  const { toml } = readManifest(abs);
  const contracts = contractsOf(toml).map((c) => ({ ...c, url: c.type === 'frontend' && typeof c.cid === 'number' ? `${BOUNDARY}/_/raw/${c.cid}/index.html` : undefined }));
  if (r.exitCode !== 0) throw new Refusal(r.timedOut ? 'DEPLOY_TIMEOUT' : 'DEPLOY_FAILED', 'The deploy did not complete.', r.log.slice(-4000));
  return ok({ ok: true, contracts, site: site ?? undefined, result: r.json ?? undefined });
}

server.registerTool('upgrade', {
  title: 'Upgrade a contract and keep its data',
  description: 'Ship a new version of one contract to its existing id, keeping its state. The CLI refuses an upgrade that would lose state; this tool never overrides that.',
  inputSchema: { dir: z.string(), contract: z.string() },
  annotations: CHAIN_WRITE,
}, tool(async ({ dir, contract }) => {
  const abs = projectDir(dir);
  cliVersion();
  const { toml, findings } = readManifest(abs);
  if (!toml.canisters?.[contract]) throw new Refusal('UNKNOWN_CONTRACT', `No contract "${contract}" in thebes.toml.`, `Contracts: ${Object.keys(toml.canisters ?? {}).join(', ')}.`);
  if (findings.length) throw new Refusal('CHECK_FAILED', `The manifest breaks: ${findings.map((f) => f.rule).join(', ')}.`, findings.map((f) => f.fix).join('\n\n'));
  const r = await run(['upgrade', contract, '--no-facts', '--json'], { cwd: abs, timeoutMs: 1800000 });
  if (r.exitCode !== 0) throw new Refusal('UPGRADE_REFUSED', 'The upgrade did not complete. If the CLI says state would be lost, the contract was built in another persistence mode: do not force it.', r.log.slice(-4000));
  return ok({ ok: true, contract, result: r.json ?? undefined });
}));

// A query needs a manifest naming the contract; for a bare cid, a throwaway one.
async function runCall(kind, { dir, contract, cid, method, arg }) {
  let cwd, name, tmp;
  if (cid !== undefined) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thebes-mcp-'));
    fs.writeFileSync(path.join(tmp, 'thebes.toml'), `[project]\nname = "query"\ndefault_network = "thebes"\nchain_id = 2026\n\n${NETWORK_BLOCK}\n\n[canisters.target]\ntype = "backend-motoko"\ncid = ${cid}\nwasm = "none.wasm"\n`);
    cwd = tmp; name = 'target';
  } else {
    if (!dir || !contract) throw new Refusal('NO_TARGET', 'Name a contract: cid, or dir + contract.', 'Pass cid for any contract on the chain, or dir and contract for one in a project.');
    cwd = projectDir(dir); name = contract;
  }
  try {
    const args = [kind, name, method, '--no-facts', '--json'];
    if (arg) args.push('--arg', arg);
    const r = await run(args, { cwd, timeoutMs: 120000 });
    const j = r.json;
    if (!j || j.status !== 'success') throw new Refusal(`${kind.toUpperCase()}_FAILED`, j?.error ?? 'The call did not return a reply.', j ? 'Check the method name and argument against get_interface.' : r.log.slice(-2000));
    return ok({ reply: j.reply_candid ?? j.reply, cycles_used: j.cycles_used });
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const callShape = {
  cid: z.number().int().positive().optional().describe('Any contract id on the chain'),
  dir: z.string().optional().describe('Project directory, with contract'),
  contract: z.string().optional(),
  method: z.string(),
  arg: z.string().optional().describe('Candid text, e.g. \'(42 : nat, "hello")\''),
};

server.registerTool('query', {
  title: 'Query a contract',
  description: 'Read from a contract without changing it: by cid (any contract, e.g. an example\'s running copy) or by project directory and contract name. Returns the reply as Candid text.',
  inputSchema: callShape,
  annotations: CHAIN_READ,
}, tool((a) => {
  cliVersion();
  return runCall('query', a);
}));

server.registerTool('call', {
  title: 'Call a contract (update)',
  description: 'Send an update call that may change the contract\'s state, signed with the CLI\'s local identity. By cid or by project directory and contract name.',
  inputSchema: callShape,
  annotations: CHAIN_WRITE,
}, tool((a) => {
  cliVersion();
  return runCall('call', a);
}));

server.registerTool('read_receipt', {
  title: 'Read the receipt of a call',
  description: 'The chain\'s receipt for one message, by the message_hash a tool returned: whether it ran, and its reply as hex. Use it when a call timed out before its reply came back.',
  inputSchema: { message_hash: z.string().regex(/^[0-9a-f]{64}$/).describe('64 lowercase hex characters') },
  annotations: CHAIN_READ,
}, tool(async ({ message_hash }) => {
  const r = await receipt(message_hash);
  return ok({ message_hash, status: r.status ?? 'unknown', lifecycle: r.lifecycle ?? null, reply_hex: r.reply ?? null, error: r.error ?? null });
}));

// ── Thebes Hosting (thebesprotocol.com) ─────────────────────────────────────

// The sign-in request this process opened and has not claimed yet. Its secret
// never leaves memory.
let pendingLink = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const isoNs = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

server.registerTool('sign_in', {
  title: 'Sign in to thebesprotocol.com from a phone',
  description: 'Start signing the person in to Thebes Hosting with the passkey on their phone. Returns a link (and its QR code) and a six-symbol code: the person opens the link on their phone, types the code and approves with their passkey. Then call sign_in_status. The sign-in is good for thebesprotocol.com only. If they are already signed in, says so and opens nothing.',
  inputSchema: { fresh: z.boolean().default(false).describe('true to start a new sign-in even when one is stored') },
  annotations: CHAIN_WRITE,
}, tool(async ({ fresh }) => {
  const stored = memphis.storedSession();
  if (stored && !fresh) return ok({ ...memphis.describe(stored), next: 'Already signed in. Use list_sites, create_site or create_payment_link.' });
  const link = await memphis.beginDeviceLink();
  pendingLink = link;
  const qr = await QRCode.toString(link.approveUrl, { type: 'utf8', errorCorrectionLevel: 'M' });
  const png = await QRCode.toBuffer(link.approveUrl, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  return {
    content: [
      { type: 'text', text: JSON.stringify({
        approve_url: link.approveUrl, code: link.code, expires_at: isoNs(link.expiresAtNs),
        tell_the_person: `Open ${link.approveUrl} on your phone (or scan the QR code), type the code ${link.code}, and approve with your passkey.`,
        next: 'Call sign_in_status; it waits for the approval.',
      }, null, 2) },
      { type: 'text', text: qr },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ],
  };
}));

server.registerTool('sign_in_status', {
  title: 'Wait for the phone to approve the sign-in',
  description: 'After sign_in: waits up to wait_seconds for the person to approve on their phone, then completes the sign-in. Without an open request, reports whether the person is signed in.',
  inputSchema: { wait_seconds: z.number().int().min(0).max(50).default(25) },
  annotations: CHAIN_WRITE,
}, tool(async ({ wait_seconds }) => {
  if (!pendingLink) return ok(memphis.describe(memphis.storedSession()));
  const link = pendingLink;
  const deadline = Date.now() + wait_seconds * 1000;
  for (;;) {
    const info = await memphis.deviceLinkInfo(link.linkIdHex);
    if (info) link.expiresAtNs = info.expiresAtNs;
    if (info?.approved) {
      const s = await memphis.claimDeviceLink(link);
      if (s) {
        await memphis.saveSession(s);
        pendingLink = null;
        return ok({ ...memphis.describe(s), next: 'Signed in. Use list_sites, create_site or create_payment_link.' });
      }
    } else if (!info && nowNs() > link.expiresAtNs) {
      pendingLink = null;
      throw new Refusal('LINK_EXPIRED', 'Nobody approved the sign-in in time, so the request ended.', 'Call sign_in again and show the person the new link and code.');
    }
    if (Date.now() >= deadline) {
      return ok({ signed_in: false, waiting_for_phone: true, approve_url: link.approveUrl, code: link.code, expires_at: isoNs(link.expiresAtNs), next: 'Call sign_in_status again.' });
    }
    await sleep(2000);
  }
}));

server.registerTool('sign_out', {
  title: 'Sign out of thebesprotocol.com',
  description: 'End the stored sign-in: every token of it is revoked on the chain, then the local copy is deleted.',
  annotations: { ...CHAIN_WRITE, destructiveHint: true },
}, tool(async () => {
  pendingLink = null;
  return ok(await memphis.signOut());
}));

server.registerTool('list_sites', {
  title: 'List the person\'s hosted sites',
  description: 'The person\'s Thebes Hosting sites (id, name, domain, status, contracts, paid until), their orders, and the contact details on file. Needs sign_in.',
  annotations: CHAIN_READ,
}, tool(async () => ok(await hosting.panel())));

server.registerTool('create_site', {
  title: 'Create a hosted site',
  description: 'Add a site to the person\'s Thebes Hosting account, on the yearly plan. It starts as "requested"; start the free three months on it with start_trial (when open and not used) or pay for it with create_payment_link, then deploy into it with redeploy_site. Needs sign_in.',
  inputSchema: {
    name: z.string().min(1).max(120),
    domain: z.string().max(253).optional().describe('Bare domain like example.com, if decided; can be set later'),
  },
  annotations: CHAIN_WRITE,
}, tool(async ({ name, domain }) => {
  const r = await hosting.addSite({ name, domain: domain ?? '', plan: 'annual' });
  return ok({ ...r, price: await hosting.price(), next: 'start_trial with this site_id, or create_payment_link' });
}));

server.registerTool('start_trial', {
  title: 'Start the free three months on a site',
  description: 'Start the free three months on one of the person\'s sites, instead of paying: once per person, one site that has never been paid, an email and phone on file, and only while the Thebes team has the offer open (refused with TRIAL_CLOSED otherwise). Then deploy into it with redeploy_site. Needs sign_in.',
  inputSchema: { site_id: z.number().int().positive() },
  annotations: CHAIN_WRITE,
}, tool(async ({ site_id }) => {
  const r = await hosting.startTrial(site_id);
  return ok({ ...r, next: 'redeploy_site with this site_id; before free_until, create_payment_link keeps it online.' });
}));

server.registerTool('set_contact_details', {
  title: 'Save the person\'s contact details',
  description: 'Save the email and phone number the hosting account needs for receipts (a payment link refuses without both), and optionally organisation, billing email and tax number. Fields left out keep their saved value. Needs sign_in.',
  inputSchema: {
    email: z.string().email().max(200).optional(),
    phone: z.string().min(5).max(40).optional(),
    organisation: z.string().max(150).optional(),
    billing_email: z.string().email().max(200).optional(),
    tax_id: z.string().max(60).optional(),
  },
  annotations: CHAIN_WRITE,
}, tool(async (a) => ok(await hosting.setContact(a))));

server.registerTool('create_payment_link', {
  title: 'Create a payment link for a site',
  description: 'Open the order for a year of hosting for one of the person\'s sites and return the card checkout link for them to pay (amount from the contract). A new link replaces any earlier one for the same order. A site that is already paid is refused unless renew is true (it pays for the year after). Needs sign_in, and an email and phone number on file (set_contact_details).',
  inputSchema: { site_id: z.number().int().positive(), renew: z.boolean().default(false).describe('true to pay for the next year of a site that is paid now') },
  annotations: CHAIN_WRITE,
}, tool(async ({ site_id, renew }) => {
  const r = await hosting.paymentLink(site_id, { renew });
  return ok({ ...r, tell_the_person: `Pay ${r.amount} for a year of "${r.site_name}" here: ${r.checkout_url}`, next: 'After they pay, payment_status shows the paid year.' });
}));

server.registerTool('payment_status', {
  title: 'Is a site paid for',
  description: 'Whether one of the person\'s sites is paid, until when, and its orders, read from the hosting contract. Needs sign_in.',
  inputSchema: { site_id: z.number().int().positive() },
  annotations: CHAIN_READ,
}, tool(async ({ site_id }) => ok(await hosting.paymentStatus(site_id))));

server.registerTool('redeploy_site', {
  title: 'Deploy into a paid site',
  description: 'Deploy the project into one of the person\'s paid Thebes Hosting sites: the first deploy creates the site\'s contracts, every later one updates the same contracts and keeps the backend\'s data. Nothing is charged while the year is paid. Needs the API key behind deploys (as for deploy) and, for the check before deploying, sign_in.',
  inputSchema: { dir: z.string(), site_id: z.number().int().positive() },
  annotations: CHAIN_WRITE,
}, tool(async ({ dir, site_id }) => {
  const abs = projectDir(dir);
  const cli = cliVersion();
  checked(abs);
  if (!hasApiKey(cli)) throw noKey(cli);
  // The gateway asks the contract the same question before it installs anything.
  let target = null;
  if (memphis.storedSession()) target = await hosting.deployTarget(await hosting.deployAccount(), site_id);
  return deployed(abs, await run(['deploy', '--no-facts', '--json', '--site', String(site_id)], { cwd: abs, timeoutMs: 1800000 }), target);
}));

server.registerTool('connect_domain', {
  title: 'Connect the person\'s own domain to a paid site',
  description: 'attach: point a domain at a paid, deployed site and get the DNS records the person must add at their registrar. check: re-read DNS and finish when the records are in place. list: every domain on the account. remove: take a domain off. Needs sign_in.',
  inputSchema: {
    action: z.enum(['attach', 'check', 'list', 'remove']),
    site_id: z.number().int().positive().optional().describe('For attach'),
    domain: z.string().max(253).optional().describe('Bare domain like shop.example.com (attach, check, remove)'),
  },
  annotations: CHAIN_WRITE,
}, tool(async ({ action, site_id, domain }) => {
  if (action === 'attach' && site_id === undefined) throw new Refusal('MISSING_ARGUMENT', 'attach needs site_id.', 'Pass the site_id from list_sites.');
  if (action !== 'list' && !domain) throw new Refusal('MISSING_ARGUMENT', `${action} needs domain.`, 'Pass the bare domain, like shop.example.com.');
  return ok(await hosting.domains(action, { siteId: site_id, domain }));
}));

await server.connect(new StdioServerTransport());
