// Thebes Hosting: the hosting contract and the payment service behind
// thebesprotocol.com/pay/. Every contract method that knows who you are takes
// the thebesprotocol.com access token as its first argument and is an update
// call (the contract asks Memphis to verify it), signed per message like every
// other call here. The token goes to the contract and to the payment service on
// the same origin it was issued for, the way the panel sends it, and is never
// returned by a tool.
//
// THEBES_HOSTING_CID and THEBES_PAYMENTS point the tools at a test copy of the
// contract and its own payment service.

import crypto from 'node:crypto';
import { IDL } from '@dfinity/candid';
import { call, query } from './chain.mjs';
import { Refusal } from './cli.mjs';
import { withSession } from './memphis.mjs';

export const HOSTING_CID = Number(process.env.THEBES_HOSTING_CID || 102395502461472);
export const PAYMENTS = (process.env.THEBES_PAYMENTS || 'https://thebesprotocol.com').replace(/\/$/, '');

const Blob = IDL.Vec(IDL.Nat8);
const Result = (ok) => IDL.Variant({ ok, err: IDL.Text });
const Profile = IDL.Record({
  owner: IDL.Principal, email: IDL.Text, occupation: IDL.Text, organisation: IDL.Text, isStudent: IDL.Bool,
  billingEmail: IDL.Text, phone: IDL.Text, taxId: IDL.Text, createdAt: IDL.Int, updatedAt: IDL.Int,
});
const Site = IDL.Record({
  id: IDL.Nat, owner: IDL.Principal, clientId: IDL.Nat, name: IDL.Text, domain: IDL.Text, plan: IDL.Text,
  status: IDL.Text, cid: IDL.Nat, createdAt: IDL.Int, updatedAt: IDL.Int,
});
const ClientAccount = IDL.Record({ id: IDL.Nat, owner: IDL.Principal, name: IDL.Text, createdAt: IDL.Int });
const SiteBackend = IDL.Record({ siteId: IDL.Nat, cid: IDL.Nat });
const PanelView = IDL.Record({
  principal: IDL.Text, profile: IDL.Opt(Profile), clients: IDL.Vec(ClientAccount), sites: IDL.Vec(Site),
  counts: IDL.Record({ total: IDL.Nat, live: IDL.Nat, staging: IDL.Nat, requested: IDL.Nat }),
  // Added with self-deploy (27 Oct); opt so a build before it decodes too.
  backends: IDL.Opt(IDL.Vec(SiteBackend)),
});
const Order = IDL.Record({
  id: IDL.Nat, owner: IDL.Principal, devPrincipal: IDL.Principal, siteId: IDL.Nat, siteName: IDL.Text,
  amount: IDL.Nat, currency: IDL.Text, credits: IDL.Nat, payTokenHash: IDL.Text, status: IDL.Text,
  createdAt: IDL.Int, paidAt: IDL.Int, paidFrom: IDL.Int, paidUntil: IDL.Int, txnId: IDL.Text,
  credit: IDL.Text, creditRef: IDL.Text,
});
const Billing = IDL.Record({ orders: IDL.Vec(Order), paid: IDL.Vec(IDL.Record({ siteId: IDL.Nat, paidUntil: IDL.Int })) });
const Price = IDL.Record({ amount: IDL.Nat, currency: IDL.Text, credits: IDL.Nat, termDays: IDL.Nat });
const DeployTarget = IDL.Record({ siteId: IDL.Nat, pages: IDL.Nat, backend: IDL.Nat, paidUntil: IDL.Int });

// The contract's own words when the token did not verify (callerPrincipal).
const SESSION_REFUSED = /Could not verify your Memphis session/;
const isSessionRefusal = (r) => r && typeof r.err === 'string' && SESSION_REFUSED.test(r.err);

async function sessionCall(method, argTypes, args, retType) {
  const r = await withSession(async (token) => {
    const { reply, messageHash } = await call(HOSTING_CID, method, IDL.encode([Blob, ...argTypes], [token, ...args]));
    return { ...IDL.decode([Result(retType)], reply)[0], messageHash };
  }, isSessionRefusal);
  if ('err' in r) {
    if (isSessionRefusal(r)) throw new Refusal('NOT_SIGNED_IN', 'The hosting contract did not accept this sign-in.', 'Call sign_in again.');
    throw new Refusal('HOSTING_REFUSED', r.err, 'Do what the message says, then try again.');
  }
  return { value: r.ok, messageHash: r.messageHash };
}

