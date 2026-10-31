#!/usr/bin/env node
// Builds index.json and interfaces/ from the repositories pinned in sources.json.
//
//   node tools/build-index.mjs           write index.json and interfaces/
//   node tools/build-index.mjs --check   build into a temporary directory and compare;
//                                        exit 1 on any difference
//
// Every fact in the index is read from a repository at its pinned commit: the
// contract interfaces come from the Motoko compiler (`moc --idl`), the modules an
// example uses from its imports, and the descriptions from the hub catalog and
// catalog/platform.json. Nothing is read from a local working tree, so a fresh
// clone of this repository reproduces the index byte for byte.
//
// Needs: git, mops, and moc at the version in sources.json (MOC=<path> or
// ~/.cache/mops/moc/<version>/moc or /opt/moc-<version>/moc).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseToml, manifestFindings } from '../mcp/src/manifest.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache', 'src');
const CHECK = process.argv.includes('--check');

const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const platform = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'platform.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function findMoc(version) {
  const candidates = [
    process.env.MOC,
    path.join(os.homedir(), '.cache', 'mops', 'moc', version, 'moc'),
    `/opt/moc-${version}/moc`,
  ].filter(Boolean);
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const v = run(c, ['--version']);
    if (!v.includes('Motoko compiler')) continue;
    if (!v.includes(` ${version} `)) throw new Error(`${c} is not moc ${version}: ${v.trim()}`);
    return c;
  }
  throw new Error(`moc ${version} not found (set MOC=<path>)`);
}

// One checkout per (repo, commit), fetched once and reused.
function checkout(repo, ref) {
  const dir = path.join(CACHE, `${repo.replace('/', '__')}@${ref}`);
  if (fs.existsSync(path.join(dir, '.done'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, ref], { cwd: dir });
  run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: dir });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
  if (head !== ref) throw new Error(`${repo}: fetched ${head}, pinned ${ref}`);
  fs.writeFileSync(path.join(dir, '.done'), ref + '\n');
  return dir;
}

