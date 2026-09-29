/**
 * dsh-session-toast — host half.
 *
 * Pops a real Windows system notification when something in DSH finishes or
 * stops waiting for you. Six seams, all of them existing host events — the
 * plugin polls nothing and adds no route:
 *
 *  - `agent/status`  → `running` → `idle` on a root agent, with the decisive
 *                      `turn/end` reason read back from that session's log.
 *  - `user-questions/request` → the agent called `ask_user_question` and the
 *                      call is parked until you answer.
 *  - `approval/request` → a tool dispatch is parked on your approval.
 *  - `goal/changed`  → the goal reached `blocked`, so automatic rounds stopped.
 *
 * ## Why this plugin declares no `@deepseek-ai/dsh-*` peerDependencies
 *
 * Since 0.2.0 the host checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
 * peer in a plugin manifest against the running runtime with
 * `semver.satisfies(runtime, range, { includePrerelease: true })`, and refuses
 * to install — or, once installed, to activate — anything that does not match.
 * `peerDependenciesMeta.optional` does not exempt a peer.
 *
 * Almost every notification plugin in the wild declares those peers against a
 * 0.1.x range (`^0.1.5-rc.2` and friends), which `0.2.0-rc.1` does not satisfy,
 * so they cannot load on the current desktop shell. This plugin talks only to
 * Cordis events and to services it looks up through `ctx.get(...)` at call
 * time, so it needs no peer at all and the gate can never bite it. A missing
 * optional service degrades one seam, never the mount.
 *
 * ## Infallible evaluation
 *
 * The loader reads this module's `Config` exactly once while evaluating it, and
 * answers a failed evaluation by aborting the whole profile. So `Config` is
 * built through a capability-probed, never-throwing resolution of
 * `@deepseek-ai/schemastery` and is exported as `undefined` when no usable copy
 * is reachable — a shape the loader tolerates. The default config below is what
 * actually drives behaviour; the schema only adds the Settings-UI row.
 *
 * @module dsh-session-toast
 */

import { createRequire } from 'node:module';
import { showToast, DSH_AUMID, DSH_ACTIVATION_URI } from './toast.js';
import { createAudit } from './audit.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-session-toast';

/**
 * No hard dependency: every seam looks its collaborators up optionally, so this
 * entry mounts on a composition that lacks any of them.
 */
export const inject = [];

const requireFromHere = createRequire(import.meta.url);

/** Whether one candidate module is a schemastery able to build THIS schema. */
function canBuildSchema(candidate) {
  if (typeof candidate?.object !== 'function' || typeof candidate?.boolean !== 'function') return false;
  try {
    return typeof candidate.boolean().default(true).volatile === 'function';
  } catch {
    return false;
  }
}

/**
 * Resolve a usable schemastery, trying this package's own dependency first and
 * the running harness install second. `process.argv[1]` is the launcher entry
 * in a real run, which is the only base that can resolve the harness's own
 * dependency graph — the profile's `node_modules` does not carry schemastery.
 *
 * @returns the module namespace, or null when none can build the schema.
 */
function resolveSchemastery() {
  const bases = [requireFromHere];
  const launcher = process.argv[1];
  if (typeof launcher === 'string' && launcher.length > 0) {
    try {
      bases.push(createRequire(launcher));
    } catch {
      /* an unusable launcher path is not fatal — an earlier base may still hit */
    }
  }
  for (const base of bases) {
    try {
      const loaded = base('@deepseek-ai/schemastery');
      const resolved = loaded !== null && typeof loaded === 'object' ? loaded.default ?? loaded : loaded;
      if (canBuildSchema(resolved)) return resolved;
    } catch {
      /* not resolvable from this base — try the next */
    }
  }
  return null;
}

/** Defaults that drive behaviour when no schema (and so no UI override) exists. */
const DEFAULTS = Object.freeze({
  enabled: true,
  onTurnEnd: true,
  onQuestion: true,
  onApproval: true,
  onGoalBlock: true,
  sound: true,
  aumid: DSH_AUMID,
  powershellPath: '',
  title: 'DeepSeek Harness',
  dedupeMs: 2000,
  suppressWhileGoalActive: true,
  includeSubagents: false,
  focusOnClick: true,
  activationUri: DSH_ACTIVATION_URI,
  /*
   * Default ON, deliberately. The live desktop host exposes no way to see
   * inside a plugin: its stdout is a pipe to the Electron shell and the host
   * process has no inspector port. When a toast silently fails to appear,
   * "the listeners never ran" and "they ran and failed at delivery" are
   * indistinguishable from outside — which cost several diagnosis cycles.
   * The log is one small line per decision point in %TEMP%, written only when
   * something happens, and it is the only evidence available after a restart.
   * Set `audit: false` to silence it.
   */
  audit: true,
  auditPath: '',
});

