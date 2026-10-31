// Sign-in to thebesprotocol.com through Memphis (contract 921), from a phone:
// the RFC 8628 device grant the SDK's passkey.js names device link. This
// process opens a request holding a 32-byte secret (only its hash goes to
// Memphis); the person opens the link on a phone, types the six-symbol code and
// approves with a passkey; this process then claims an access token and a
// refresh chain scoped to https://thebesprotocol.com alone, never a master
// session. The secret stays in memory. The claimed session is kept in
// ~/.thebes/memphis-session.json (mode 600), so every thebes-mcp process of
// this user shares one sign-in.
//
// Refresh tokens rotate: presenting one replaces it, and presenting a spent one
// revokes the whole chain (Memphis reuse detection). So every read-exchange-
// write of the file runs under an exclusive lock: two processes exchanging the
// same token would sign the person out. Sign-out uses that same detection on
// purpose: exchange once, then present the spent token, which revokes every
// token of this sign-in on the chain.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDL } from '@dfinity/candid';
import { call, fromHex, query, toHex } from './chain.mjs';
import { Refusal } from './cli.mjs';

export const MEMPHIS_CID = 921;
export const ORIGIN = 'https://thebesprotocol.com';
export const CONNECT_URL = 'https://memphis.mercaturaforum.com/connect/';
const LINK_SECRET_DOMAIN = Buffer.from('MEMPHIS-DEVICE-LINK-SECRET-V1');
// An access token lives 30 minutes; one closer than this to its end is
// exchanged first, so a call never carries a token that expires in flight.
const ACCESS_MARGIN_NS = 120n * 1_000_000_000n;
const LOCK_WAIT_MS = 60000;
const LOCK_STALE_MS = 120000;

const MemphisError = IDL.Variant({
  NotAuthenticated: IDL.Null,
  Unauthorized: IDL.Null,
  SessionExpired: IDL.Null,
  ChallengeExpired: IDL.Null,
  AnchorNotFound: IDL.Null,
  FactorNotFound: IDL.Null,
  InsufficientFactors: IDL.Null,
  DuplicateCredential: IDL.Null,
  InvalidArgument: IDL.Text,
  InvariantViolation: IDL.Record({ id: IDL.Text, details: IDL.Text }),
  RemovalDelayNotElapsed: IDL.Record({ effective_at_ns: IDL.Nat64 }),
});
const Res = (ok) => IDL.Variant({ Ok: ok, Err: MemphisError });
const Blob = IDL.Vec(IDL.Nat8);
const DeviceLinkStart = IDL.Record({ link_id: Blob, code: IDL.Text, expires_at_ns: IDL.Nat64 });
const DeviceLinkInfo = IDL.Record({ origin: IDL.Text, expires_at_ns: IDL.Nat64, approved: IDL.Bool, approve_challenge: Blob });
const DeviceLinkClaim = IDL.Record({
  session_token: Blob, expires_at_ns: IDL.Nat64,
  refresh_token: Blob, refresh_expires_at_ns: IDL.Nat64, refresh_absolute_expires_at_ns: IDL.Nat64,
  anchor_id: Blob, name: IDL.Opt(IDL.Text),
});
const ExchangeResult = IDL.Record({ session_token: Blob, expires_at_ns: IDL.Nat64, refresh_token: Blob, refresh_expires_at_ns: IDL.Nat64 });
const WhoAmIResult = IDL.Record({ anchor_id: Blob, session_expires_ns: IDL.Nat64, display_tag: IDL.Text });

const errName = (e) => Object.keys(e)[0];
const nowNs = () => BigInt(Date.now()) * 1_000_000n;

function decodeOne(type, bytes) {
  return IDL.decode([type], bytes)[0];
}

// ── The device link ─────────────────────────────────────────────────────────

/** Open a sign-in request. The returned object holds the secret: memory only. */
export async function beginDeviceLink() {
  const secret = crypto.randomBytes(32);
  const secretHash = crypto.createHash('sha256').update(Buffer.concat([LINK_SECRET_DOMAIN, secret])).digest();
  const { reply } = await call(MEMPHIS_CID, 'begin_device_link', IDL.encode([Blob, IDL.Text], [secretHash, ORIGIN]));
  const r = decodeOne(Res(DeviceLinkStart), reply);
  if (r.Err) throw linkRefusal(r.Err);
  const linkIdHex = toHex(r.Ok.link_id);
  return { linkIdHex, code: r.Ok.code, expiresAtNs: r.Ok.expires_at_ns, secret, approveUrl: `${CONNECT_URL}#link=${linkIdHex}` };
}

