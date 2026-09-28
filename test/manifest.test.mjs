/**
 * Mount-shape contract: the properties that decide whether the composition can
 * load this entry at all, and whether the 0.2.0 kernel compatibility gate can
 * ever refuse it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the manifest declares no @deepseek-ai/dsh* peer, so the version gate cannot apply', () => {
  const peers = Object.keys(manifest.peerDependencies ?? {});
  const gated = peers.filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));
  assert.deepEqual(gated, [], 'a gated peer would be checked against the running runtime and could block activation');
});

test('the manifest declares no runtime dependency at all', () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), []);
});

test('the manifest is a dsh bundle with a patch file that exists', () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string');
  const text = readFileSync(join(root, patch), 'utf8');
  assert.match(text, /- insert:/);
  assert.match(text, /id: session-toast/);
  assert.match(text, /name: 'dsh-session-toast'/);
});

test('loading the host half never throws and exports the loader contract', async () => {
  const module = await import('../lib/index.js');
  assert.equal(module.name, 'dsh-session-toast');
  assert.deepEqual(module.inject, []);
  assert.equal(typeof module.apply, 'function');
  // Config is either a usable schema or deliberately undefined — never a throw.
  assert.ok(module.Config === undefined || typeof module.Config === 'object');
});

test('a missing schemastery degrades Config instead of aborting the profile', () => {
  const source = readFileSync(join(root, 'lib/index.js'), 'utf8');
  // The resolution must be guarded, and every candidate capability-probed, so a
  // missing or too-old copy yields Config === undefined rather than an exception
  // during module evaluation — which the loader answers by killing the profile.
  assert.match(source, /function resolveSchemastery\(\)/);
  assert.match(source, /catch \{/);
  assert.doesNotMatch(source, /^import .*schemastery/m);
});

test('the plugin reads every collaborator optionally rather than injecting it', () => {
  const source = readFileSync(join(root, 'lib/index.js'), 'utf8');
  for (const service of ['goals', 'sessionTitle']) {
    assert.match(source, new RegExp(`ctx\\.get\\('${service}'\\)`), `${service} must be looked up optionally`);
  }
  // commands arrives asynchronously through ctx.inject, since this entry may be
  // applied before the command registry exists.
  assert.match(source, /ctx\.inject\(\['commands'\]/);
});

test('the toast program carries dynamic text as base64, not as inline PowerShell', () => {
  const source = readFileSync(join(root, 'lib/toast.js'), 'utf8');
  assert.match(source, /function payload\(value\)/);
  assert.match(source, /Buffer\.from\(String\(value\), 'utf8'\)\.toString\('base64'\)/);
  // The only PowerShell identifiers allowed to hold dynamic text are the base64
  // transports, so quoting, locale, and code page cannot corrupt a notification.
  assert.doesNotMatch(source, /\$\{JSON\.stringify\(input\.lines\)\}/);
});

test('the toast never blocks the caller', () => {
  const source = readFileSync(join(root, 'lib/toast.js'), 'utf8');
  assert.match(source, /stdio: 'ignore'/);
  assert.match(source, /windowsHide: true/);
  assert.match(source, /if \(detach\) child\.unref\(\)/);
});
