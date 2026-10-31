// A boundary, Memphis, a hosting contract and a payment service, in one local
// HTTP server, for testing the hosting tools without the chain. It speaks the
// boundary's wire format: signed /api/call (every signature is checked, over
// the payload egypt-state defines), /api/receipt, /api/query, /api/next_nonce.
// Memphis follows the contract's rules for device links and refresh chains,
// including revoking a whole chain when a spent refresh token comes back. It
// records every token, secret and pay token it mints, so a test can check that
// none of them ever appears in a tool's output.

import crypto from 'node:crypto';
import http from 'node:http';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';

export const ORIGIN = 'https://thebesprotocol.com';
const MEMPHIS = 921;
const MIN_NS = 60n * 1_000_000_000n;
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const hex = (b) => Buffer.from(b).toString('hex');
// A copy: Buffer.from(hex) can be a view into a shared pool, and Candid decodes
// from the underlying ArrayBuffer.
const bytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const sha = (b) => crypto.createHash('sha256').update(b).digest();

const MemphisError = IDL.Variant({
  NotAuthenticated: IDL.Null, Unauthorized: IDL.Null, SessionExpired: IDL.Null, ChallengeExpired: IDL.Null,
  AnchorNotFound: IDL.Null, FactorNotFound: IDL.Null, InsufficientFactors: IDL.Null, DuplicateCredential: IDL.Null,
  InvalidArgument: IDL.Text, InvariantViolation: IDL.Record({ id: IDL.Text, details: IDL.Text }),
  RemovalDelayNotElapsed: IDL.Record({ effective_at_ns: IDL.Nat64 }),
});
const MRes = (t) => IDL.Variant({ Ok: t, Err: MemphisError });
const Blob = IDL.Vec(IDL.Nat8);
const HRes = (t) => IDL.Variant({ ok: t, err: IDL.Text });
const Profile = IDL.Record({ owner: IDL.Principal, email: IDL.Text, occupation: IDL.Text, organisation: IDL.Text, isStudent: IDL.Bool, billingEmail: IDL.Text, phone: IDL.Text, taxId: IDL.Text, createdAt: IDL.Int, updatedAt: IDL.Int });
const Site = IDL.Record({ id: IDL.Nat, owner: IDL.Principal, clientId: IDL.Nat, name: IDL.Text, domain: IDL.Text, plan: IDL.Text, status: IDL.Text, cid: IDL.Nat, createdAt: IDL.Int, updatedAt: IDL.Int });
const Client = IDL.Record({ id: IDL.Nat, owner: IDL.Principal, name: IDL.Text, createdAt: IDL.Int });
const Counts = IDL.Record({ total: IDL.Nat, live: IDL.Nat, staging: IDL.Nat, requested: IDL.Nat });
const PanelNew = IDL.Record({ principal: IDL.Text, profile: IDL.Opt(Profile), clients: IDL.Vec(Client), sites: IDL.Vec(Site), counts: Counts, backends: IDL.Vec(IDL.Record({ siteId: IDL.Nat, cid: IDL.Nat })) });
const PanelOld = IDL.Record({ principal: IDL.Text, profile: IDL.Opt(Profile), clients: IDL.Vec(Client), sites: IDL.Vec(Site), counts: Counts });
const Order = IDL.Record({ id: IDL.Nat, owner: IDL.Principal, devPrincipal: IDL.Principal, siteId: IDL.Nat, siteName: IDL.Text, amount: IDL.Nat, currency: IDL.Text, credits: IDL.Nat, payTokenHash: IDL.Text, status: IDL.Text, createdAt: IDL.Int, paidAt: IDL.Int, paidFrom: IDL.Int, paidUntil: IDL.Int, txnId: IDL.Text, credit: IDL.Text, creditRef: IDL.Text });
const Billing = IDL.Record({ orders: IDL.Vec(Order), paid: IDL.Vec(IDL.Record({ siteId: IDL.Nat, paidUntil: IDL.Int })) });
const DeployTarget = IDL.Record({ siteId: IDL.Nat, pages: IDL.Nat, backend: IDL.Nat, paidUntil: IDL.Int });
const NOT_VERIFIED = 'Could not verify your Memphis session. Please sign in again.';

