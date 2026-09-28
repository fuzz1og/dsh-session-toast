/**
 * The blocking seams: a parked question and a parked approval. Both are
 * waterfalls, so the single most important property is that this plugin never
 * consumes the request — swallowing it would hang the tool call forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';
import { makeCtx, makeAgent, makeNotifier } from './harness.mjs';

/** Apply the plugin over a stub harness with one titled session. */
function setup(config = {}) {
  const harness = makeCtx();
  const recorder = makeNotifier();
  harness.provide('sessionTitle', { get: () => ({ title: '依赖审计' }) });
  apply(harness.ctx, config, recorder.notify);
  return { ...harness, recorder };
}

test('a parked question notifies and still reaches the answerer', async () => {
  const harness = setup();
  const agent = makeAgent();
  const request = {
    agent,
    questions: [{ id: 'q1', question: '要装到 desktop profile 吗？', header: 'Confirm' }],
  };
  const answer = await harness.waterfall('user-questions/request', request, () => Promise.resolve({ answers: [{ id: 'q1', selected: ['是'] }] }));

  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['是'] }] });
  assert.equal(harness.recorder.sent.length, 1);
  assert.match(harness.recorder.sent[0].lines[1], /正在问你：要装到 desktop profile 吗？/);
});

test('a question body falls back to the header when the text is absent', async () => {
  const harness = setup();
  await harness.waterfall('user-questions/request', {
    agent: makeAgent(),
    questions: [{ id: 'q1', question: '', header: 'Choose Mode' }],
  }, () => Promise.resolve({ answers: [] }));
  assert.match(harness.recorder.sent[0].lines[1], /Choose Mode/);
});

test('a question from a subagent session stays silent but still resolves', async () => {
  const harness = setup();
  const agent = makeAgent('session-child', { origin: 'subagent' });
  const answer = await harness.waterfall('user-questions/request', {
    agent,
    questions: [{ id: 'q1', question: 'x' }],
  }, () => Promise.resolve({ answers: [] }));
  assert.deepEqual(answer, { answers: [] });
  assert.equal(harness.recorder.sent.length, 0);
});

test('a parked approval notifies with the tool name and still resolves', async () => {
  const harness = setup();
  const agent = makeAgent();
  const outcome = await harness.waterfall('approval/request', {
    agent,
    toolName: 'write',
    reason: 'write outside the workspace',
    displayReason: { en: 'Write outside the workspace', zh: '写入工作区之外' },
  }, () => Promise.resolve('allowed-once'));

  assert.equal(outcome, 'allowed-once');
  assert.equal(harness.recorder.sent.length, 1);
  assert.match(harness.recorder.sent[0].lines[1], /等待你的审批：write/);
  assert.equal(harness.recorder.sent[0].lines[2], '写入工作区之外');
});

test('an approval with no display reason falls back to the plain reason', async () => {
  const harness = setup();
  await harness.waterfall('approval/request', {
    agent: makeAgent(),
    toolName: 'pwsh',
    reason: 'sandbox escalation',
  }, () => Promise.resolve('rejected'));
  assert.equal(harness.recorder.sent[0].lines[2], 'sandbox escalation');
});

test('repeated approvals for one tool collapse inside the dedupe window', async () => {
  const harness = setup();
  const agent = makeAgent();
  for (let index = 0; index < 3; index += 1) {
    await harness.waterfall('approval/request', { agent, toolName: 'write' }, () => Promise.resolve('allowed-once'));
  }
  assert.equal(harness.recorder.sent.length, 1);
});

test('approvals for different tools each notify', async () => {
  const harness = setup();
  const agent = makeAgent();
  await harness.waterfall('approval/request', { agent, toolName: 'write' }, () => Promise.resolve('allowed-once'));
  await harness.waterfall('approval/request', { agent, toolName: 'pwsh' }, () => Promise.resolve('allowed-once'));
  assert.equal(harness.recorder.sent.length, 2);
});

test('onQuestion off keeps the question waterfall intact', async () => {
  const harness = setup({ onQuestion: false });
  const answer = await harness.waterfall('user-questions/request', {
    agent: makeAgent(),
    questions: [{ id: 'q1', question: 'x' }],
  }, () => Promise.resolve({ answers: [{ id: 'q1', selected: [] }] }));
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: [] }] });
  assert.equal(harness.recorder.sent.length, 0);
});

test('onApproval off keeps the approval waterfall intact', async () => {
  const harness = setup({ onApproval: false });
  const outcome = await harness.waterfall('approval/request', { agent: makeAgent(), toolName: 'write' }, () => Promise.resolve('allowed-once'));
  assert.equal(outcome, 'allowed-once');
  assert.equal(harness.recorder.sent.length, 0);
});

test('the plugins approval listener never claims the request itself', async () => {
  const harness = setup();
  const outcome = await harness.waterfall('approval/request', { agent: makeAgent(), toolName: 'write' }, () => Promise.resolve('unavailable'));
  assert.equal(outcome, 'unavailable', 'the terminal answerer must be the one that decides');
});

test('a blocked goal notifies with its reason', () => {
  const harness = setup();
  const agent = makeAgent();
  harness.emit('goal/changed', {
    agent,
    change: { operation: 'block', goal: { blockedReason: { code: 'blocked', message: 'waiting on CI' } } },
  });
  assert.equal(harness.recorder.sent.length, 1);
  assert.match(harness.recorder.sent[0].lines[1], /目标受阻：waiting on CI/);
});

test('goal mutations other than block stay silent', () => {
  const harness = setup();
  const agent = makeAgent();
  for (const operation of ['create', 'edit', 'pause', 'resume', 'complete', 'clear']) {
    harness.emit('goal/changed', { agent, change: { operation } });
  }
  assert.equal(harness.recorder.sent.length, 0);
});

test('a malformed event payload cannot throw out of a seam', () => {
  const harness = setup();
  assert.doesNotThrow(() => harness.emit('goal/changed', undefined));
  assert.doesNotThrow(() => harness.emit('goal/changed', {}));
  assert.doesNotThrow(() => harness.emit('agent/status', undefined));
  assert.doesNotThrow(() => harness.emit('session/event', undefined, undefined));
  assert.doesNotThrow(() => harness.emit('agent/disposed', undefined));
  assert.equal(harness.recorder.sent.length, 0);
});