/** Build the Config schema; `undefined` when schemastery is unreachable. */
function buildConfigSchema(z) {
  if (z === null) return undefined;
  try {
    return z.object({
      enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
      onTurnEnd: z.boolean().default(DEFAULTS.onTurnEnd).volatile(),
      onQuestion: z.boolean().default(DEFAULTS.onQuestion).volatile(),
      onApproval: z.boolean().default(DEFAULTS.onApproval).volatile(),
      onGoalBlock: z.boolean().default(DEFAULTS.onGoalBlock).volatile(),
      sound: z.boolean().default(DEFAULTS.sound).volatile(),
      aumid: z.string().default(DEFAULTS.aumid).volatile(),
      powershellPath: z.string().default(DEFAULTS.powershellPath).volatile(),
      title: z.string().default(DEFAULTS.title).volatile(),
      dedupeMs: z.number().default(DEFAULTS.dedupeMs).volatile(),
      suppressWhileGoalActive: z.boolean().default(DEFAULTS.suppressWhileGoalActive).volatile(),
      includeSubagents: z.boolean().default(DEFAULTS.includeSubagents).volatile(),
      focusOnClick: z.boolean().default(DEFAULTS.focusOnClick).volatile(),
      activationUri: z.string().default(DEFAULTS.activationUri).volatile(),
      audit: z.boolean().default(DEFAULTS.audit).volatile(),
      auditPath: z.string().default(DEFAULTS.auditPath).volatile(),
    });
  } catch {
    return undefined;
  }
}

export const Config = buildConfigSchema(resolveSchemastery());

/** UTF-8-safe truncation that never splits a surrogate pair. Exported for tests. */
export function clip(text, max) {
  const points = Array.from(String(text ?? ''));
  if (points.length <= max) return points.join('');
  return `${points.slice(0, max).join('')}…`;
}

/**
 * Unwrap one validated config field.
 *
 * A schemastery `.volatile()` field is delivered as an accessor object holding a
 * single `get` method that returns the current value; a non-volatile field is
 * delivered as a plain value. Both shapes must survive, and an accessor whose
 * `get` throws (a disposed ref) must degrade to the caller's default rather than
 * take down the notification path.
 *
 * Exported so a test can pin the exact shapes without needing the harness's own
 * schemastery at hand.
 *
 * @param value - the raw field from the validated config.
 * @returns the plain value, or undefined when there is none.
 */
export function unwrapSetting(value) {
  if (value === null || typeof value !== 'object') return value;
  const getter = value.get;
  if (typeof getter !== 'function') return value;
  try {
    return getter.call(value);
  } catch {
    return undefined;
  }
}

/** One-line normalization: collapse whitespace so a body never becomes many lines. */
function oneLine(text, max) {
  return clip(String(text ?? '').replace(/\s+/gu, ' ').trim(), max);
}

/** Human label for one `TurnEndReason`. Exported for tests. */
export function describeTurnEnd(reason) {
  switch (reason?.kind) {
    case 'completed': return { title: '会话完成', outcome: '已完成' };
    case 'error': {
      const detail = reason.error?.message;
      return { title: '会话出错', outcome: `出错${detail ? `：${oneLine(detail, 120)}` : ''}` };
    }
    case 'aborted': return { title: '会话已中止', outcome: `已中止（${reason.reason?.kind ?? 'unknown'}）` };
    case 'max-tokens': return { title: '会话达到 token 上限', outcome: '达到 token 上限' };
    case 'blocked': return { title: '会话被阻塞', outcome: '被阻塞' };
    /* `interrupted` is the crash-tail repair written on reload, and `forked` is
     * a branch point — neither is work that just finished. */
    default: return undefined;
  }
}

/**
 * Wire the notifier into one composition.
 *
 * @param ctx - this entry's Cordis context.
 * @param config - validated config, or the raw patch config when no schema was built.
 * @param notifier - delivery hook; the loader passes nothing and the real
 *   Windows toast is used. Tests inject a recorder here instead.
 */