function payload(cid, method, arg, sender, nonce) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const lp = (b) => Buffer.concat([u32(b.length), b]);
  return Buffer.concat([Buffer.from('egypt-l1-ingress-v1'), Buffer.of(2), u64(cid), lp(Buffer.from(method)), lp(arg), lp(sender), u64(nonce)]);
}

export function verifySignature(body) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(body.sender, 'hex').toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, payload(body.canister_id, body.method, Buffer.from(body.arg, 'hex'), Buffer.from(body.sender, 'hex'), body.nonce), key, Buffer.from(body.signature, 'hex'));
  } catch {
    return false;
  }
}

export function fakeChain({ hostingCid, oldPanel = false, accessLifeNs = 30n * MIN_NS }) {
  const st = {
    links: new Map(), families: new Map(), access: new Map(), refresh: new Map(),
    sites: [], orders: [], profile: null, paidUntil: new Map(),
    secrets: new Set(), badSignatures: 0, calls: [], exchanges: 0, reuseRevocations: 0, executed: new Set(), receipts: new Map(),
    accessLifeNs, sessionsSeenByPayments: 0, linkLifeNs: 2n * MIN_NS, trialsOpen: false, trials: [],
  };
  const owner = Principal.fromText('aaaaa-aa');
  const dev = Principal.fromUint8Array(new Uint8Array(29).fill(9));
  const keep = (b) => { st.secrets.add(hex(b)); return b; };

  function mintAccess(familyId) {
    const t = keep(crypto.randomBytes(32));
    st.access.set(hex(t), { familyId, exp: nowNs() + st.accessLifeNs });
    return t;
  }
  function mintRefresh(familyId) {
    const t = keep(crypto.randomBytes(32));
    st.refresh.set(hex(t), { familyId, consumed: false, exp: nowNs() + 60n * MIN_NS });
    return t;
  }
  function revokeFamily(familyId) {
    st.families.delete(familyId);
    for (const [k, v] of st.refresh) if (v.familyId === familyId) st.refresh.delete(k);
    for (const [k, v] of st.access) if (v.familyId === familyId) st.access.delete(k);
  }
  const tokenOk = (t, origin = ORIGIN) => {
    const a = st.access.get(hex(t));
    return a && a.exp > nowNs() && st.families.get(a.familyId)?.origin === origin;
  };

  const memphisCalls = {
    begin_device_link([secretHash, origin]) {
      const id = crypto.randomBytes(32);
      const code = 'ACD34F';
      const exp = nowNs() + st.linkLifeNs;
      st.links.set(hex(id), { secretHash: hex(secretHash), origin, approved: false, exp });
      return [MRes(IDL.Record({ link_id: Blob, code: IDL.Text, expires_at_ns: IDL.Nat64 })), { Ok: { link_id: id, code, expires_at_ns: exp } }];
    },
    claim_device_link([linkId, secret]) {
      const T = MRes(IDL.Record({ session_token: Blob, expires_at_ns: IDL.Nat64, refresh_token: Blob, refresh_expires_at_ns: IDL.Nat64, refresh_absolute_expires_at_ns: IDL.Nat64, anchor_id: Blob, name: IDL.Opt(IDL.Text) }));
      st.secrets.add(hex(secret));
      const l = st.links.get(hex(linkId));
      if (!l || l.exp < nowNs()) return [T, { Err: { ChallengeExpired: null } }];
      if (hex(sha(Buffer.concat([Buffer.from('MEMPHIS-DEVICE-LINK-SECRET-V1'), Buffer.from(secret)]))) !== l.secretHash) return [T, { Err: { Unauthorized: null } }];
      if (!l.approved) return [T, { Err: { NotAuthenticated: null } }];
      st.links.delete(hex(linkId));
      const familyId = hex(crypto.randomBytes(8));
      st.families.set(familyId, { origin: l.origin });
      const a = mintAccess(familyId), r = mintRefresh(familyId);
      return [T, { Ok: { session_token: a, expires_at_ns: st.access.get(hex(a)).exp, refresh_token: r, refresh_expires_at_ns: nowNs() + 60n * MIN_NS, refresh_absolute_expires_at_ns: nowNs() + 600n * MIN_NS, anchor_id: new Uint8Array(32).fill(1), name: ['tester'] } }];
    },
    exchange_refresh([token, origin]) {
      const T = MRes(IDL.Record({ session_token: Blob, expires_at_ns: IDL.Nat64, refresh_token: Blob, refresh_expires_at_ns: IDL.Nat64 }));
      st.exchanges++;
      const rec = st.refresh.get(hex(token));
      if (!rec) return [T, { Err: { SessionExpired: null } }];
      if (rec.consumed) { st.reuseRevocations++; revokeFamily(rec.familyId); return [T, { Err: { Unauthorized: null } }]; }
      if (st.families.get(rec.familyId)?.origin !== origin) return [T, { Err: { Unauthorized: null } }];
      rec.consumed = true;
      const a = mintAccess(rec.familyId), r = mintRefresh(rec.familyId);
      return [T, { Ok: { session_token: a, expires_at_ns: st.access.get(hex(a)).exp, refresh_token: r, refresh_expires_at_ns: nowNs() + 60n * MIN_NS } }];
    },
  };
  const memphisQueries = {
    device_link_info([linkId]) {
      const T = IDL.Opt(IDL.Record({ origin: IDL.Text, expires_at_ns: IDL.Nat64, approved: IDL.Bool, approve_challenge: Blob }));
      const l = st.links.get(hex(linkId));
      return [T, l && l.exp > nowNs() ? [{ origin: l.origin, expires_at_ns: l.exp, approved: l.approved, approve_challenge: new Uint8Array(32) }] : []];
    },
    whoami_scoped([token, origin]) {
      const T = MRes(IDL.Record({ anchor_id: Blob, session_expires_ns: IDL.Nat64, display_tag: IDL.Text }));
      return [T, tokenOk(token, origin) ? { Ok: { anchor_id: new Uint8Array(32).fill(1), session_expires_ns: 0n, display_tag: '0101' } } : { Err: { Unauthorized: null } }];
    },
  };

  const site = (s) => ({ ...s, owner, clientId: 0n, createdAt: 1n, updatedAt: 1n });
  const order = (o) => ({ owner, devPrincipal: dev, amount: 100n, currency: 'EGP', credits: 0n, createdAt: 1n, paidAt: 0n, paidFrom: 0n, paidUntil: 0n, txnId: '', credit: 'nothing', creditRef: '', ...o });
  const profile = () => (st.profile ? [{ owner, occupation: '', isStudent: false, billingEmail: '', taxId: '', createdAt: 1n, updatedAt: 1n, ...st.profile }] : []);
  // [argument types after the session token, reply type, body]
  const hostingCalls = {
    mySites: [[], oldPanel ? PanelOld : PanelNew, () => ({ principal: owner.toText(), profile: profile(), clients: [], sites: st.sites.map(site), counts: { total: BigInt(st.sites.length), live: 0n, staging: 0n, requested: BigInt(st.sites.length) }, ...(oldPanel ? {} : { backends: [] }) })],
    myBilling: [[], Billing, () => ({ orders: st.orders.map(order), paid: st.sites.map((s) => ({ siteId: s.id, paidUntil: st.paidUntil.get(Number(s.id)) ?? 0n })) })],
    myProfile: [[], IDL.Opt(Profile), () => profile()],
    saveProfile: [[IDL.Text, IDL.Text, IDL.Text, IDL.Bool, IDL.Text, IDL.Text, IDL.Text], IDL.Bool, ([email, , organisation, , billingEmail, phone, taxId]) => {
      if (!email) return { err: 'Enter an email we can reach you on.' };
      st.profile = { email, organisation, billingEmail, phone, taxId };
      return true;
    }],
    addSite: [[IDL.Text, IDL.Text, IDL.Text, IDL.Nat], IDL.Nat, ([name, domain, plan]) => {
      if (plan !== 'monthly' && plan !== 'annual') return { err: 'Choose the monthly or the annual plan.' };
      const id = BigInt(st.sites.length + 1);
      st.sites.push({ id, name, domain, plan, status: 'requested', cid: 0n });
      return id;
    }],
    createOrder: [[IDL.Nat, IDL.Text], Order, ([siteId, payTokenHash]) => {
      const s = st.sites.find((x) => x.id === siteId);
      if (!s) return { err: 'That site is not yours, or does not exist.' };
      let o = st.orders.find((x) => x.siteId === siteId && x.status === 'pending');
      if (o) o.payTokenHash = payTokenHash;
      else { o = { id: BigInt(st.orders.length + 1), siteId, siteName: s.name, payTokenHash, status: 'pending' }; st.orders.push(o); }
      return order(o);
    }],
    myDeployAccount: [[], IDL.Principal, () => dev],
  };
  // FreeTrial.mo's rules, in its own words, on the builds that have the offer.
  const Trial = IDL.Record({ id: IDL.Nat, siteId: IDL.Nat, siteName: IDL.Text, owner: IDL.Principal, emailKey: IDL.Text, phoneKey: IDL.Text, at: IDL.Int, paidUntil: IDL.Int });
  if (!oldPanel) {
    hostingCalls.myTrial = [[], IDL.Record({ open: IDL.Bool, used: IDL.Opt(Trial) }), () => ({ open: st.trialsOpen, used: st.trials.slice(0, 1) })];
    hostingCalls.startTrial = [[IDL.Nat], Trial, ([siteId]) => {
      if (!st.trialsOpen) return { err: 'The free three months are not open at the moment.' };
      const s = st.sites.find((x) => x.id === siteId);
      if (!s) return { err: 'That site is not yours, or does not exist.' };
      if ((st.paidUntil.get(Number(siteId)) ?? 0n) !== 0n) return { err: 'This site has been paid for already. The free three months are for a site that has never been paid for.' };
      if (!st.profile?.email?.includes('@')) return { err: 'Add your email under Your details first, then start the free three months.' };
      if ((st.profile.phone || '').replace(/\D/g, '').length < 8) return { err: 'Add a phone number we can reach you on under Your details first, then start the free three months.' };
      if (st.trials.length) return { err: 'You have already used your free three months. Pay for a year to keep deploying.' };
      const at = nowNs(), until = at + 90n * 86400n * 1_000_000_000n;
      const t = { id: 1n, siteId, siteName: s.name, owner, emailKey: st.profile.email, phoneKey: st.profile.phone, at, paidUntil: until };
      st.trials.push(t);
      st.paidUntil.set(Number(siteId), until);
      return t;
    }];
  }

  const handlers = {
    call(cid, method, arg) {
      if (cid === MEMPHIS && memphisCalls[method]) {
        const [types] = [{ begin_device_link: [Blob, IDL.Text], claim_device_link: [Blob, Blob], exchange_refresh: [Blob, IDL.Text] }[method]];
        const [T, v] = memphisCalls[method](IDL.decode(types, arg));
        return IDL.encode([T], [v]);
      }
      if (cid === hostingCid && hostingCalls[method]) {
        const [argTypes, ret, fn] = hostingCalls[method];
        const [token, ...rest] = IDL.decode([Blob, ...argTypes], arg);
        if (!tokenOk(token)) return IDL.encode([HRes(ret)], [{ err: NOT_VERIFIED }]);
        const out = fn(rest);
        return IDL.encode([HRes(ret)], [out && typeof out === 'object' && 'err' in out && Object.keys(out).length === 1 ? out : { ok: out }]);
      }
      throw new Error(`method 'canister_update ${method}' not found in canister`);
    },
    query(cid, method, arg) {
      if (cid === MEMPHIS && memphisQueries[method]) {
        const types = { device_link_info: [Blob], whoami_scoped: [Blob, IDL.Text] }[method];
        const [T, v] = memphisQueries[method](IDL.decode(types, arg));
        return IDL.encode([T], [v]);
      }
      if (cid === hostingCid && method === 'price') return IDL.encode([IDL.Record({ amount: IDL.Nat, currency: IDL.Text, credits: IDL.Nat, termDays: IDL.Nat })], [{ amount: 100n, currency: 'EGP', credits: 0n, termDays: 365n }]);
      if (cid === hostingCid && method === 'deployTargetFor') {
        const [, siteId] = IDL.decode([IDL.Principal, IDL.Nat], arg);
        const until = st.paidUntil.get(Number(siteId)) ?? 0n;
        return IDL.encode([HRes(DeployTarget)], [until > nowNs() ? { ok: { siteId, pages: 0n, backend: 0n, paidUntil: until } } : { err: `Site ${siteId} is not paid for.` }]);
      }
      throw new Error(`no such query ${cid}.${method}`);
    },
  };

  const pay = {
    '/pay/start'(b) {
      st.secrets.add(String(b.payToken));
      const o = st.orders.find((x) => Number(x.id) === b.orderId);
      if (!o) return [404, { error: 'No such order.' }];
      if (hex(sha(String(b.payToken))) !== o.payTokenHash) return [403, { error: 'This payment link is no longer valid. Start again from your panel.' }];
      if (o.status !== 'pending') return [409, { error: 'This order is already paid.' }];
      if (!st.profile?.email || !st.profile?.phone) return [422, { error: 'Add your email and phone number under "Your details" first. We need both for your account and your receipts.' }];
      return [200, { checkoutUrl: `https://accept.paymob.com/unifiedcheckout/?publicKey=egy_pk_test&clientSecret=egy_csk_test_${o.id}` }];
    },
    '/pay/domains/list'(b) {
      st.sessionsSeenByPayments++;
      if (!/^[0-9a-f]{64}$/.test(b.session || '') || !tokenOk(Buffer.from(b.session, 'hex'))) return [401, { error: 'Please sign in again.' }];
      return [200, { domains: [] }];
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'POST' && url.pathname === '/api/call') {
        const b = JSON.parse(raw);
        st.calls.push({ cid: b.canister_id, method: b.method });
        if (!verifySignature(b) || b.nonce !== 0) { st.badSignatures++; return send(200, { error: 'signature does not verify' }); }
        const hash = hex(sha(raw));
        if (!st.receipts.has(hash)) {
          st.executed.add(b.sender);
          try { st.receipts.set(hash, { status: 'success', reply: hex(handlers.call(b.canister_id, b.method, bytes(b.arg))) }); }
          catch (e) { st.receipts.set(hash, { status: 'error', error: e.message }); }
        }
        return send(200, { message_hash: hash });
      }
      if (req.method === 'GET' && url.pathname === '/api/receipt') return send(200, st.receipts.get(url.searchParams.get('hash')) ?? { status: 'unknown' });
      if (req.method === 'GET' && url.pathname === '/api/next_nonce') return send(200, { next_nonce: st.executed.has(url.searchParams.get('sender')) ? 1 : 0 });
      if (req.method === 'POST' && url.pathname === '/api/query') {
        const b = JSON.parse(raw);
        try { return send(200, { status: 'success', reply: hex(handlers.query(b.canister_id, b.method, bytes(b.arg))) }); }
        catch (e) { return send(200, { status: 'error', error: e.message }); }
      }
      if (req.method === 'POST' && pay[url.pathname]) return send(...pay[url.pathname](JSON.parse(raw || '{}')));
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e.message });
    }
  });

  return {
    st,
    approve(linkIdHex) { st.links.get(linkIdHex).approved = true; },
    expireLink(linkIdHex) { st.links.delete(linkIdHex); },
    markPaid(siteId, untilNs) { st.paidUntil.set(siteId, untilNs); const o = st.orders.find((x) => Number(x.siteId) === siteId); if (o) { o.status = 'paid'; o.paidUntil = untilNs; o.paidAt = nowNs(); o.txnId = '560939821'; } },
    expireAccessTokens() { for (const v of st.access.values()) v.exp = 0n; },
    listen() { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))); },
    close() { return new Promise((r) => server.close(r)); },
  };
}