const n = (x) => Number(x);
// Contract times are nanoseconds on a clock that keeps real time.
const iso = (ns) => (BigInt(ns) > 0n ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : null);
const money = (piastres, currency) => `${(Number(piastres) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${currency}`;

function plainSite(s, paidUntil, backends) {
  return {
    id: n(s.id), name: s.name, domain: s.domain || null, plan: s.plan, status: s.status,
    pages_cid: n(s.cid) || null, backend_cid: backends.get(n(s.id)) ?? null,
    paid_until: paidUntil.has(n(s.id)) ? iso(paidUntil.get(n(s.id))) : null,
    url: n(s.cid) ? `https://memphis.mercaturaforum.com/_/raw/${n(s.cid)}/index.html` : null,
  };
}

function plainOrder(o) {
  return {
    id: n(o.id), site_id: n(o.siteId), site_name: o.siteName, amount: money(o.amount, o.currency),
    status: o.status, created_at: iso(o.createdAt), paid_at: iso(o.paidAt),
    paid_from: iso(o.paidFrom), paid_until: iso(o.paidUntil), transaction_id: o.txnId || null,
    deploy_account: o.devPrincipal.toText(),
  };
}

export async function price() {
  const p = IDL.decode([Price], await query(HOSTING_CID, 'price', IDL.encode([], [])))[0];
  return { amount: money(p.amount, p.currency), amount_minor: n(p.amount), currency: p.currency, term_days: n(p.termDays), credits: n(p.credits) };
}

export async function panel() {
  const [{ value: v }, { value: b }] = [await sessionCall('mySites', [], [], PanelView), await sessionCall('myBilling', [], [], Billing)];
  const paidUntil = new Map(b.paid.filter((p) => BigInt(p.paidUntil) > 0n).map((p) => [n(p.siteId), p.paidUntil]));
  const backends = new Map((v.backends[0] ?? []).map((x) => [n(x.siteId), n(x.cid)]));
  const prof = v.profile[0];
  return {
    hosting_contract: HOSTING_CID,
    principal: v.principal,
    contact: prof ? { email: prof.email, phone: prof.phone, organisation: prof.organisation, billing_email: prof.billingEmail || null, tax_id: prof.taxId || null } : null,
    sites: v.sites.map((s) => plainSite(s, paidUntil, backends)),
    orders: b.orders.map(plainOrder),
  };
}

export async function addSite({ name, domain = '', plan = 'annual' }) {
  const { value, messageHash } = await sessionCall('addSite', [IDL.Text, IDL.Text, IDL.Text, IDL.Nat], [name, domain, plan, 0n], IDL.Nat);
  return { site_id: n(value), message_hash: messageHash };
}

/** Save contact details, keeping every field the person did not pass. */
export async function setContact({ email, phone, organisation, billing_email, tax_id }) {
  const { value: cur } = await sessionCall('myProfile', [], [], IDL.Opt(Profile));
  const p = cur[0] ?? { email: '', occupation: '', organisation: '', isStudent: false, billingEmail: '', phone: '', taxId: '' };
  const next = {
    email: email ?? p.email, occupation: p.occupation, organisation: organisation ?? p.organisation, isStudent: p.isStudent,
    billingEmail: billing_email ?? p.billingEmail, phone: phone ?? p.phone, taxId: tax_id ?? p.taxId,
  };
  const { messageHash } = await sessionCall('saveProfile', [IDL.Text, IDL.Text, IDL.Text, IDL.Bool, IDL.Text, IDL.Text, IDL.Text],
    [next.email, next.occupation, next.organisation, next.isStudent, next.billingEmail, next.phone, next.taxId], IDL.Bool);
  return { email: next.email, phone: next.phone, organisation: next.organisation, billing_email: next.billingEmail || null, tax_id: next.taxId || null, message_hash: messageHash };
}

