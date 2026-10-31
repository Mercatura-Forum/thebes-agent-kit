// thebes.toml reading and the platform rules a manifest must keep. Shared by the
// MCP server (check_project, deploy) and tools/build-index.mjs (the index's
// `findings`), so an example and a project are judged by the same rules.

// The network block `thebes-deploy new` writes: the public gateway, no addresses.
export const NETWORK_BLOCK = `[networks.thebes]
gateway = "https://memphis.mercaturaforum.com"
routing = "smart"`;

// The subset of TOML a thebes.toml uses: [section] and [a.b] headers, key = value
// with strings, numbers, booleans and arrays of strings.
export function parseToml(text) {
  const out = {};
  let cur = out;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      cur = out;
      for (const k of sec[1].split('.')) cur = cur[k] ??= {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2];
    if (v.startsWith('[') && !v.includes(']')) {
      while (++i < lines.length && !lines[i].includes(']')) v += lines[i].trim();
      v += lines[i]?.trim() ?? '';
    }
    cur[kv[1]] = tomlValue(v);
  }
  return out;
}

function tomlValue(v) {
  v = v.replace(/\s+#.*$/, '').trim();
  if (v.startsWith('"')) return JSON.parse(v.slice(0, v.lastIndexOf('"') + 1));
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
  if (v.startsWith('[')) return [...v.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

// Rewrites for a COPY of an example that will be deployed as a new application
// (fresh contracts, so no live persistence mode to respect).

// Every [networks.*] section is replaced by NETWORK_BLOCK and default_network
// points at it.
export function useGatewayNetwork(raw) {
  const lines = raw.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header) skipping = header[1].startsWith('networks.');
    if (!skipping) out.push(line);
  }
  let text = out.join('\n').replace(/^(\s*default_network\s*=\s*).*$/m, '$1"thebes"');
  const firstCanister = text.search(/^\[canisters\./m);
  const block = NETWORK_BLOCK + '\n\n';
  text = firstCanister >= 0 ? text.slice(0, firstCanister) + block + text.slice(firstCanister) : text.trimEnd() + '\n\n' + block;
  return text.replace(/\n{3,}/g, '\n\n');
}

// In each backend-motoko build command, the moc invocation gains
// --legacy-persistence. The invocation is "$MOC", $MOC, or a bare `moc` followed
// by its arguments (never a `moc` inside a path).
export function addLegacyPersistence(raw) {
  const toml = parseToml(raw);
  let text = raw;
  for (const c of Object.values(toml.canisters ?? {})) {
    if (c.type !== 'backend-motoko' || typeof c.build !== 'string' || c.build.includes('--legacy-persistence')) continue;
    const fixed = c.build.replace(/("\$MOC"|\$MOC\b|(?<![\/\w.-])moc(?=\s+[-$]))/, '$1 --legacy-persistence');
    if (fixed !== c.build) text = text.split(c.build).join(fixed);
  }
  return text;
}

// Each finding: {rule, contract, detail, fix}. Every rule here is one a deploy
// must not proceed past.
export function manifestFindings(toml, rawToml) {
  const out = [];
  for (const [name, c] of Object.entries(toml.canisters ?? {})) {
    if (c.type === 'backend-motoko' && typeof c.build === 'string' && /\bmoc\b|\$MOC/.test(c.build) && !c.build.includes('--legacy-persistence')) {
      out.push({
        rule: 'legacy-persistence',
        contract: name,
        detail: 'custom build command compiles without --legacy-persistence; such a build cannot be upgraded in place later',
        fix: `For a contract not yet deployed: add --legacy-persistence to the moc command in [canisters.${name}].build, or replace build with source = "<path to main.mo>". For a contract already live, do not change its persistence mode in an upgrade: measure the live module first.`,
      });
    }
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(rawToml)) {
    out.push({
      rule: 'no-node-addresses',
      contract: null,
      detail: 'thebes.toml lists validator IP addresses; a manifest reaches the chain through the public gateway',
      fix: `Replace the [networks.*] block with:\n${NETWORK_BLOCK}\nand set default_network = "thebes".`,
    });
  }
  return out;
}