/** { origin, expiresAtNs, approved } or null when unknown or ended. */
export async function deviceLinkInfo(linkIdHex) {
  const r = decodeOne(IDL.Opt(DeviceLinkInfo), await query(MEMPHIS_CID, 'device_link_info', IDL.encode([Blob], [fromHex(linkIdHex)])));
  return r.length ? { origin: r[0].origin, expiresAtNs: r[0].expires_at_ns, approved: r[0].approved } : null;
}

/** The session, or null while the phone has not approved. One shot. */
export async function claimDeviceLink(link) {
  const { reply } = await call(MEMPHIS_CID, 'claim_device_link', IDL.encode([Blob, Blob], [fromHex(link.linkIdHex), link.secret]));
  const r = decodeOne(Res(DeviceLinkClaim), reply);
  if (r.Err) {
    if (errName(r.Err) === 'NotAuthenticated') return null;
    throw linkRefusal(r.Err);
  }
  const c = r.Ok;
  return {
    origin: ORIGIN,
    name: c.name.length ? c.name[0] : null,
    anchor_id_hex: toHex(c.anchor_id),
    access_token_hex: toHex(c.session_token),
    access_expires_at_ns: c.expires_at_ns.toString(),
    refresh_token_hex: toHex(c.refresh_token),
    refresh_expires_at_ns: c.refresh_expires_at_ns.toString(),
    refresh_absolute_expires_at_ns: c.refresh_absolute_expires_at_ns.toString(),
  };
}

function linkRefusal(err) {
  const n = errName(err);
  if (n === 'ChallengeExpired') return new Refusal('LINK_EXPIRED', 'This sign-in request has ended.', 'Call sign_in again and show the person the new link and code.');
  if (n === 'SessionExpired') return new Refusal('LINK_CANCELLED', 'The identity was signed out everywhere after the phone approved, so this sign-in was cancelled.', 'Call sign_in again.');
  if (n === 'Unauthorized') return new Refusal('LINK_REFUSED', 'Memphis refused this sign-in request.', 'Call sign_in again.');
  return new Refusal('LINK_REFUSED', `Memphis refused this step: ${n}${err[n] ? ' ' + JSON.stringify(err[n]) : ''}.`, 'Call sign_in again.');
}

// ── The stored session ──────────────────────────────────────────────────────

const dir = () => path.join(os.homedir(), '.thebes');
const sessionFile = () => path.join(dir(), 'memphis-session.json');
const lockFile = () => path.join(dir(), 'memphis-session.lock');

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
}