/** Open (or reopen) the year's order for a site and a checkout for it. The pay
 *  token is random, made here and spent here: only its hash goes on chain, and
 *  a new link makes any earlier one for the same order stop working. */
export async function paymentLink(siteId, { renew = false } = {}) {
  // A paid site takes a new order too: it pays for the year after.
  const { value: billing } = await sessionCall('myBilling', [], [], Billing);
  const paid = billing.paid.find((p) => n(p.siteId) === siteId);
  if (paid && BigInt(paid.paidUntil) > BigInt(Date.now()) * 1_000_000n && !renew) {
    throw new Refusal('ALREADY_PAID', `Site ${siteId} is paid until ${iso(paid.paidUntil)}.`, 'If the person wants to pay for the year after that now, call create_payment_link again with renew: true.');
  }
  const payToken = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(payToken).digest('hex');
  const { value: o } = await sessionCall('createOrder', [IDL.Nat, IDL.Text], [BigInt(siteId), hash], Order);
  let res, body;
  try {
    res = await fetch(`${PAYMENTS}/pay/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: n(o.id), payToken }) });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    throw new Refusal('PAYMENTS_UNREACHABLE', `Could not reach the payment service at ${PAYMENTS}: ${e.message}.`, 'Try again in a minute.');
  }
  if (res.status === 422) throw new Refusal('CONTACT_MISSING', body.error || 'Email and phone are needed first.', 'Ask the person for their email and phone number and save them with set_contact_details, then call create_payment_link again.');
  if (res.status === 409) throw new Refusal('ALREADY_PAID', body.error || 'This order is already paid.', 'Call payment_status to see until when the site is paid.');
  if (res.status === 503) throw new Refusal('PAYMENTS_OFF', body.error || 'Payments are not switched on.', 'Try again later, or contact the Thebes team.');
  if (!res.ok || !body.checkoutUrl) throw new Refusal('PAYMENT_START_FAILED', body.error || `The payment service answered HTTP ${res.status}.`, 'Try again; if it repeats, contact the Thebes team.');
  return { order_id: n(o.id), site_id: n(o.siteId), site_name: o.siteName, amount: money(o.amount, o.currency), checkout_url: body.checkoutUrl };
}

export async function paymentStatus(siteId) {
  const { value: b } = await sessionCall('myBilling', [], [], Billing);
  const paid = b.paid.find((p) => n(p.siteId) === siteId);
  if (!paid) throw new Refusal('UNKNOWN_SITE', `Site ${siteId} is not one of this person's sites.`, 'Call list_sites to see their sites.');
  const orders = b.orders.filter((o) => n(o.siteId) === siteId).map(plainOrder);
  const until = BigInt(paid.paidUntil);
  return { site_id: siteId, paid: until > BigInt(Date.now()) * 1_000_000n, paid_until: iso(until), orders };
}

export async function deployAccount() {
  return (await sessionCall('myDeployAccount', [], [], IDL.Principal)).value;
}

/** What the gateway will answer for a deploy into this site, read before it. */
export async function deployTarget(devPrincipal, siteId) {
  const r = IDL.decode([Result(DeployTarget)], await query(HOSTING_CID, 'deployTargetFor', IDL.encode([IDL.Principal, IDL.Nat], [devPrincipal, BigInt(siteId)])))[0];
  if ('err' in r) throw new Refusal('SITE_NOT_DEPLOYABLE', r.err, 'Do what the message says; payment_status shows whether the year is paid.');
  return { site_id: n(r.ok.siteId), pages_cid: n(r.ok.pages) || null, backend_cid: n(r.ok.backend) || null, paid_until: iso(r.ok.paidUntil) };
}

/** /pay/domains/{list,attach,check,remove}, with the session the way the panel sends it. */
export async function domains(action, { siteId, domain }) {
  const run = async (token) => {
    const res = await fetch(`${PAYMENTS}/pay/domains/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: Buffer.from(token).toString('hex'), siteId, domain }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  let r;
  try {
    r = await withSession(run, (x) => x.status === 401);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal('PAYMENTS_UNREACHABLE', `Could not reach ${PAYMENTS}: ${e.message}.`, 'Try again in a minute.');
  }
  if (r.status === 200) return r.body;
  const codes = { 400: 'BAD_DOMAIN', 401: 'NOT_SIGNED_IN', 402: 'SITE_NOT_PAID', 404: 'UNKNOWN_DOMAIN_OR_SITE', 409: 'DOMAIN_REFUSED', 503: 'DOMAINS_OFF' };
  const fixes = {
    402: 'Pay for the site first: create_payment_link.',
    409: 'Deploy the site first (redeploy_site), or follow the message.',
    401: 'Call sign_in again.',
  };
  throw new Refusal(codes[r.status] ?? 'DOMAINS_FAILED', r.body.error || `HTTP ${r.status}`, fixes[r.status] ?? 'Follow the message, then try again.');
}

// ── The free three months (FreeTrial.mo) ────────────────────────────────────

const Trial = IDL.Record({
  id: IDL.Nat, siteId: IDL.Nat, siteName: IDL.Text, owner: IDL.Principal,
  emailKey: IDL.Text, phoneKey: IDL.Text, at: IDL.Int, paidUntil: IDL.Int,
});
const TrialView = IDL.Record({ open: IDL.Bool, used: IDL.Opt(Trial) });

// FreeTrial.refusal's sentences, each with the code and fix an agent acts on.
const TRIAL_REFUSALS = [
  [/not open at the moment/, 'TRIAL_CLOSED', 'The free three months are switched off by the Thebes team right now. Offer the person a paid year instead: create_payment_link.'],
  [/not yours, or does not exist/, 'UNKNOWN_SITE', 'Call list_sites and pass one of the person\'s site ids.'],
  [/partner rate/, 'PARTNER_SITE', 'This site is invoiced directly by the Thebes team; nothing to start here.'],
  [/paid for already/, 'ALREADY_PAID', 'The free three months are for a site that has never been paid; this one can be deployed with redeploy_site while its year lasts.'],
  [/Add your email|Add a phone number/, 'CONTACT_MISSING', 'Ask the person for their email and phone number, save them with set_contact_details, then call start_trial again.'],
  [/already used your free three months|already been used with this email or phone/, 'TRIAL_USED', 'The offer is once per person. Offer a paid year instead: create_payment_link.'],
];

function trialRefusal(message) {
  const hit = TRIAL_REFUSALS.find(([re]) => re.test(message));
  return hit ? new Refusal(hit[1], message, hit[2]) : new Refusal('HOSTING_REFUSED', message, 'Do what the message says, then try again.');
}

const plainTrial = (t) => ({ site_id: n(t.siteId), site_name: t.siteName, started_at: iso(t.at), free_until: iso(t.paidUntil) });

// A hosting contract built before the offer (the test copy) has no trial methods.
async function trialCall(method, argTypes, args, retType) {
  try {
    return await sessionCall(method, argTypes, args, retType);
  } catch (e) {
    if (e instanceof Refusal && e.code === 'CHAIN_ERROR' && /not found/i.test(e.message)) {
      throw new Refusal('TRIAL_UNAVAILABLE', `Hosting contract ${HOSTING_CID} has no free-three-months offer.`, 'Offer the person a paid year instead: create_payment_link.');
    }
    if (e instanceof Refusal && e.code === 'HOSTING_REFUSED') throw trialRefusal(e.message);
    throw e;
  }
}

/** Start the free three months on a site, after reading whether the offer is
 *  open and unused, so a closed offer is said plainly before anything is sent. */
export async function startTrial(siteId) {
  const { value: v } = await trialCall('myTrial', [], [], TrialView);
  if (!v.open) throw trialRefusal('The free three months are not open at the moment.');
  if (v.used.length) {
    const t = plainTrial(v.used[0]);
    throw new Refusal('TRIAL_USED', `The person already used their free three months on site ${t.site_id} ("${t.site_name}"), free until ${t.free_until}.`, TRIAL_REFUSALS.at(-1)[2]);
  }
  const { value: t, messageHash } = await trialCall('startTrial', [IDL.Nat], [BigInt(siteId)], Trial);
  return { ...plainTrial(t), message_hash: messageHash };
}
