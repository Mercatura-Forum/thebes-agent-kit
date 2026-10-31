// Runs thebes-deploy. The server never handles a key: metered deploys use the API
// key the person stored with `thebes-deploy login` (or THEBES_API_KEY in this
// server's environment, which the CLI reads from 0.1.14 on), and signed installs
// use the CLI's own identity files. Nothing secret is ever put on its command
// line. Output is returned with colour codes removed and any API key or
// labelled seed masked, in case a tool ever prints one.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MIN_CLI = [0, 1, 13];
// The first CLI that reads THEBES_API_KEY and `login --api-key-file`.
export const KEY_FILE_CLI = [0, 1, 14];
const MAX_LOG = 20000;

export class Refusal extends Error {
  constructor(code, message, fix) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

export function cliPath() {
  return process.env.THEBES_DEPLOY || 'thebes-deploy';
}

export function clean(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    // The CLI's routing note names how many validators the gateway publishes.
    // The agent does not need it, and public output never states that number.
    .replace(/^[ \t]*note: [^\n]*\bvalidator\(s\)[^\n]*\n?/gm, '')
    .replace(/\b\d+ validator\(s\)/g, 'the validators')
    .replace(/tbk_[A-Za-z0-9_-]+/g, 'tbk_[hidden]')
    .replace(/(seed[-_ ]?(?:hex)?["'\s:=]+)[0-9a-fA-F]{64}/gi, '$1[hidden]');
}

export function cliVersion() {
  let out;
  try {
    out = execFileSync(cliPath(), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Refusal('CLI_MISSING', 'thebes-deploy is not installed or not on PATH.',
      'Install it: curl -L https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/latest/download/install-thebes-deploy.sh | bash (or set THEBES_DEPLOY to its path).');
  }
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Refusal('CLI_UNKNOWN', `Could not read the thebes-deploy version from: ${out.trim()}`, 'Reinstall thebes-deploy.');
  const v = m.slice(1).map(Number);
  if (!atLeast(v.join('.'), MIN_CLI)) {
    throw new Refusal('CLI_TOO_OLD', `thebes-deploy ${v.join('.')} is older than ${MIN_CLI.join('.')}.`,
      'Install the latest release: curl -L https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/latest/download/install-thebes-deploy.sh | bash');
  }
  return v.join('.');
}

// The Motoko compiler on PATH, or null. Qt's meta-object compiler is often
// installed as `moc` too; it does not say "Motoko compiler".
export function mocOnPath() {
  try {
    const out = execFileSync('moc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.includes('Motoko compiler') ? out.trim() : null;
  } catch {
    return null;
  }
}

export function atLeast(version, min) {
  const v = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

export function hasApiKey(version) {
  if (process.env.THEBES_API_KEY && atLeast(version, KEY_FILE_CLI)) return true;
  return fs.existsSync(path.join(os.homedir(), '.thebes', 'credentials.toml'));
}

export function noKey(version) {
  const store = atLeast(version, KEY_FILE_CLI)
    ? 'save it in a file only they can read and run `thebes-deploy login --api-key-file <file>` in their own terminal (or set THEBES_API_KEY in the environment this server runs in)'
    : 'and run `thebes-deploy login --api-key <key>` in their own terminal (thebes-deploy 0.1.14 and later read it from a file instead, so it never shows in the process list)';
  return new Refusal('NO_API_KEY', 'No API key is stored for deploys through the gateway.',
    `Ask the person to sign in to the Thebes IDE with their passkey, create an API key, ${store}. Do not ask them to paste the key here.`);
}

export function run(args, { cwd, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    const take = (d) => { out += d.toString(); if (out.length > 4 * MAX_LOG) out = out.slice(-2 * MAX_LOG); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const log = clean(out);
      resolve({ exitCode: code, timedOut: signal === 'SIGTERM', log: log.length > MAX_LOG ? '…' + log.slice(-MAX_LOG) : log, json: lastJson(log) });
    });
  });
}

// The last top-level JSON object in the output, which is where `--json` puts
// the result.
function lastJson(text) {
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{' && --depth === 0) {
        try { return JSON.parse(text.slice(i, end + 1)); } catch { break; }
      }
    }
  }
  return null;
}