function read(dir, rel) {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function walk(dir, exts, skip = new Set(['node_modules', '.mops', '.git', 'dist', 'build', 'vendor', 'thebes-lib'])) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts, skip));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// README: the H1 and the first paragraph after it, as plain text.
function readmeSummary(text) {
  if (!text) return { title: null, summary: null };
  const lines = text.split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  const title = h1 >= 0 ? lines[h1].slice(2).trim() : null;
  const para = [];
  for (const l of lines.slice(h1 + 1)) {
    if (!l.trim()) { if (para.length) break; continue; }
    if (/^(#|!\[|<|\||```|>)/.test(l.trim())) { if (para.length) break; continue; }
    para.push(l.trim());
  }
  return { title, summary: plain(para.join(' ')) || null };
}

function plain(s) {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
}

// The hub catalog: one row per full-stack app and per core contract.
function hubCatalog(hubDir) {
  const text = read(hubDir, 'examples/README.md');
  const apps = {}, core = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0].replace(/\s/g, '')) || cells[0] === 'Example' || cells[0] === 'Application') continue;
    const src = line.match(/\]\(https:\/\/github\.com\/(Mercatura-Forum\/[A-Za-z0-9._-]+)\)/);
    if (cells.length >= 4 && src) {
      const live = line.match(/\[▶ live\]\((https:[^)]+)\)/);
      apps[src[1]] = { name: plain(cells[0]), shows: plain(cells[1]), guard: plain(cells[2]), live: live ? live[1] : null };
    } else {
      const p = cells[0].match(/\[`([^`]+)`\]\(\.\/([^)]+)\)/);
      if (p) core.push({ name: p[1], path: `examples/${p[2]}`, shows: plain(cells[1]), languages: plain(cells[2]) });
    }
  }
  return { apps, core };
}

// Candid service block → [{name, kind, signature, doc}]. Entries are split on the
// `;` at brace/paren depth 0, since record types carry `;` of their own. moc copies
// a method's `///` comment into the .did; it becomes the entry's doc and never
// reaches the splitter (comments carry `;` and parentheses too).
function didMethods(did) {
  const start = did.indexOf('{', did.lastIndexOf('service'));
  const body = did.slice(start + 1, did.lastIndexOf('}'));
  const entries = [];
  let depth = 0, cur = '', doc = [];
  for (const line of body.split('\n')) {
    const c = line.trim().match(/^\/\/\/?\s?(.*)$/);
    if (c) { if (!cur.trim() && depth === 0) doc.push(c[1]); continue; }
    for (const ch of line + '\n') {
      if (ch === '(' || ch === '{') depth++;
      if (ch === ')' || ch === '}') depth--;
      if (ch === ';' && depth === 0) { entries.push({ text: cur, doc }); cur = ''; doc = []; continue; }
      cur += ch;
    }
  }
  if (cur.trim()) entries.push({ text: cur, doc });
  const out = [];
  for (const e of entries) {
    const m = e.text.replace(/\s+/g, ' ').trim().match(/^([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\s*:\s*(.+)$/);
    if (!m) continue;
    const sig = m[2].trim();
    const entry = { name: m[1].replace(/"/g, ''), kind: /\b(composite_)?query$/.test(sig) ? 'query' : 'update', signature: sig };
    if (e.doc.length) entry.doc = plain(e.doc.join(' '));
    out.push(entry);
  }
  return out;
}

function mocIdl(moc, motokoDir, source, outFile) {
  run('mops', ['install'], { cwd: motokoDir });
  const srcFlags = run('mops', ['sources'], { cwd: motokoDir }).trim().split(/\s+/).filter(Boolean);
  run(moc, ['--legacy-persistence', ...srcFlags, '--idl', '-o', outFile, source], { cwd: motokoDir });
  return fs.readFileSync(outFile, 'utf8');
}

function exampleEntry(src, dir, hub, moc, ifaceRoot) {
  const repoName = src.repo.split('/')[1];
  const id = repoName.replace(/^thebes-example-/, '');
  const tomlRel = ['thebes.toml', 'motoko/thebes.toml'].find((p) => fs.existsSync(path.join(dir, p)));
  const rawToml = tomlRel ? read(dir, tomlRel) : '';
  const toml = tomlRel ? parseToml(rawToml) : {};
  const tomlDir = tomlRel ? path.dirname(path.join(dir, tomlRel)) : dir;
  const boundary = toml.networks ? Object.values(toml.networks)[0]?.boundary ?? null : null;

  const contracts = [];
  for (const [name, c] of Object.entries(toml.canisters ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const entry = { name, type: c.type ?? null, cid: typeof c.cid === 'number' ? c.cid : null };
    if (c.type === 'backend-motoko') {
      let motokoDir = path.join(dir, 'motoko');
      let source = 'main.mo';
      if (c.source) { motokoDir = path.dirname(path.join(tomlDir, c.source)); source = path.basename(c.source); }
      if (fs.existsSync(path.join(motokoDir, source))) {
        const rel = path.join(id, `${name}.did`);
        fs.mkdirSync(path.join(ifaceRoot, id), { recursive: true });
        const did = mocIdl(moc, motokoDir, source, path.join(ifaceRoot, rel));
        entry.interface = `interfaces/${rel}`;
        entry.methods = didMethods(did);
      }
    }
    if (c.type === 'frontend' && entry.cid && boundary) entry.url = `${boundary}/_/raw/${entry.cid}/index.html`;
    contracts.push(entry);
  }

  const moFiles = walk(path.join(dir, 'motoko'), ['.mo']);
  const moText = moFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const lib = [...new Set([...moText.matchAll(/mo:thebes-lib\/([A-Za-z]+)/g)].map((m) => m[1]))].sort();
  const feText = walk(path.join(dir, 'frontend', 'src'), ['.ts', '.tsx']).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const sdk = new Set();
  for (const m of feText.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@thebes\/sdk[^'"]*['"]/g)) {
    for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''); if (k) sdk.add(k); }
  }
  const code = [];
  if (/\bhttp_request\b/.test(moText)) code.push('http_request');
  if (/\braw_rand\b/.test(moText)) code.push('raw_rand');

  const cat = hub.apps[src.repo] ?? {};
  const rd = readmeSummary(read(dir, 'README.md'));
  return {
    id,
    name: cat.name ?? rd.title,
    repo: src.repo,
    ref: src.ref,
    shows: cat.shows ?? null,
    guard: cat.guard ?? null,
    summary: rd.summary,
    live: cat.live ?? contracts.find((c) => c.url)?.url ?? null,
    agents_md: fs.existsSync(path.join(dir, 'AGENTS.md')) ? `https://github.com/${src.repo}/blob/${src.ref}/AGENTS.md` : null,
    contracts,
    uses: { lib, sdk: [...sdk].sort(), code },
    findings: manifestFindings(toml, rawToml),
  };
}

function libModules(src, dir) {
  const mods = [];
  for (const f of walk(path.join(dir, 'src'), ['.mo'], new Set())) {
    const text = fs.readFileSync(f, 'utf8');
    const doc = [];
    for (const l of text.split('\n')) {
      const m = l.match(/^\s*\/\/\/?\s?(.*)$/);
      if (m) { doc.push(m[1]); continue; }
      if (!l.trim() && !doc.length) continue;
      break;
    }
    const funcs = [];
    for (const m of text.matchAll(/public\s+func\s+([A-Za-z_][A-Za-z0-9_]*)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^={]+?))?\s*[={]/g)) {
      funcs.push({ name: m[1], signature: `(${m[3].replace(/\s+/g, ' ').trim()})${m[4] ? ' : ' + m[4].replace(/\s+/g, ' ').trim() : ''}` });
    }
    const name = path.basename(f, '.mo');
    mods.push({ name, import: `mo:thebes-lib/${name}`, summary: plain(doc.join(' ')).slice(0, 400) || null, source: `https://github.com/${src.repo}/blob/${src.ref}/src/${name}.mo`, functions: funcs });
  }
  return { repo: src.repo, ref: src.ref, modules: mods };
}

function sdkEntry(src, dir) {
  const pkg = JSON.parse(read(dir, 'package.json'));
  const readme = read(dir, 'README.md') ?? '';
  const files = [];
  for (const m of readme.matchAll(/^\|\s*`((?:runtime|src)\/[^`]+)`\s*\|\s*(.+?)\s*\|\s*$/gm)) files.push({ path: m[1], does: plain(m[2]) });
  const exports = new Set();
  const seen = new Set();
  // Follows `export * from './x.js'` to src/x.ts or src/x.tsx.
  const collect = (rel) => {
    const file = ['.ts', '.tsx'].map((x) => rel.replace(/\.(js|ts|tsx)$/, '') + x).find((p) => fs.existsSync(path.join(dir, p)));
    if (!file || seen.has(file)) return;
    seen.add(file);
    const text = read(dir, file);
    for (const m of text.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, ''); if (k) exports.add(k); }
    for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) exports.add(m[1]);
    for (const m of text.matchAll(/export\s*\*\s*from\s*['"](\.\/[^'"]+)['"]/g)) collect(path.join(path.dirname(file), m[1]));
  };
  collect('src/index.ts');
  return { repo: src.repo, ref: src.ref, package: pkg.name, version: pkg.version, install: `npm install github:${src.repo}#v${pkg.version}`, entry_points: Object.keys(pkg.exports ?? {}).sort(), exports: [...exports].sort(), files };
}

function cliCommands(hubDir) {
  const text = read(hubDir, 'docs/cli-deploy.md');
  const sec = text.slice(text.indexOf('## Command reference'));
  const out = [];
  for (const m of sec.matchAll(/^\|\s*`(thebes-deploy [^`]+)`\s*\|\s*(.+?)\s*\|\s*$/gm)) out.push({ command: m[1].replace(/\\\|/g, '|'), does: plain(m[2]) });
  return out;
}

function docsList(src, hubDir) {
  const out = [];
  for (const f of ['SKILL.md', 'AGENTS.md', ...fs.readdirSync(path.join(hubDir, 'docs')).filter((x) => x.endsWith('.md')).sort().map((x) => `docs/${x}`)]) {
    const t = read(hubDir, f);
    if (!t) continue;
    const h1 = (t.match(/^# (.+)$/m) ?? [])[1] ?? null;
    out.push({ path: f, title: h1 ? plain(h1) : null, url: `https://github.com/${src.repo}/blob/${src.ref}/${f}` });
  }
  return out;
}

function main() {
  const moc = findMoc(sources.toolchain.moc);
  const outRoot = CHECK ? fs.mkdtempSync(path.join(os.tmpdir(), 'thebes-index-')) : ROOT;
  const ifaceRoot = path.join(outRoot, 'interfaces');
  fs.rmSync(ifaceRoot, { recursive: true, force: true });
  fs.mkdirSync(ifaceRoot, { recursive: true });

  const dirs = new Map(sources.sources.map((s) => [s.repo, checkout(s.repo, s.ref)]));
  const byKind = (k) => sources.sources.filter((s) => s.kind === k);
  const hubSrc = byKind('hub')[0];
  const hubDir = dirs.get(hubSrc.repo);
  const hub = hubCatalog(hubDir);

  const examples = byKind('example').map((s) => exampleEntry(s, dirs.get(s.repo), hub, moc, ifaceRoot)).sort((a, b) => a.id.localeCompare(b.id));

  const has = (e, tag) => {
    const [kind, name] = tag.split(':');
    return kind === 'lib' ? e.uses.lib.includes(name) : kind === 'sdk' ? e.uses.sdk.includes(name) : e.uses.code.includes(name);
  };
  const capabilities = platform.capabilities.map((c) => {
    const pointers = c.pointers.map((p) => {
      const d = dirs.get(p.repo);
      if (!d) throw new Error(`capability ${c.id}: ${p.repo} is not in sources.json`);
      if (!fs.existsSync(path.join(d, p.path))) throw new Error(`capability ${c.id}: ${p.repo} has no ${p.path} at ${sources.sources.find((s) => s.repo === p.repo).ref}`);
      const ref = sources.sources.find((s) => s.repo === p.repo).ref;
      return `https://github.com/${p.repo}/${fs.statSync(path.join(d, p.path)).isDirectory() ? 'tree' : 'blob'}/${ref}/${p.path}`;
    });
    const { detect, pointers: _p, ...rest } = c;
    return { ...rest, pointers, used_by: examples.filter((e) => detect.some((t) => has(e, t))).map((e) => e.id) };
  });

  const index = {
    schema: 'https://github.com/Mercatura-Forum/thebes-agent-kit/blob/main/schema/index.schema.json',
    built_from: sources.sources.map((s) => ({ repo: s.repo, ref: s.ref })),
    toolchain: { moc: sources.toolchain.moc },
    capabilities,
    examples,
    starters: hub.core.map((c) => ({ ...c, url: `https://github.com/${hubSrc.repo}/tree/${hubSrc.ref}/${c.path}` })),
    lib: libModules(byKind('lib')[0], dirs.get(byKind('lib')[0].repo)),
    sdk: sdkEntry(byKind('sdk')[0], dirs.get(byKind('sdk')[0].repo)),
    cli: { install: 'https://github.com/Mercatura-Forum/Thebes-Protocol-/releases', commands: cliCommands(hubDir) },
    docs: docsList(hubSrc, hubDir),
  };
  fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  if (!CHECK) {
    const n = examples.reduce((a, e) => a + e.findings.length, 0);
    console.log(`index.json: ${examples.length} examples, ${capabilities.length} capabilities, ${index.lib.modules.length} lib modules, ${index.cli.commands.length} commands; ${n} manifest findings`);
    return;
  }
  const diff = spawnDiff(ROOT, outRoot);
  fs.rmSync(outRoot, { recursive: true, force: true });
  if (diff) { console.error(diff); console.error('index.json or interfaces/ differ from a fresh build: run node tools/build-index.mjs and commit'); process.exit(1); }
  console.log('index.json and interfaces/ match a fresh build');
}

function spawnDiff(a, b) {
  try {
    run('diff', ['-r', path.join(a, 'interfaces'), path.join(b, 'interfaces')]);
    run('diff', [path.join(a, 'index.json'), path.join(b, 'index.json')]);
    return null;
  } catch (e) {
    return (e.stdout || e.message).slice(0, 4000);
  }
}

main();
