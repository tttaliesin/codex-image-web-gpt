const { isDeepStrictEqual } = require('node:util');
const TOML = require('smol-toml');

const parse = (text) => TOML.parse(text, { integersAsBigInt: 'asNeeded' });
const markers = new Set([
  '# BEGIN Web Image Bridge managed integration',
  '# END Web Image Bridge managed integration',
]);

// Receipts from older releases store TOML text. Its values establish ownership;
// comment boundaries do not, since other writers may insert settings between them.
function assertManagedConfig(text, block) {
  const actual = parse(text);
  const expected = parse(block);
  const server = expected.mcp_servers?.web_image_bridge;
  if (!server) throw Error('INTEGRATION_RECEIPT_INVALID');
  if (!actual.mcp_servers?.web_image_bridge) throw Error('CONFIG_MANAGED_BLOCK_MISSING');
  if (!isDeepStrictEqual(actual.mcp_servers.web_image_bridge, server))
    throw Error('CONFIG_MANAGED_BLOCK_CHANGED');
  for (const entry of expected.skills?.config ?? []) {
    const matches = actual.skills?.config?.filter((item) => item.path === entry.path) ?? [];
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], entry))
      throw Error('CONFIG_MANAGED_BLOCK_CHANGED');
  }
  return actual;
}

function normalizeEmptyParents(config) {
  if (config.mcp_servers && !Object.keys(config.mcp_servers).length) delete config.mcp_servers;
  if (config.skills?.config?.length === 0) delete config.skills.config;
  if (config.skills && !Object.keys(config.skills).length) delete config.skills;
  return config;
}

function removeManagedConfig(text, block) {
  const original = assertManagedConfig(text, block);
  const expected = parse(block);
  const skillPaths = new Set((expected.skills?.config ?? []).map((entry) => entry.path));
  const lines = [];
  let offset = 0;
  for (const value of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    lines.push({ start: offset, value });
    offset += value.length;
  }
  // Parsing the prefix distinguishes real headers/comments from identical lines
  // inside multiline strings or arrays. Never infer TOML scope from a regex alone.
  const boundary = (start) => {
    try {
      parse(text.slice(0, start));
      return true;
    } catch {
      return false;
    }
  };
  const headers = lines.filter(
    (line) => line.value.trimStart().startsWith('[') && boundary(line.start),
  );
  const removed = new Set();
  let servers = 0;
  let skills = 0;
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    const shape = parse(header.value);
    const finish = headers[index + 1]?.start ?? text.length;
    const isServer = isDeepStrictEqual(shape, { mcp_servers: { web_image_bridge: {} } });
    const isSkill =
      isDeepStrictEqual(shape, { skills: { config: [{}] } }) &&
      skillPaths.has(parse(text.slice(header.start, finish)).skills.config[0].path);
    if (!isServer && !isSkill) continue;
    if (isServer) servers++;
    if (isSkill) skills++;
    for (const line of lines) {
      if (line.start < header.start || line.start >= finish) continue;
      const trimmed = line.value.trim();
      // Preserve independent comments and spacing, including comments written by
      // another app. Lines inside multiline values belong to the removed value.
      if ((!trimmed || trimmed.startsWith('#')) && boundary(line.start)) continue;
      removed.add(line);
    }
  }
  // Inline/dotted representations can be read and checked, but must not be
  // rewritten unless their source ranges can be isolated without losing data.
  if (servers !== 1 || skills !== skillPaths.size) throw Error('CONFIG_EDIT_UNSUPPORTED');
  for (const line of lines) {
    if (markers.has(line.value.trim()) && boundary(line.start)) removed.add(line);
  }
  const updated = lines
    .filter((line) => !removed.has(line))
    .map((line) => line.value)
    .join('');
  const remaining = original;
  delete remaining.mcp_servers.web_image_bridge;
  if (skillPaths.size)
    remaining.skills.config = remaining.skills.config.filter(
      (entry) => !skillPaths.has(entry.path),
    );
  if (!isDeepStrictEqual(normalizeEmptyParents(parse(updated)), normalizeEmptyParents(remaining)))
    throw Error('UNRELATED_CONFIG_CHANGED');
  return updated;
}

module.exports = { assertManagedConfig, removeManagedConfig };
