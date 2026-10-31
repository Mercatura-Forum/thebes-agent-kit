# AGENTS.md — building on Thebes

This repository is the starting point for an AI agent that builds, deploys and
runs applications on Thebes. Read this file first, then `index.json`.

## What Thebes is

Thebes is a Layer 1 chain where an application is a set of smart contracts. A
backend contract is written in Motoko or Rust and keeps its state on the chain;
the frontend is a web contract that serves the pages and assets. People sign in
with a passkey through Memphis, the identity contract. There is no server and no
database to run.

## How to use this repository

| File | What it gives you |
|---|---|
| `index.json` | Every example application, every module and every CLI command, with exact method signatures. Generated from the repositories at pinned commits. |
| `interfaces/<example>/<contract>.did` | The Candid interface of each example backend, produced by the Motoko compiler. |
| `catalog/platform.json` | The platform capabilities and where each is documented. |
| `llms.txt` | The same map as a short list of links. |

`index.json` in brief:

- `examples[]`: `id`, `shows` (what the app does), `guard` (the correctness rule it
  enforces), `live` (a running copy), `repo` + `ref`, `contracts[]` (each with `cid`,
  `methods[]` of `{name, kind, signature, doc}`), and `uses` (the `thebes-lib`
  modules, `@thebes/sdk` exports and platform calls it relies on).
- `capabilities[]`: what the platform offers, the rules that apply, the docs, and
  `used_by` (examples that use it).
- `starters[]`: small single-contract examples in Motoko and Rust.
- `lib`, `sdk`: the shared backend library and frontend SDK, with every public
  function and export.
- `cli.commands[]`: every `thebes-deploy` command.

## Pick a starting point

| You are building | Start from | Add |
|---|---|---|
| a shop with a catalogue and orders | `store` | `invoices` |
| reservations, slots, deposits | `booking` | |
| a community or chat | `chat` | |
| invoices and payments received | `invoicing` | |
| points and rewards | `loyalty` | |
| a sales pipeline | `crm` | |
| a personal or team ledger | `finance` | |
| orders for a restaurant or kitchen | `restaurant` | `invoices` |
| courses, enrolment, transcripts | `university` | |
| a game that needs a fair shuffle | `cards` | `randomness` |
| records with images and access control | `xray` | `media` |
| ISO 20022 payment messages | `open-banking-iso20022` | |
| a token | starter `icrc-me` | |
| data fetched from a website or API | starter `price-oracle` | `http-outcalls` |
| something else | starter `counter` or `kv-store` | the capabilities you need |

Each example repository has its own `AGENTS.md` (linked as `agents_md` in the
index) with its layout and conventions. Copy an example; do not edit the
vendored toolkit inside it.

## The workflow

```sh
# 1. Install the CLI (check the version before anything else)
curl -L https://github.com/Mercatura-Forum/Thebes-Protocol-/releases/download/v0.1.13-thebes-deploy/install-thebes-deploy.sh | bash
thebes-deploy --version        # 0.1.13 or later
thebes-deploy setup            # checks moc, mops, cargo, node

# 2. Start a project
thebes-deploy new my-app       # backend + optional frontend + manifest
thebes-deploy add auth         # passkey sign-in, when the app needs it

# 3. Build and deploy, one of:
thebes-deploy identity new me && thebes-deploy deploy        # you sign the install
thebes-deploy credits && thebes-deploy deploy --metered       # charged to credits (after login, below)

# 4. Use it
thebes-deploy query my-app <method>
thebes-deploy call  my-app <method> --arg '(...)'

# 5. Ship a new version and keep the data
thebes-deploy upgrade my-app
```

Every new developer account starts with free credits, enough for a few deploys,
so a first application can be deployed with `--metered` without paying.
`thebes-deploy credits` shows the balance.

**Getting an API key** for `--metered`: the person signs in to the Thebes IDE
with a passkey and generates a key (it begins `tbk_`), then runs
`thebes-deploy login --api-key <key>` once in their own terminal. The CLI stores
it in `~/.thebes/credentials.toml` and every later command reads it from there.
Ask the person to do this step; do not ask them to paste the key into the
conversation.

## Rules

1. **Build Motoko with `moc --legacy-persistence`.** Declare `source` in
   `thebes.toml` and let `thebes-deploy` build it. A custom `build` command must
   pass `--legacy-persistence`, or the contract cannot be upgraded in place later.
2. **Keys stay out of the project and out of the conversation.** The API key lives
   in `~/.thebes/credentials.toml` and a signing key in its key file. Never commit
   either, print either, or pass a signing key's seed as a command argument.
3. **Never put a secret in an HTTP outcall** (URL, headers or body). Call an
   authenticated API through your own service.
4. **Return lists, not options.** The boundary decodes a `vec record` of scalars:
   return one record as a 0-or-1-element array, and a single scalar as
   `[{ field = value }]`.
5. **Principals are hex** everywhere in the SDK.
6. **Call the `*OrTrap` form** of a guarded method from a frontend, so a refusal
   arrives as an error and not as a successful reply carrying `#err`.
7. **Confirm a write before reading it back.** Use the update's own reply, or
   repeat the query until it shows the write.
8. **Check before you deploy.** Run `thebes-deploy build` and read the result
   before `deploy`; a deploy spends credits.

## Regenerating the index

```sh
node tools/build-index.mjs           # after bumping a ref in sources.json
node tools/build-index.mjs --check   # CI: fails if the committed index is stale
```

Needs `git`, `mops` and `moc` 1.4.1.
