/**
 * Turn-completion notification: the primary seam, and the one with the most
 * ways to be wrong (per-round goals, crash-tail reasons, duplicate reports).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, describeTurnEnd } from '../lib/index.js';
import { makeCtx, makeAgent, makeNotifier } from './harness.mjs';

/** Apply the plugin and drive it up to one idle transition with `reason`. */
function turnEnd({ reason, header = {}, config = {}, agent, goal } = {}) {
  const harness = makeCtx();
  const recorder = makeNotifier();
  if (goal !== undefined) {
    harness.provide('goals', { get: () => goal });
  }
  harness.provide('sessionTitle', { get: () => ({ title: '修复登录 500' }) });
  apply(harness.ctx, config, recorder.notify);
  const subject = agent ?? makeAgent('session-1111', header);
  harness.emit('agent/status', { agent: subject, status: 'running' });
  if (reason !== undefined) {
    harness.emit('session/event', subject.session, { type: 'turn/end', data: { turn: 1, reason } });
  }
  harness.emit('agent/status', { agent: subject, status: 'idle' });
  return { ...harness, recorder };
}

test('a completed turn raises one notification naming the session', () => {
  const { recorder } = turnEnd({ reason: { kind: 'completed' } });
  assert.equal(recorder.sent.length, 1);
  assert.deepEqual(recorder.sent[0].lines, ['DeepSeek Harness', '已完成', '修复登录 500']);
});

test('an error turn reports the provider message', () => {
  const { recorder } = turnEnd({ reason: { kind: 'error', error: { message: 'Connection reset' } } });
  assert.equal(recorder.sent.length, 1);
  assert.match(recorder.sent[0].lines[1], /出错：Connection reset/);
});

test('a user abort is reported as an abort, not a completion', () => {
  const { recorder } = turnEnd({ reason: { kind: 'aborted', reason: { kind: 'user' } } });
  assert.equal(recorder.sent.length, 1);
  assert.match(recorder.sent[0].lines[1], /已中止（user）/);
});

test('crash-tail and fork reasons stay silent', () => {
  assert.equal(describeTurnEnd({ kind: 'interrupted' }), undefined);
  assert.equal(describeTurnEnd({ kind: 'forked' }), undefined);
  assert.equal(turnEnd({ reason: { kind: 'interrupted' } }).recorder.sent.length, 0);
  assert.equal(turnEnd({ reason: { kind: 'forked' } }).recorder.sent.length, 0);
});

test('a subagent session is not announced by default', () => {
  const silent = turnEnd({ reason: { kind: 'completed' }, header: { origin: 'subagent' } });
  assert.equal(silent.recorder.sent.length, 0);
  const loud = turnEnd({ reason: { kind: 'completed' }, header: { origin: 'subagent' }, config: { includeSubagents: true } });
  assert.equal(loud.recorder.sent.length, 1);
});

test('only the running → idle edge notifies, not an idle → idle repeat', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: 'x' }) });
  apply(harness.ctx, {}, recorder.notify);
  const agent = makeAgent();
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  harness.emit('agent/status', { agent, status: 'idle' });
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.equal(recorder.sent.length, 1);
});

test('a replayed turn/end does not re-announce the same idle', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: 'x' }) });
  apply(harness.ctx, {}, recorder.notify);
  const agent = makeAgent();
  const reason = { kind: 'completed' };
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason } });
  harness.emit('agent/status', { agent, status: 'idle' });
  // The reason is consumed on use, so a later idle with no fresh turn/end is quiet.
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.equal(recorder.sent.length, 1);
});

test('an armed active goal suppresses per-round notices', () => {
  const goal = { phase: 'active', activation: 'armed', blockedReason: undefined };
  const suppressed = turnEnd({ reason: { kind: 'completed' }, goal });
  assert.equal(suppressed.recorder.sent.length, 0);

  const opted = turnEnd({
    reason: { kind: 'completed' },
    goal,
    config: { suppressWhileGoalActive: false },
  });
  assert.equal(opted.recorder.sent.length, 1);
});

