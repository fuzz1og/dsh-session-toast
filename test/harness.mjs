/**
 * A minimal Cordis-shaped stub, just enough to drive the plugin's seams.
 *
 * The plugin only ever calls `ctx.on`, `ctx.get`, `ctx.inject`, `ctx.effect`
 * and `ctx.logger`, so this is the whole surface it needs. Events are recorded
 * rather than dispatched, so a test can invoke one exact seam with one exact
 * payload.
 */

/** Build a stub context plus the handles a test drives it with. */
export function makeCtx() {
  const listeners = new Map();
  const services = new Map();
  const disposers = [];
  const warnings = [];
  const pendingInjects = [];

  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      debug: () => {},
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const list = listeners.get(event) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get(name) {
      return services.get(name);
    },
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : [deps];
      const run = () => {
        const child = {
          ...ctx,
          [names[0]]: services.get(names[0]),
          get: (name) => services.get(name),
          effect: ctx.effect,
          on: ctx.on,
          logger: ctx.logger,
        };
        const dispose = callback(child);
        if (typeof dispose === 'function') disposers.push({ dispose, label: `inject:${names.join(',')}` });
      };
      if (names.every((dep) => services.has(dep))) run();
      else pendingInjects.push({ names, run });
      return () => {};
    },
    effect(callback, label) {
      const dispose = callback();
      disposers.push({ dispose, label });
      return () => {};
    },
  };

  /** Publish one service, running any injection that was waiting for it. */
  const provide = (name, value) => {
    services.set(name, value);
    for (let index = pendingInjects.length - 1; index >= 0; index -= 1) {
      const pending = pendingInjects[index];
      if (!pending.names.every((dep) => services.has(dep))) continue;
      pendingInjects.splice(index, 1);
      pending.run();
    }
  };

  /** Emit one event; each handler's return value is collected. */
  const emit = (event, ...args) => (listeners.get(event) ?? []).map((handler) => handler(...args));

  /**
   * Invoke one waterfall seam the way Cordis does: each listener receives the
   * terminal `next`, and a listener that wants to delegate must call it.
   */
  const waterfall = async (event, payload, terminal) => {
    const handlers = listeners.get(event) ?? [];
    const chain = (index) => async () => {
      const handler = handlers[index];
      if (handler === undefined) return terminal();
      return handler(payload, chain(index + 1));
    };
    return chain(0)();
  };

  return {
    ctx,
    emit,
    waterfall,
    services,
    warnings,
    provide,
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    disposeAll: () => {
      for (const { dispose } of disposers) dispose?.();
      disposers.length = 0;
    },
  };
}

/** A stand-in for one live Agent with a title-bearing session header. */
export function makeAgent(id = 'session-abcdef12-3456', header = {}) {
  return { id, session: { id, header } };
}

/** A recorder that stands in for the Windows toast delivery. */
export function makeNotifier() {
  const sent = [];
  const notify = (input) => sent.push(input);
  return { sent, notify };
}
