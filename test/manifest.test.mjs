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

test('every host listener is registered with global: true', async () => {
  const { apply } = await import('../lib/index.js');
  const { makeCtx, makeNotifier } = await import('./harness.mjs');
  const harness = makeCtx();
  apply(harness.ctx, {}, makeNotifier().notify);

  // Cordis resolves a dispatch with
  //   filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx))
  // so only `global: true` short-circuits scope admission. Without it a
  // listener is admitted only when the dispatching carrier descends from the
  // listening context's scope chain — which the flat tree a unit test builds
  // cannot reproduce, but the live composition (an agent carrier for
  // `agent/status`, a session scope for `session/event`, `isolate` groups) can
  // silently deny.
  const events = ['agent/status', 'session/event', 'agent/disposed',
    'user-questions/request', 'approval/request', 'goal/changed'];
  for (const event of events) {
    const opts = harness.options.get(event) ?? [];
    assert.ok(opts.length > 0, `${event} must have a listener`);
    for (const o of opts) {
      assert.equal(o?.global, true, `${event} listener must be registered with { global: true }`);
    }
  }
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

test('clicking the toast focuses the desktop window through the shell protocol', () => {
  const source = readFileSync(join(root, 'lib/toast.js'), 'utf8');
  // The activation attributes must ride on the <toast> element, and the URI
  // must travel as a base64 payload like every other dynamic value.
  assert.match(source, /activationType="protocol" launch=/);
  assert.match(source, /export const DSH_ACTIVATION_URI = 'dsh:\/\/open'/);
  assert.match(source, /\$launchValue = B64/);
  // The URI must be escaped before it reaches the XML attribute.
  assert.match(source, /' activationType="protocol" launch="' \+ \(X \$launchValue\)/);
});

test('the toast is click-inert only when the caller asks for that', () => {
  const source = readFileSync(join(root, 'lib/index.js'), 'utf8');
  assert.match(source, /focusOnClick: true/);
  assert.match(source, /launch: focus \? read\('activationUri'\) : ''/);
});

test('the toast program carries dynamic text as base64, not as inline PowerShell', () => {
  const source = readFileSync(join(root, 'lib/toast.js'), 'utf8');
  assert.match(source, /function payload\(value\)/);
  assert.match(source, /Buffer\.from\(String\(value\), 'utf8'\)\.toString\('base64'\)/);
  // The only PowerShell identifiers allowed to hold dynamic text are the base64
  // transports, so quoting, locale, and code page cannot corrupt a notification.
  assert.doesNotMatch(source, /\$\{JSON\.stringify\(input\.lines\)\}/);
});

test('the toast never blocks the caller but stays attached to this desktop', () => {
  const source = readFileSync(join(root, 'lib/toast.js'), 'utf8');
  assert.match(source, /stdio: 'ignore'/);
  assert.match(source, /windowsHide: true/);
  // The parent must not wait for the child and must not stay alive for it.
  assert.match(source, /if \(unref\) child\.unref\(\)/);

  // Regression guard, scoped to code: `detached: true` silently kills every
  // toast on Windows — the Action Center history records nothing while the
  // child still exits 0 — so the spawn options must always say false. Comments
  // explain that history and are stripped before the check.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
  assert.match(code, /detached: false/);
  assert.doesNotMatch(code, /detached: true/);
  assert.doesNotMatch(code, /detached: detach/);
});
