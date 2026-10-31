# thebes-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent find a
starting point on Thebes, check a project, deploy it and use the result. It
answers questions about the examples and modules from the kit's `index.json`,
and builds, deploys and calls through `thebes-deploy`. It never takes a key as
input.

## Install

Requires Node 20 or later, `thebes-deploy` 0.1.13 or later on `PATH` (or
`THEBES_DEPLOY=<path>`), and, for Motoko projects, the Motoko compiler as `moc`.

Claude Code:

```sh
claude mcp add thebes -- npx -y thebes-mcp
```

Any client that reads an `mcpServers` file (Claude Desktop, Cursor and others):

```json
{ "mcpServers": { "thebes": { "command": "npx", "args": ["-y", "thebes-mcp"] } } }
```

From source instead:

```sh
git clone https://github.com/Mercatura-Forum/thebes-agent-kit
cd thebes-agent-kit/mcp && npm install
claude mcp add thebes -- node "$PWD/src/server.mjs"
```

## Tools

| Tool | Does | Changes anything |
|---|---|---|
| `find_examples` | lists example applications and starters, by words or capability | no |
| `get_example` | one example: contracts, every method with its signature, modules, live copy | no |
| `get_interface` | an example backend's Candid interface | no |
| `list_capabilities` | what the platform offers, its rules and docs | no |
| `get_lib_module` | a `thebes-lib` module's functions, or the module list and SDK exports | no |
| `scaffold_project` | `thebes-deploy new`: a new project with an upgrade-safe manifest | local files |
| `start_from_example` | copies an example as a new application: fresh contract ids, the public gateway, the upgrade-safe build | local files |
| `check_project` | manifest rules, toolchain, and a full build | local build output |
| `credits` | the credit balance behind metered deploys | no |
| `deploy` | deploys the project, metered (credits) or with your own key | the chain |
| `upgrade` | ships a new version of one contract and keeps its state | the chain |
| `query` | reads from any contract, by id or by project | no |
| `call` | sends an update call | the chain |
| `read_receipt` | the chain's receipt for a message, by its hash | no |

Thebes Hosting (thebesprotocol.com), for the person the agent works for:

| Tool | Does | Changes anything |
|---|---|---|
| `sign_in`, `sign_in_status` | signs the person in from their phone: a link, a QR and a six-symbol code; they approve with their passkey | a sign-in request |
| `sign_out` | revokes every token of the sign-in on the chain and deletes it here | the sign-in |
| `list_sites` | their sites, orders and contact details | no |
| `create_site` | adds a site on the yearly plan | the hosting contract |
| `start_trial` | starts the free three months on a site, while the offer is open | the hosting contract |
| `set_contact_details` | email and phone (needed to pay), organisation, billing email, tax number | the hosting contract |
| `create_payment_link` | opens the year's order and returns the card checkout link for the person | an order |
| `payment_status` | whether a site is paid, until when, and its orders | no |
| `redeploy_site` | deploys the project into a paid or trial site, free while it lasts | the chain |
| `connect_domain` | attaches, checks, lists or removes the person's own domain | the domain registry |

The usual path: `sign_in` → `create_site` → `start_trial` (when open and not
used) or `create_payment_link` → `redeploy_site` → `connect_domain`.

The sign-in is scoped to https://thebesprotocol.com and can do nothing
elsewhere. It is kept in `~/.thebes/memphis-session.json` (mode 600) and shared
by every thebes-mcp process of the user; no tool ever returns a token. Each
call to the chain is signed by a key made for that one message.

Resources: `thebes://guide` (AGENTS.md) and `thebes://index` (index.json).

## What the server refuses, and why

Every refusal carries a `code`, a sentence for the person, and the `fix`.

- `CHECK_FAILED`: the manifest breaks a platform rule (a Motoko build without
  `--legacy-persistence`, or validator addresses instead of the gateway).
  `deploy` and `upgrade` refuse until it is fixed.
- `NO_API_KEY`: metered deploys use the key the person stored with
  `thebes-deploy login`. The agent asks the person to do that in their own
  terminal and never asks for the key.
- `CONFIRM_SPEND`: a metered deploy spends credits; the agent asks first and
  calls again with `confirm_spend: true`.
- `UPGRADE_REFUSED`: the CLI refused an upgrade that would lose state. The
  server never passes `--allow-state-loss`.
- `CLI_TOO_OLD`, `CLI_MISSING`: install the latest `thebes-deploy`.
- `NOT_SIGNED_IN`, `LINK_EXPIRED`: call `sign_in` and show the person the new
  link and code.
- `CONTACT_MISSING`: ask the person for their email and phone and save them
  with `set_contact_details`.
- `ALREADY_PAID`: the site is paid; `renew: true` pays for the year after.
- `TRIAL_CLOSED`, `TRIAL_USED`, `TRIAL_UNAVAILABLE`: offer a paid year.
- `SITE_NOT_DEPLOYABLE`: the hosting contract would refuse the deploy (not
  paid, not theirs); nothing was sent.
- `SUBMITTED_BUT_LOST`, `RECEIPT_TIMEOUT`: read the state (or `read_receipt`)
  before trying again, so nothing is done twice.

## Tests

```sh
THEBES_DEPLOY=/path/to/thebes-deploy npm test
npm run pack:check
```

The tests drive the server over stdio as a client does. The hosting tools are
tested against `test/fake-chain.mjs`, a local boundary that checks every
signature and keeps Memphis's refresh rules. `node test/live/sign-in.mjs` signs
in on the real chain with a virtual passkey on the live connect page (Python
Playwright), reads the live hosting contract without writing, and signs out. They read live
contracts and build projects locally; none deploys or spends credits. The
tests that run `thebes-deploy` need 0.1.13 or later, and the build test needs
the Motoko compiler as `moc`; with an older CLI or another `moc` each of them
fails with one line saying which tool to change.

`pack:check` packs the package, installs it into an empty folder, starts the
installed `thebes-mcp` over stdio, lists its tools and reads its resources. The
package carries the kit's `index.json`, `AGENTS.md` and interfaces under
`data/`, copied from the repository root when it is packed and checked equal
to it.
