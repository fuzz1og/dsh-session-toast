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
import { showToast, DSH_AUMID } from './toast.js';

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
  const read = (field) => {
    const value = settings[field];
    return value === undefined ? DEFAULTS[field] : value;
  };
  const logger = ctx.logger;
  const soundEnabled = () => read('sound') !== false;

  /** Latest `turn/end` reason per session id; the decisive fact for a completion. */
  const lastTurnEnd = new Map();
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
      notifier({
        lines: [title, ...lines].filter((line) => typeof line === 'string' && line.length > 0),
        sound: soundEnabled(),
        scenario: 'reminder',
        aumid: read('aumid'),
        powershellPath: read('powershellPath'),
      }, report);
    } catch (error) {
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

  /** An agent's session title, via the optional `sessionTitle` service. */
  function sessionLabel(agent) {
    const sessionTitle = ctx.get('sessionTitle');
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

  const offStatus = ctx.on('agent/status', (payload) => {
    try {
      const agent = payload?.agent;
      const next = payload?.status;
      const id = agent?.id;
      if (typeof id !== 'string') return;
      const previous = status.get(id);
      status.set(id, next);
      if (next !== 'idle' || previous !== 'running') return;
      if (read('enabled') === false || read('onTurnEnd') === false) return;
      if (!isReportable(agent)) return;
      const reason = lastTurnEnd.get(id);
      lastTurnEnd.delete(id);
      const described = describeTurnEnd(reason);
      if (described === undefined) return;
      if (goalStillDriving(agent)) return;
      if (!firstTime(`turn:${id}`)) return;
      emit(read('title'), [described.outcome, sessionLabel(agent)]);
    } catch (error) {
      report(`agent/status observer failed: ${String(error)}`);
    }
  });

  const offSession = ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return;
      const id = session?.id;
      if (typeof id !== 'string') return;
      lastTurnEnd.set(id, event.data?.reason);
    } catch (error) {
      report(`session/event observer failed: ${String(error)}`);
    }
  });

  const offDisposed = ctx.on('agent/disposed', ({ agent } = {}) => {
    const id = agent?.id;
    if (typeof id !== 'string') return;
    lastTurnEnd.delete(id);
    status.delete(id);
  });

  /**
   * Announce a parked question, then hand the waterfall on untouched.
   * Swallowing the request here would leave the tool call waiting forever.
   */
  const offQuestion = ctx.on('user-questions/request', (request, next) => {
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
  const offApproval = ctx.on('approval/request', (request, next) => {
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
  const offGoal = ctx.on('goal/changed', ({ agent, change } = {}) => {
    try {
      if (read('enabled') === false || read('onGoalBlock') === false) return;
      if (change?.operation !== 'block') return;
      if (!isReportable(agent) || !firstTime(`goal:${agent?.id ?? 'unknown'}`)) return;
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
    status.clear();
    fired.clear();
  }, `${name}: listeners`);
}
