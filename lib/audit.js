/**
 * dsh-session-toast — diagnostic audit log.
 *
 * The live desktop host gives a plugin no observable channel: its stdout is a
 * pipe to the Electron shell (never a file) and the host process has no
 * inspector port. When a notification silently fails to appear, there is
 * therefore no way to tell whether the plugin's listeners never ran, ran and
 * took a suppressing branch, or ran and failed at delivery.
 *
 * This module closes that gap: one append-only JSONL line per decision point,
 * so a single restart answers the question from outside the process.
 *
 * It is strictly best-effort. Every operation is wrapped: an audit failure must
 * never affect a notification, and must never surface into the host.
 *
 * @module dsh-session-toast/audit
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/** Default log path: `%TEMP%\dsh-session-toast.log` on Windows, else the temp dir. */
export function defaultAuditPath() {
  return join(tmpdir(), 'dsh-session-toast.log');
}

/**
 * Create the audit sink.
 *
 * @param enabled - whether to record anything at all.
 * @param file - explicit log path; empty uses {@link defaultAuditPath}.
 * @param onProblem - diagnostic sink for a failure to write.
 * @returns `{ note, path, drop }` — `note(stage, data)` records one line.
 */
export function createAudit(enabled, file, onProblem) {
  const path = typeof file === 'string' && file.length > 0 ? file : defaultAuditPath();
  if (enabled === false) return { note() {}, path, drop() {} };

  let prepared = false;
  let broken = false;

  return {
    path,
    /**
     * Record one decision point.
     *
     * @param stage - short stable label, e.g. `apply` or `skip`.
     * @param data - small JSON-serializable context; never large payloads.
     */
    note(stage, data) {
      if (broken) return;
      try {
        if (!prepared) {
          mkdirSync(dirname(path), { recursive: true });
          prepared = true;
        }
        appendFileSync(path, `${JSON.stringify({
          t: new Date().toISOString(),
          pid: process.pid,
          stage,
          ...(data ?? {}),
        })}\n`);
      } catch (error) {
        // Give up after one failure: a broken log must not cost a toast.
        broken = true;
        onProblem?.(`audit log disabled: ${String(error)}`);
      }
    },
    drop() {},
  };
}