export function apply(ctx, config, notifier = showToast) {
  const settings = config && typeof config === 'object' ? config : {};

  /**
   * Read one config field, unwrapping a `.volatile()` accessor.
   *
   * Every field in this plugin's schema is `.volatile()`, which Cordis requires
   * for a setting that can change without a restart. After validation such a
   * field is NOT a plain value: it is a `{ get }` accessor object whose value is
   * read lazily, so `settings.aumid` is an object that JSON-stringifies to `{}`
   * and `settings.title` is not a string.
   *
   * This is invisible to a test that calls `apply()` with a raw object, because
   * no validation runs there — so the whole plugin passed its suite while the
   * live host received accessor objects. The symptom in production was precise:
   * the title row was dropped (it failed the `typeof === 'string'` filter) and
   * the AUMID reached `CreateToastNotifier` as `[object Object]`, which threw,
   * fell through every identity, and exited 0 without showing anything.
   *
   * @param field - config field name.
   * @returns the plain value, or the built-in default.
   */
  const read = (field) => {
    const raw = settings[field];
    const value = unwrapSetting(raw);
    return value === undefined ? DEFAULTS[field] : value;
  };
  const logger = ctx.logger;
  const soundEnabled = () => read('sound') !== false;
  const audit = createAudit(read('audit'), read('auditPath'), (problem) => {
    try { logger?.warn?.(`[${name}] ${problem}`); } catch { /* ignore */ }
  });

  audit.note('apply', {
    hasConfig: config !== undefined && config !== null,
    inject: JSON.stringify(inject),
    auditPath: audit.path,
  });

  /**
   * The last closed turn per session, as `{ turn, reason }`. The decisive fact
   * for a completion.
   */
  const lastTurnEnd = new Map();
  /**
   * When a goal-block notification fired per session id, so the matching
   * `turn/end` does not repeat it. See {@link goalBlockJustAnnounced}.
   */
  const goalBlockedAt = new Map();
  /** Status per session id, so `idle` is only reported as a transition. */
  const status = new Map();
  /** Dedupe keys with the time they last fired. */
  const fired = new Map();

  function report(problem) {
    try {
      logger?.warn?.(`[${name}] ${problem}`);
    } catch {
      /* a broken logger must never break a notification path */
    }
  }

  function emit(title, lines) {
    try {
      const focus = read('focusOnClick') !== false;
      const body = [title, ...lines].filter((line) => typeof line === 'string' && line.length > 0);
      audit.note('deliver', { lines: body, aumid: read('aumid') });
      const child = notifier({
        lines: body,
        sound: soundEnabled(),
        scenario: 'reminder',
        aumid: read('aumid'),
        powershellPath: read('powershellPath'),
        // Clicking the toast re-focuses the desktop window; an empty URI leaves
        // it click-inert.
        launch: focus ? read('activationUri') : '',
      }, report);
      if (child !== undefined && typeof child.on === 'function') {
        child.on('close', (code) => audit.note('delivered', { code }));
      }
    } catch (error) {
      audit.note('error', { seam: 'emit', message: String(error) });
      report(`could not raise a notification: ${String(error)}`);
    }
  }

  /**
   * Whether a completion for this session is worth interrupting for.
   *
   * A goal that is still armed drives its own next round the moment the agent
   * goes idle, so a per-round notification would fire once per round for up to
   * `maxGoalRounds` rounds. While such a goal is live the round ends are
   * suppressed and the goal's own stop (`goal/changed` → `blocked`) is what
   * tells you the automatic work actually stopped.
   *
   * @param agent - the root agent that went idle.
   * @returns true when this idle transition should not be announced.
   */
  function goalStillDriving(agent) {
    if (read('suppressWhileGoalActive') === false) return false;
    const goals = ctx.get('goals');
    if (goals === undefined) return false;
    try {
      const goal = goals.get(agent);
      return goal?.phase === 'active' && goal.activation === 'armed';
    } catch {
      return false;
    }
  }

  /**
   * Whether a goal block was announced for this session inside the dedupe
   * window, meaning a `turn/end` of reason `blocked` right now is that same
   * event and would be a second toast for it.
   *
   * This is deliberately keyed on the same `dedupeMs` window as every other
   * suppression rather than on a turn number: `GoalChanged` exposes only
   * `operation`, `ref`, and `goal` (whose `GoalView` has `roundsStarted` but no
   * turn), so the turn the block came from is not observable from this event.
   * A window is the honest key available; the cost of a miss is one extra toast
   * in a rare case, and the cost of a false positive would need a user to
   * finish a *different* blocked turn within two seconds of a goal block.
   *
   * @param id - the session id.
   * @returns true when a blocked turn-end should stay quiet.
   */
  function goalBlockJustAnnounced(id) {
    const at = goalBlockedAt.get(id);
    if (at === undefined) return false;
    const window = Number(read('dedupeMs'));
    // A non-positive window disables dedupe everywhere else in this plugin, so
    // it must disable this suppression too rather than suppress unconditionally.
    if (!Number.isFinite(window) || window <= 0) return false;
    return Date.now() - at <= window;
  }

  /** An agent's session title, via the optional `sessionTitle` service. */
  function sessionLabel(agent) {    const sessionTitle = ctx.get('sessionTitle');
    try {
      const snapshot = sessionTitle?.get?.(agent?.session);
      const title = snapshot?.title;
      if (typeof title === 'string' && title.length > 0) return clip(title, 60);
    } catch {
      /* a session whose log cannot be folded simply has no title yet */
    }
    const id = agent?.id;
    return typeof id === 'string' && id.length > 0 ? `会话 ${id.slice(0, 8)}` : '当前会话';
  }

  /** Whether an agent is a human-facing root rather than a delegated child. */
  function isReportable(agent) {
    if (read('includeSubagents') === true) return true;
    try {
      return agent?.session?.header?.origin !== 'subagent';
    } catch {
      return true;
    }
  }

  /**
   * Fire at most once per (kind, subject) inside the dedupe window, so one
   * completion reported by two seams — or a hot reload — is one notification.
   *
   * @param key - the dedupe identity.
   * @returns true when the caller should notify.
   */
  function firstTime(key) {
    const window = Number(read('dedupeMs'));
    const now = Date.now();
    const previous = fired.get(key);
    if (Number.isFinite(window) && window > 0 && previous !== undefined && now - previous < window) return false;
    fired.set(key, now);
    if (fired.size > 256) {
      for (const [candidate, at] of fired) if (now - at > 60_000) fired.delete(candidate);
    }
    return true;
  }

  /**
   * Listen for one host event, bypassing scope admission.
   *
   * `global: true` is load-bearing, not an optimisation. Cordis resolves a
   * dispatch with:
   *
   *   filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx))
   *
   * so `hook.global` short-circuits the scope filter entirely. Without it a
   * listener is admitted only when the dispatching carrier is descended from
   * the listening context's scope chain — and the live composition is not the
   * flat tree a unit test builds: `agent/status` is dispatched with an agent
   * carrier while `session/event` carries a *session* scope, and the profile
   * composes `isolate` groups. The built-in `@deepseek-ai/dsh-session-title`
   * registers its `llm/stream` listener with exactly this option for the same
   * reason. If either seam silently misses, a completion produces no toast
   * while every part still looks correct.
   *
   * @param event - host event name.
   * @param handler - listener.
   * @returns the disposer.
   */
  function listen(event, handler) {
    return ctx.on(event, handler, { global: true });
  }

  const offStatus = listen('agent/status', (payload) => {
    try {
      const agent = payload?.agent;
      const next = payload?.status;
      const id = agent?.id;
      if (typeof id !== 'string') {
        audit.note('skip', { seam: 'agent/status', why: 'no-agent-id' });
        return;
      }
      const previous = status.get(id);
      status.set(id, next);
      if (next !== 'idle' || previous !== 'running') {
        audit.note('skip', { seam: 'agent/status', why: 'not-running-to-idle', id, next, previous });
        return;
      }
      if (read('enabled') === false || read('onTurnEnd') === false) {
        audit.note('skip', { seam: 'agent/status', why: 'disabled', id });
        return;
      }
      if (!isReportable(agent)) {
        audit.note('skip', { seam: 'agent/status', why: 'subagent', id });
        return;
      }
      const ended = lastTurnEnd.get(id);
      lastTurnEnd.delete(id);
      const described = describeTurnEnd(ended?.reason);
      if (described === undefined) {
        audit.note('skip', {
          seam: 'agent/status',
          why: 'no-usable-turn-end',
          id,
          sawTurnEnd: ended !== undefined,
          reason: ended?.reason?.kind ?? null,
        });
        return;
      }
      if (goalStillDriving(agent)) {
        audit.note('skip', { seam: 'agent/status', why: 'goal-still-driving', id });
        return;
      }
      /* A goal that blocked just now already announced itself with its reason;
       * the blocked `turn/end` that follows carries nothing new. Only a
       * `blocked` reason is suppressed: a `completed` or `error` turn is a
       * genuinely different outcome and must still be reported even when it
       * happens to close inside the same window. */
      if (ended?.reason?.kind === 'blocked' && goalBlockJustAnnounced(id)) {
        audit.note('skip', { seam: 'agent/status', why: 'goal-block-already-announced', id });
        return;
      }
      if (!firstTime(`turn:${id}`)) {
        audit.note('skip', { seam: 'agent/status', why: 'deduped', id });
        return;
      }
      audit.note('notify', { seam: 'agent/status', id, kind: ended?.reason?.kind });
      emit(read('title'), [described.outcome, sessionLabel(agent)]);
    } catch (error) {
      audit.note('error', { seam: 'agent/status', message: String(error) });
      report(`agent/status observer failed: ${String(error)}`);
    }
  });

  const offSession = listen('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return;
      const id = session?.id;
      if (typeof id !== 'string') return;
      lastTurnEnd.set(id, { turn: event.data?.turn, reason: event.data?.reason });
      audit.note('observed', { seam: 'session/event', id, turn: event.data?.turn, reason: event.data?.reason?.kind });
    } catch (error) {
      report(`session/event observer failed: ${String(error)}`);
    }
  });

  const offDisposed = listen('agent/disposed', ({ agent } = {}) => {
    const id = agent?.id;
    if (typeof id !== 'string') return;
    lastTurnEnd.delete(id);
    goalBlockedAt.delete(id);
    status.delete(id);
  });

  /**
   * Announce a parked question, then hand the waterfall on untouched.
   * Swallowing the request here would leave the tool call waiting forever.
   */
  const offQuestion = listen('user-questions/request', (request, next) => {
    try {
      if (read('enabled') !== false && read('onQuestion') !== false) {
        const agent = request?.agent;
        if (isReportable(agent) && firstTime(`question:${agent?.id ?? 'unknown'}`)) {
          const first = request?.questions?.[0];
          // `question` is required by the tool schema but an empty string is
          // still possible, and `??` would keep it — fall back on emptiness.
          const text = first?.question || first?.header;
          emit(read('title'), [
            text ? `正在问你：${oneLine(text, 120)}` : 'Agent 正在等你回答',
            sessionLabel(agent),
          ]);
        }
      }
    } catch (error) {
      report(`question notification failed: ${String(error)}`);
    }
    return next();
  });

  /** Announce a parked approval, then continue the approval chain unchanged. */
  const offApproval = listen('approval/request', (request, next) => {
    try {
      if (read('enabled') !== false && read('onApproval') !== false) {
        const agent = request?.agent;
        if (isReportable(agent) && firstTime(`approval:${agent?.id ?? 'unknown'}:${request?.toolName ?? ''}`)) {
          const reason = request?.displayReason?.zh ?? request?.displayReason?.en ?? request?.reason;
          const tool = request?.toolName;
          emit(read('title'), [
            `等待你的审批${tool ? `：${oneLine(tool, 60)}` : ''}`,
            reason ? oneLine(reason, 120) : sessionLabel(agent),
          ]);
        }
      }
    } catch (error) {
      report(`approval notification failed: ${String(error)}`);
    }
    return next();
  });

  /** A blocked goal is the point at which automatic rounds actually stopped. */
  const offGoal = listen('goal/changed', ({ agent, change } = {}) => {
    try {
      if (read('enabled') === false || read('onGoalBlock') === false) return;
      if (change?.operation !== 'block') return;
      if (!isReportable(agent)) return;
      const id = agent?.id;
      if (typeof id !== 'string') return;
      goalBlockedAt.set(id, Date.now());
      if (!firstTime(`goal:${id}`)) return;
      const reason = change?.goal?.blockedReason?.message;
      emit(read('title'), [
        `目标受阻${reason ? `：${oneLine(reason, 120)}` : ''}`,
        sessionLabel(agent),
      ]);
    } catch (error) {
      report(`goal notification failed: ${String(error)}`);
    }
  });

  /* `/session-toast` — prove the channel end to end without waiting for a turn.
   * Registered through `ctx.inject` rather than read eagerly, because this entry
   * declares no hard dependency and may well be applied before the command
   * registry exists. */
  const offCommand = ctx.inject(['commands'], (commandCtx) => commandCtx.commands.register({
    name: 'session-toast',
    description: 'Send a test Windows notification from dsh-session-toast',
    handler: () => {
      if (read('enabled') === false) return { kind: 'error', text: 'dsh-session-toast is disabled in its settings.' };
      emit(read('title'), ['这是一条测试通知', 'dsh-session-toast 已完成配置并可以弹窗']);
      return { kind: 'success', text: 'Test notification sent. Check your Windows notification center.' };
    },
  }));

  ctx.effect(() => () => {
    offStatus?.();
    offSession?.();
    offDisposed?.();
    offQuestion?.();
    offApproval?.();
    offGoal?.();
    offCommand?.();
    lastTurnEnd.clear();
    goalBlockedAt.clear();
    status.clear();
    fired.clear();
  }, `${name}: listeners`);
}
