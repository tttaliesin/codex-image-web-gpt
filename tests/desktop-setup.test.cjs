const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DesktopSetup, launchContext } = require('../scripts/lib/desktop-setup.cjs');

const base = path.resolve('.local/tests', `desktop-setup-${Date.now()}`);
test('first launch persists empty folder permissions and a picked folder survives restart', async () => {
  const root = path.join(base, 'first');
  const folder = path.join(base, 'Images');
  await fs.mkdir(folder, { recursive: true });
  const options = {
    root,
    profile: path.join(root, 'profile'),
    config: path.join(root, 'mcp-config.json'),
  };
  const setup = new DesktopSetup(options);
  await setup.initialize();
  assert.deepEqual(setup.configuration.input_roots, []);
  assert.deepEqual(setup.configuration.export_roots, []);
  await setup.setFolders('input', [folder]);
  await setup.setFolders('export', [folder]);
  const reopened = new DesktopSetup(options);
  await reopened.initialize();
  assert.deepEqual(reopened.configuration.input_roots, [folder]);
  assert.deepEqual(reopened.configuration.export_roots, [folder]);
});

test('canceled picker does not grant access and links or nonexistent folders are rejected', async () => {
  const root = path.join(base, 'denied');
  const setup = new DesktopSetup({
    root,
    profile: path.join(root, 'profile'),
    config: path.join(root, 'mcp-config.json'),
  });
  await setup.initialize();
  await setup.setFolders('input', null);
  await assert.rejects(
    setup.setFolders('export', [path.join(base, 'missing')]),
    /FOLDER_UNAVAILABLE/,
  );
  const actual = path.join(base, 'actual');
  const link = path.join(base, 'link');
  await fs.mkdir(actual, { recursive: true });
  await fs.symlink(actual, link, 'junction');
  await assert.rejects(setup.setFolders('input', [link]), /FOLDER_LINK_REJECTED/);
  assert.deepEqual(JSON.parse(await fs.readFile(setup.options.config, 'utf8')).input_roots, []);
});

test('direct packaged launch reuses an installed external profile instead of resetting login', async () => {
  const root = path.join(base, 'existing');
  await fs.mkdir(root, { recursive: true });
  const previous = {
    product: 'web-image-bridge',
    profile: path.join(base, 'preserved-profile'),
    config: path.join(root, 'mcp-config.json'),
  };
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(previous));
  const context = launchContext({ root, appRoot: path.join(base, 'app'), packaged: true });
  assert.equal(context.profile, previous.profile);
  assert.equal(context.config, previous.config);
});