function readStored() {
  let raw;
  try {
    raw = fs.readFileSync(sessionFile(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const mode = fs.statSync(sessionFile()).mode & 0o777;
  if (mode & 0o077) {
    throw new Refusal('SESSION_FILE_OPEN', `${sessionFile()} can be read by other users (mode ${mode.toString(8)}).`, `Run \`chmod 600 ${sessionFile()}\`, or delete it and sign in again.`);
  }
  const s = JSON.parse(raw);
  return s.origin === ORIGIN ? s : null;
}

// Created 0600 before anything is written, then renamed over the old file, so
// the session never exists on disk readable by others or half-written.
function writeStored(s) {
  ensureDir();
  const tmp = `${sessionFile()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(s, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, sessionFile());
}

function removeStored() {
  fs.rmSync(sessionFile(), { force: true });
}

function lockHolderGone() {
  try {
    const st = fs.statSync(lockFile());
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(fs.readFileSync(lockFile(), 'utf8'));
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH' || e.code === 'ENOENT';
  }
}

async function withLock(fn) {
  ensureDir();
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile(), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockHolderGone()) { fs.rmSync(lockFile(), { force: true }); continue; }
      if (Date.now() - t0 > LOCK_WAIT_MS) {
        throw new Refusal('SESSION_BUSY', 'Another thebes-mcp process has held the sign-in lock for a minute.', `If no other one is running, delete ${lockFile()} and try again.`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile(), { force: true });
  }
}

export async function saveSession(s) {
  await withLock(async () => writeStored(s));
}

const NOT_SIGNED_IN = () => new Refusal('NOT_SIGNED_IN', 'The person is not signed in to thebesprotocol.com here.', 'Call sign_in, show the person the link and code, then call sign_in_status.');

async function exchange(refreshHex) {
  const { reply } = await call(MEMPHIS_CID, 'exchange_refresh', IDL.encode([Blob, IDL.Text], [fromHex(refreshHex), ORIGIN]));
  return decodeOne(Res(ExchangeResult), reply);
}

/** What sign_in_status shows: never a token. */
export function describe(s) {
  return s ? {
    signed_in: true,
    origin: s.origin,
    name: s.name,
    signed_in_until: new Date(Number(BigInt(s.refresh_expires_at_ns) / 1_000_000n)).toISOString(),
    latest_end: new Date(Number(BigInt(s.refresh_absolute_expires_at_ns) / 1_000_000n)).toISOString(),
  } : { signed_in: false };
}

export function storedSession() {
  const s = readStored();
  if (s && BigInt(s.refresh_expires_at_ns) <= nowNs()) return null;
  return s;
}

/** A usable access token (hex), exchanging the refresh token when the access
 *  token is near its end, or when the contract refused `refused` and no other
 *  process has replaced it since. */
export async function accessToken({ refused = null } = {}) {
  return withLock(async () => {
    const s = readStored();
    if (!s) throw NOT_SIGNED_IN();
    const fresh = BigInt(s.access_expires_at_ns) - ACCESS_MARGIN_NS > nowNs();
    if (fresh && (refused === null || s.access_token_hex !== refused)) return s.access_token_hex;
    if (BigInt(s.refresh_expires_at_ns) <= nowNs()) { removeStored(); throw NOT_SIGNED_IN(); }
    const r = await exchange(s.refresh_token_hex);
    if (r.Err) {
      // A dead chain: expired, revoked elsewhere, or presented twice.
      removeStored();
      throw NOT_SIGNED_IN();
    }
    // Both halves together: the presented refresh token is already dead.
    const next = { ...s, access_token_hex: toHex(r.Ok.session_token), access_expires_at_ns: r.Ok.expires_at_ns.toString(), refresh_token_hex: toHex(r.Ok.refresh_token), refresh_expires_at_ns: r.Ok.refresh_expires_at_ns.toString() };
    writeStored(next);
    return next.access_token_hex;
  });
}

/** Run `fn(tokenBytes)`; when the contract says the session did not verify,
 *  exchange once and run it again. */
export async function withSession(fn, isSessionRefusal) {
  const token = await accessToken();
  const first = await fn(fromHex(token));
  if (!isSessionRefusal(first)) return first;
  return fn(fromHex(await accessToken({ refused: token })));
}

export async function whoamiScoped(tokenHex, origin = ORIGIN) {
  const r = decodeOne(Res(WhoAmIResult), await query(MEMPHIS_CID, 'whoami_scoped', IDL.encode([Blob, IDL.Text], [fromHex(tokenHex), origin])));
  return r.Err ? { err: errName(r.Err) } : { anchor_id_hex: toHex(r.Ok.anchor_id), display_tag: r.Ok.display_tag };
}

/** End this sign-in on the chain, then forget it. Returns what happened. */
export async function signOut() {
  return withLock(async () => {
    const s = readStored();
    if (!s) return { signed_out: true, revoked_on_chain: false, note: 'There was no sign-in stored here.' };
    let revoked = false, verified = false;
    if (BigInt(s.refresh_expires_at_ns) > nowNs()) {
      const r = await exchange(s.refresh_token_hex);
      if (r.Ok) {
        // Presenting the spent token is the replay Memphis answers by revoking
        // the whole chain and every access token issued from it.
        await exchange(s.refresh_token_hex);
        revoked = true;
        const refused = async (hex) => (await whoamiScoped(hex)).err !== undefined;
        verified = (await refused(toHex(r.Ok.session_token))) && (await refused(s.access_token_hex));
      }
    }
    removeStored();
    return { signed_out: true, revoked_on_chain: revoked, access_refused_after: verified };
  });
}
