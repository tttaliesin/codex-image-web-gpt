const test = require('node:test');
const assert = require('node:assert/strict');
const TOML = require('smol-toml');
const { assertManagedConfig, removeManagedConfig } = require('../scripts/lib/codex-config.cjs');

const block = '[mcp_servers.web_image_bridge]\nurl = "http://localhost:43179/mcp"\n';

test('configuration removal ignores fake headers and markers in multiline values', () => {
  const foreign = `notes = '''
[mcp_servers.web_image_bridge]
# BEGIN Web Image Bridge managed integration
# END Web Image Bridge managed integration
'''
[agents]
max_depth = 2
`;
  const text = foreign + block;
  assert.equal(removeManagedConfig(text, block), foreign);
});

test('multiline owned values are removed completely, without preserving their fake comments', () => {
  const text = `[mcp_servers.web_image_bridge]
http_headers_helper = '''first
# this is part of the helper, not a standalone comment
[fake.table]
last'''
# another app's comment
[agents]
max_depth = 2
`;
  const receipt = TOML.stringify({ mcp_servers: TOML.parse(text).mcp_servers });
  const remaining = removeManagedConfig(text, receipt);
  assert.equal(remaining, "# another app's comment\n[agents]\nmax_depth = 2\n");
});

test('inline owned configuration remains checkable but unsafe automatic removal is rejected', () => {
  const text =
    'mcp_servers = { web_image_bridge = { url = "http://localhost:43179/mcp" }, other = { enabled = true } }\n';
  assertManagedConfig(text, block);
  assert.throws(() => removeManagedConfig(text, block), /CONFIG_EDIT_UNSUPPORTED/);
});

test('duplicate owned skill entries are not silently deleted', () => {
  const skill = '[[skills.config]]\npath = "bundled/SKILL.md"\nenabled = false\n';
  assert.throws(
    () => removeManagedConfig(block + skill + skill, block + skill),
    /CONFIG_MANAGED_BLOCK_CHANGED/,
  );
});

test('explicit parent tables, unrelated large integers and dates survive removal', () => {
  const foreign = '[agents]\nlarge = 9223372036854775807\ncreated = 2026-09-23T00:00:00Z\n';
  const text = foreign + '[mcp_servers]\n' + block;
  assert.equal(removeManagedConfig(text, block), foreign + '[mcp_servers]\n');
});
