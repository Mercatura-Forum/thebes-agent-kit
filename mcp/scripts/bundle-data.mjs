#!/usr/bin/env node
// What the published package carries besides its code: the kit's index.json,
// AGENTS.md and the interfaces the index names, under data/, plus LICENSE and
// NOTICE. The repo root holds the only maintained copies; these are made at
// pack time and removed after it, so a stale copy never shadows the repo's.
// Progress goes to stderr: `npm pack --json` owns stdout.
//
//   node scripts/bundle-data.mjs copy    prepack: copy them in
//   node scripts/bundle-data.mjs check   every copy equals the repo's (exit 1 if not)
//   node scripts/bundle-data.mjs clean   postpack: remove them

import fs from 'node:fs';
import path from 'node:path';

const MCP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ROOT = path.resolve(MCP, '..');
const DATA = path.join(MCP, 'data');

// [path in the repo, path in the package]
function files() {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
  const interfaces = [...new Set(index.examples.flatMap((e) => e.contracts.map((c) => c.interface).filter(Boolean)))].sort();
  return [
    ...['index.json', 'AGENTS.md', ...interfaces].map((rel) => [rel, path.join('data', rel)]),
    ['LICENSE', 'LICENSE'],
    ['NOTICE', 'NOTICE'],
  ];
}

const mode = process.argv[2];
if (mode === 'copy') {
  fs.rmSync(DATA, { recursive: true, force: true });
  for (const [from, to] of files()) {
    fs.mkdirSync(path.dirname(path.join(MCP, to)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), path.join(MCP, to));
  }
  console.error(`bundle-data: copied ${files().length} files`);
} else if (mode === 'check') {
  const bad = files().filter(([from, to]) => {
    const p = path.join(MCP, to);
    return !fs.existsSync(p) || !fs.readFileSync(p).equals(fs.readFileSync(path.join(ROOT, from)));
  });
  for (const [from, to] of bad) console.error(`bundle-data: ${to} is missing or differs from ${from}`);
  if (bad.length) process.exit(1);
  console.error(`bundle-data: ${files().length} files equal the repo's`);
} else if (mode === 'clean') {
  fs.rmSync(DATA, { recursive: true, force: true });
  for (const f of ['LICENSE', 'NOTICE']) fs.rmSync(path.join(MCP, f), { force: true });
} else {
  console.error('usage: bundle-data.mjs copy|check|clean');
  process.exit(2);
}
