const test = require('node:test');
const assert = require('node:assert/strict');
const { pathIssues, textIssues } = require('../scripts/lib/public-files.cjs');

test('public file audit rejects local state, keys, generated archives and unreviewed photos', () => {
  for (const name of [
    '.local/profile/Cookies',
    'dist/app.js',
    'outputs/result.png',
    '.env',
    'mcp-config.json',
    'token.enc',
    'jobs.sqlite',
    'release.zip',
    'photos/input.jpg',
    'docs/assets/login.png',
    'docs/implementation-plan.md',
    'AGENTS.md',
    'apps/desktop/agents.md',
    'AGENTS.override.md',
    'assets/readme/login.png',
  ])
    assert.ok(pathIssues(name).length, name);
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'mise.lock',
    '.env.example',
    'examples/mcp-config.example.json',
    'apps/desktop/ui/icon.png',
    'packages/contracts/schema.json',
    'tests/fixtures/contract-examples.json',
    'assets/readme/workspace.png',
    'assets/readme/queue.png',
  ])
    assert.deepEqual(pathIssues(name), [], name);
});

test('public text audit reports locations without returning the credential contents', () => {
  const token = 'gh' + 'p_' + 'a'.repeat(40);
  const input = 'safe\n' + token + '\n' + ['C:', 'Users', 'example-user', 'photo.png'].join('\\');
  const result = textIssues(input);
  assert.deepEqual(result, [
    { kind: 'credential', line: 2 },
    { kind: 'personal-home-path', line: 3 },
  ]);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(textIssues('Authorization: `Bearer ${token}`'), []);
});
