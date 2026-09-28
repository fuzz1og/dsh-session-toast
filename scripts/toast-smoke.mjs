/**
 * Real-toast smoke test: raise one notification through the same delivery path
 * the plugin uses, and report the child's exit status.
 *
 * This does not need DSH, a harness, or a network — only Windows. Run it after
 * installing the plugin, or to check the channel before installing at all:
 *
 *   node scripts/toast-smoke.mjs
 *
 * Exit codes: 0 the toast was raised, 2 the PowerShell program found no text
 * lines, 3 the toast could not be raised under any registered identity.
 */

import { existsSync } from 'node:fs';
import { showToast, defaultPowershellPath, DSH_AUMID } from '../lib/toast.js';

const powershell = defaultPowershellPath();

if (process.platform !== 'win32') {
  console.error(`dsh-session-toast: this channel is Windows-only (running on ${process.platform}).`);
  process.exit(1);
}
if (!existsSync(powershell)) {
  console.error(`dsh-session-toast: Windows PowerShell 5.1 not found at ${powershell}.`);
  process.exit(1);
}

console.log(`powershell: ${powershell}`);
console.log(`aumid:      ${DSH_AUMID}`);

const child = showToast({
  lines: ['dsh-session-toast', '测试通知：通道正常', '这条通知由 smoke 脚本发出'],
  sound: true,
  scenario: 'reminder',
  powershellPath: powershell,
  detach: false,
}, (problem) => console.error(`delivery problem: ${problem}`));

if (child === undefined) {
  console.error('dsh-session-toast: the notification process could not be started.');
  process.exit(1);
}

const { code } = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
if (code === 0) {
  console.log('toast raised — check the Windows notification center.');
  process.exit(0);
}
console.error(code === 3
  ? 'no registered identity accepted the toast; is the notification banner suppressed by Focus Assist?'
  : `the notification program exited with code ${String(code)}.`);
process.exit(code ?? 1);
