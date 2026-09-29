/**
 * The regression that would have caught the live failure.
 *
 * Cordis delivers a validated `.volatile()` config field as a `{ get }` accessor
 * object, not a plain value. Reading it directly yields an object that
 * JSON-stringifies to `{}`, which dropped the title row and sent
 * `[object Object]` to `CreateToastNotifier` — the toast silently never showed.
 *
 * Every test that calls `apply(ctx, rawObject, recorder)` misses this, because
 * no validation runs on a raw object. So these tests pin the accessor shape
 * explicitly, using hand-built accessors that match the real one measured from
 * schemastery 3.18.4 under the host's Electron:
 *
 *   aumid  ctor=Object  json={}  props=["get"]   .get() === "com.deepseek.dsh"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, unwrapSetting } from '../lib/index.js';
import { makeCtx, makeAgent, makeNotifier } from './harness.mjs';

/** A stand-in for one validated `.volatile()` field, carrying only `get`. */
function volatileField(value) {
  return {
    get() { return value; },
  };
}

/** A config shaped exactly as Cordis hands it to `apply`: every field volatile. */
function validatedConfig(overrides = {}) {
  const base = {
    enabled: true, onTurnEnd: true, onQuestion: true, onApproval: true, onGoalBlock: true,
    sound: true, aumid: 'com.deepseek.dsh', powershellPath: '', title: 'DeepSeek Harness',
    dedupeMs: 2000, suppressWhileGoalActive: true, includeSubagents: false,
    focusOnClick: true, activationUri: 'dsh://open', audit: false, auditPath: '',
  };
  const merged = { ...base, ...overrides };
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, volatileField(v)]));
}

test('unwrapSetting reads through a volatile accessor', () => {
  assert.equal(unwrapSetting(volatileField('com.deepseek.dsh')), 'com.deepseek.dsh');
  assert.equal(unwrapSetting(volatileField(2000)), 2000);
  assert.equal(unwrapSetting(volatileField(false)), false);
  // Plain values pass through untouched.
  assert.equal(unwrapSetting('plain'), 'plain');
  assert.equal(unwrapSetting(undefined), undefined);
  assert.equal(unwrapSetting(null), null);
  // A throwing accessor degrades to undefined rather than taking the path down.
  assert.equal(unwrapSetting({ get() { throw new Error('disposed'); } }), undefined);
});

test('a validated volatile config still yields a string aumid and a title row', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: '回归测试' }) });

  // The exact shape Cordis passes after validation — accessor objects, not values.
  apply(harness.ctx, validatedConfig(), recorder.notify);

  const agent = makeAgent();
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  harness.emit('agent/status', { agent, status: 'idle' });

  assert.equal(recorder.sent.length, 1, 'the completion must still notify');
  const sent = recorder.sent[0];
  assert.equal(typeof sent.aumid, 'string', 'aumid must be a plain string, never an accessor object');
  assert.equal(sent.aumid, 'com.deepseek.dsh');
  assert.deepEqual(sent.lines, ['DeepSeek Harness', '已完成', '回归测试'],
    'the title row must survive the string filter');
});

test('a volatile override reaches the notifier', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: 'T' }) });
  apply(harness.ctx, validatedConfig({ aumid: 'custom.aumid', title: '自定义标题', sound: false }), recorder.notify);

  const agent = makeAgent();
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  harness.emit('agent/status', { agent, status: 'idle' });

  assert.equal(recorder.sent[0].aumid, 'custom.aumid');
  assert.equal(recorder.sent[0].lines[0], '自定义标题');
  assert.equal(recorder.sent[0].sound, false, 'a volatile false must not fall back to the default');
});

test('volatile switches are honored, not treated as truthy objects', () => {
  // Each of these is `false` in the validated config; reading the accessor
  // object instead of its value would leave every switch looking enabled.
  for (const [field, config] of [
    ['enabled', { enabled: false }],
    ['onTurnEnd', { onTurnEnd: false }],
  ]) {
    const harness = makeCtx();
    const recorder = makeNotifier();
    harness.provide('sessionTitle', { get: () => ({ title: 'T' }) });
    apply(harness.ctx, validatedConfig(config), recorder.notify);

    const agent = makeAgent();
    harness.emit('agent/status', { agent, status: 'running' });
    harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    harness.emit('agent/status', { agent, status: 'idle' });

    assert.equal(recorder.sent.length, 0, `${field}: false must silence the seam`);
  }
});

test('sound is a delivery option, not a mute switch', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: 'T' }) });
  apply(harness.ctx, validatedConfig({ sound: false }), recorder.notify);

  const agent = makeAgent();
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  harness.emit('agent/status', { agent, status: 'idle' });

  // `sound: false` still notifies — silently. Reading the accessor object
  // instead of its value would make it truthy and the toast would play a sound.
  assert.equal(recorder.sent.length, 1);
  assert.equal(recorder.sent[0].sound, false);
});
