#!/usr/bin/env node
// The package gate: what `npm install thebes-mcp` gives a person must start and
// answer. Packs this directory (or takes --tarball <file>), installs the tarball
// into an empty folder, starts the installed `thebes-mcp` over stdio as a client
// does, lists its tools, reads thebes://index and thebes://guide, and checks
// that the packaged index, guide and interfaces are byte for byte the repo's.
// Exit 0 only when all of that holds.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MCP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = path.resolve(MCP, '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thebes-mcp-pack-'));
const fail = (msg) => { console.error(`FAIL ${msg}`); process.exitCode = 1; };
let client;
try {
  let tarball = arg('--tarball');
  if (!tarball) {
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: MCP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    tarball = path.join(work, JSON.parse(out)[0].filename);
  }
  tarball = path.resolve(tarball);
  console.log(`tarball ${tarball}`);

  const install = path.join(work, 'install');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'package.json'), '{ "name": "pack-check", "private": true }\n');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', tarball], { cwd: install, stdio: ['ignore', 'inherit', 'inherit'] });
  const pkg = path.join(install, 'node_modules', 'thebes-mcp');
  const bin = path.join(install, 'node_modules', '.bin', 'thebes-mcp');
  if (!fs.existsSync(bin)) throw new Error('the package installs no thebes-mcp command');

  // Started exactly as an mcpServers entry starts it, from the empty folder.
  const stderr = [];
  const transport = new StdioClientTransport({ command: bin, args: [], cwd: install, env: { ...process.env, HOME: install }, stderr: 'pipe' });
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  client = new Client({ name: 'pack-check', version: '0' });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(`the installed server did not start: ${e.message}\n${stderr.join('').trim()}`);
  }

  const { tools } = await client.listTools();
  console.log(`tools ${tools.length}: ${tools.map((t) => t.name).join(', ')}`);
  if (tools.length === 0) fail('no tools listed');

  const index = JSON.parse((await client.readResource({ uri: 'thebes://index' })).contents[0].text);
  const rootIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
  console.log(`thebes://index ${index.examples.length} examples, ${index.starters.length} starters`);
  if (JSON.stringify(index) !== JSON.stringify(rootIndex)) fail('thebes://index differs from the repo index.json');
  const guide = (await client.readResource({ uri: 'thebes://guide' })).contents[0].text;
  if (guide !== fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')) fail('thebes://guide differs from the repo AGENTS.md');

  // Every file the package carries as data is the repo's own, and every
  // interface the index names is in the package.
  for (const rel of ['index.json', 'AGENTS.md']) {
    if (!fs.readFileSync(path.join(pkg, 'data', rel)).equals(fs.readFileSync(path.join(ROOT, rel)))) fail(`data/${rel} differs from the repo`);
  }
  const named = rootIndex.examples.flatMap((e) => e.contracts.map((c) => c.interface).filter(Boolean));
  for (const rel of named) {
    const p = path.join(pkg, 'data', rel);
    if (!fs.existsSync(p)) fail(`data/${rel} is missing`);
    else if (!fs.readFileSync(p).equals(fs.readFileSync(path.join(ROOT, rel)))) fail(`data/${rel} differs from the repo`);
  }
  const did = await client.callTool({ name: 'get_interface', arguments: { example: 'crm' } });
  if (did.isError || !did.content[0].text.includes('service')) fail('get_interface crm did not return a Candid interface');
  console.log(`interfaces ${named.length} named in the index, all packaged`);
  for (const f of ['LICENSE', 'NOTICE']) if (!fs.existsSync(path.join(pkg, f))) fail(`${f} is not in the package`);
} catch (e) {
  fail(e.message);
} finally {
  await client?.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(process.exitCode ? 'pack-check: FAILED' : 'pack-check: ok');