test('a disarmed or finished goal does not suppress the notice', () => {
  for (const goal of [
    { phase: 'active', activation: 'disarmed' },
    { phase: 'paused', activation: 'armed' },
    { phase: 'blocked', activation: 'disarmed' },
    { phase: 'complete', activation: 'armed' },
  ]) {
    assert.equal(turnEnd({ reason: { kind: 'completed' }, goal }).recorder.sent.length, 1, JSON.stringify(goal));
  }
});

test('a missing goals service degrades to notifying, not to silence', () => {
  const { recorder } = turnEnd({ reason: { kind: 'completed' } });
  assert.equal(recorder.sent.length, 1);
});

test('the master switch silences every seam', () => {
  assert.equal(turnEnd({ reason: { kind: 'completed' }, config: { enabled: false } }).recorder.sent.length, 0);
});

test('onTurnEnd off leaves the other seams armed', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: 'x' }) });
  apply(harness.ctx, { onTurnEnd: false }, recorder.notify);
  const agent = makeAgent();
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  harness.emit('agent/status', { agent, status: 'idle' });
  assert.equal(recorder.sent.length, 0);
  harness.emit('goal/changed', { agent, change: { operation: 'block', goal: { blockedReason: { message: 'no progress' } } } });
  assert.equal(recorder.sent.length, 1);
});

test('the notification body never carries a raw newline', () => {
  const { recorder } = turnEnd({ reason: { kind: 'error', error: { message: 'line one\nline two\r\nline three' } } });
  assert.equal(recorder.sent[0].lines.length, 3);
  assert.ok(recorder.sent[0].lines.every((line) => !/[\r\n]/u.test(line)));
});

test('a thrown observer is contained and logged, never propagated', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', {
    get() { throw new Error('session log unreadable'); },
  });
  apply(harness.ctx, {}, recorder.notify);
  const agent = makeAgent();
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.doesNotThrow(() => harness.emit('agent/status', { agent, status: 'idle' }));
  assert.equal(recorder.sent.length, 1);
  assert.match(recorder.sent[0].lines[2], /^会话 /);
});

test('a goal block does not also report the blocked turn that follows it', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: '审计' }) });
  apply(harness.ctx, {}, recorder.notify);
  const agent = makeAgent();

  // The goal blocks mid-turn: this is the fact that carries the reason.
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('goal/changed', {
    agent,
    change: { operation: 'block', goal: { blockedReason: { code: 'blocked', message: 'no progress' } } },
  });
  // The same turn then closes with reason `blocked`, which adds nothing.
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'blocked' } } });
  harness.emit('agent/status', { agent, status: 'idle' });

  assert.equal(recorder.sent.length, 1, 'one event must be one toast');
  assert.match(recorder.sent[0].lines[1], /目标受阻：no progress/);
});

test('a later blocked turn still reports once the block is stale', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: '审计' }) });
  // A zero window makes the block stale immediately, standing in for the user
  // starting a new turn well after seeing the blocked goal.
  apply(harness.ctx, { dedupeMs: 0 }, recorder.notify);
  const agent = makeAgent();

  harness.emit('goal/changed', {
    agent,
    change: { operation: 'block', goal: { blockedReason: { message: 'no progress' } } },
  });
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'blocked' } } });
  harness.emit('agent/status', { agent, status: 'idle' });

  assert.equal(recorder.sent.length, 2, 'the later turn is its own event');
});

test('a blocked turn with no preceding goal block still reports', () => {
  const { recorder } = turnEnd({ reason: { kind: 'blocked' } });
  assert.equal(recorder.sent.length, 1);
  assert.match(recorder.sent[0].lines[1], /被阻塞/);
});

test('a completion right after a goal block is not swallowed', () => {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: '审计' }) });
  apply(harness.ctx, {}, recorder.notify);
  const agent = makeAgent();

  harness.emit('goal/changed', {
    agent,
    change: { operation: 'block', goal: { blockedReason: { message: 'no progress' } } },
  });
  // A `completed` turn is a genuinely different outcome and must still land,
  // even if it happens to close inside the dedupe window.
  harness.emit('agent/status', { agent, status: 'running' });
  harness.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });
  harness.emit('agent/status', { agent, status: 'idle' });

  assert.equal(recorder.sent.length, 2);
  assert.match(recorder.sent[1].lines[1], /已完成/);
});
