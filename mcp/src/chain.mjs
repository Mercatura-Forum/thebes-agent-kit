// Signed calls and queries through the public boundary, made the way the SDK's
// passkey.js makes them (V150, INV-SENDER-AUTH). Every update is signed by an
// Ed25519 key made for that one message: the sender is its public key and
// nonce 0 its first and only nonce, so two thebes-mcp processes never race on
// a shared nonce, and no long-lived key sits on disk. Contracts here
// authenticate the person by the session token in the argument, never by the
// caller. A resubmission sends the same signed message, so the chain's replay
// check sees it as the same call.

import crypto from 'node:crypto';
import { Refusal } from './cli.mjs';

export const BOUNDARY = process.env.THEBES_BOUNDARY || 'https://memphis.mercaturaforum.com';

// passkey.js: SUBMIT_WAITS_MS, RECEIPT_BUDGET_MS.
const SUBMIT_WAITS_MS = [1000, 2000, 4000, 8000, 12000];
const RECEIPT_BUDGET_MS = 90000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toHex = (u8) => Buffer.from(u8).toString('hex');
export const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
function u64be(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }
const lenPrefixed = (b) => Buffer.concat([u32be(b.length), Buffer.from(b)]);

// egypt-state message.rs IngressMessage::signing_payload() for a Call (tag 0x02).
export function callSigningPayload(canisterId, method, argBytes, senderBytes, nonce) {
  return Buffer.concat([Buffer.from('egypt-l1-ingress-v1'), Buffer.of(0x02), u64be(canisterId),
    lenPrefixed(Buffer.from(method)), lenPrefixed(argBytes), lenPrefixed(senderBytes), u64be(nonce)]);
}

// { senderHex, signatureHex } for one Call, signed by a new key. `privateKey`
// is for tests that need a known signer; callers leave it out.
export function signCall(canisterId, method, argBytes, privateKey) {
  const key = privateKey ?? crypto.generateKeyPairSync('ed25519').privateKey;
  const pub = Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url');
  const sig = crypto.sign(null, callSigningPayload(canisterId, method, argBytes, pub, 0), key);
  return { senderHex: toHex(pub), signatureHex: toHex(sig) };
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function query(canisterId, method, argBytes) {
  let r;
  try {
    r = await getJson(`${BOUNDARY}/api/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canister_id: canisterId, method, arg: toHex(argBytes) }),
    });
  } catch (e) {
    throw new Refusal('NETWORK', `Could not reach ${BOUNDARY}: ${e.message}.`, 'Check the internet connection and try again.');
  }
  if (r.body.status !== 'success' || !r.body.reply) {
    throw new Refusal('CHAIN_ERROR', `${method} on ${canisterId}: ${r.body.error || r.body.status || 'HTTP ' + r.status}.`, 'Try again; if it repeats, report it to the Thebes team.');
  }
  return fromHex(r.body.reply);
}

// Whether a sender's one message has executed: every call here uses a fresh
// sender with nonce 0, so next_nonce > 0 means "already ran".
async function senderExecuted(senderHex) {
  try {
    return Number((await getJson(`${BOUNDARY}/api/next_nonce?sender=${senderHex}`)).body.next_nonce) > 0;
  } catch {
    return false;
  }
}

async function submitOnce(canisterId, method, argHex, signed) {
  let r;
  try {
    r = await getJson(`${BOUNDARY}/api/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canister_id: canisterId, method, arg: argHex, sender: signed.senderHex, nonce: 0, signature: signed.signatureHex }),
    });
  } catch (e) {
    return { refused: `network: ${e.message}` };
  }
  const err = typeof r.body.error === 'string' ? r.body.error : '';
  if (r.status === 429 || r.status === 502 || r.status === 503 || /backpressure/i.test(err)) return { refused: err || `HTTP ${r.status}` };
  if (err) throw new Refusal('CHAIN_ERROR', `${method}: ${err}.`, 'Check the arguments; if they are right, report it to the Thebes team.');
  if (!r.body.message_hash) throw new Refusal('CHAIN_ERROR', `${method}: the boundary returned no message hash.`, 'Try again.');
  return { hash: r.body.message_hash };
}

async function pollReceipt(method, hash, budgetMs) {
  const t0 = Date.now();
  let wait = 150;
  while (Date.now() - t0 < budgetMs) {
    await sleep(wait);
    wait = Math.min(2000, Math.round(wait * 1.5));
    let rec = null;
    try {
      rec = (await getJson(`${BOUNDARY}/api/receipt?hash=${hash}`)).body;
    } catch {
      rec = null;
    }
    // A failed poll, or a node that has not seen the message, says nothing.
    if (rec?.status === 'success' && rec.reply) return fromHex(rec.reply);
    if (rec?.status === 'error') {
      const detail = rec.error || 'unknown';
      if (/replay: nonce/i.test(detail)) {
        throw new Refusal('SUBMITTED_BUT_LOST', `The chain ran ${method} but its reply could not be collected (message ${hash}).`, 'Read the current state before trying again, so the change is not made twice.');
      }
      throw new Refusal('CHAIN_ERROR', `${method} failed on the chain: ${detail}.`, 'Check the arguments; if they are right, report it to the Thebes team.');
    }
  }
  return null;
}

// Signed update call. Returns { reply, messageHash }.
export async function call(canisterId, method, argBytes) {
  const argHex = toHex(argBytes);
  const signed = signCall(canisterId, method, argBytes);
  let hash = null, lastRefusal = null;
  for (let attempt = 0; ; attempt++) {
    const r = await submitOnce(canisterId, method, argHex, signed);
    if (r.hash) { hash = r.hash; break; }
    lastRefusal = r.refused;
    // A refusal can arrive after a node took the message: never send it twice.
    if (await senderExecuted(signed.senderHex)) {
      throw new Refusal('SUBMITTED_BUT_LOST', `The chain ran ${method} but its reply was lost.`, 'Read the current state before trying again, so the change is not made twice.');
    }
    if (attempt >= SUBMIT_WAITS_MS.length) {
      throw new Refusal('NETWORK_BUSY', `The network did not take ${method} (${lastRefusal}). Nothing was changed.`, 'Try again in a minute.');
    }
    await sleep(SUBMIT_WAITS_MS[attempt]);
  }
  const reply = await pollReceipt(method, hash, RECEIPT_BUDGET_MS);
  if (reply) return { reply, messageHash: hash };
  throw new Refusal('RECEIPT_TIMEOUT', `The chain has not confirmed ${method} within ${RECEIPT_BUDGET_MS / 1000} s (message ${hash}).`, `Nothing is lost: read_receipt with message_hash ${hash} collects the result once it runs.`);
}

// The receipt of any message, by hash: what read_receipt returns.
export async function receipt(hash) {
  let r;
  try {
    r = await getJson(`${BOUNDARY}/api/receipt?hash=${hash}`);
  } catch (e) {
    throw new Refusal('NETWORK', `Could not reach ${BOUNDARY}: ${e.message}.`, 'Check the internet connection and try again.');
  }
  return r.body;
}
