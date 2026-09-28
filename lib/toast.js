/**
 * dsh-session-toast — Windows toast delivery.
 *
 * One job: turn (title line, body lines) into a native Windows toast, out of
 * process, without any dependency. The whole PowerShell program is shipped as
 * one `-EncodedCommand` (UTF-16LE base64), so no argument quoting, locale, or
 * code-page question can corrupt the notification text — every dynamic string
 * travels as its own base64 payload and is decoded inside PowerShell.
 *
 * Why PowerShell and not a native module, `node-notifier`, or BurntToast:
 *  - `powershell.exe` (Windows PowerShell 5.1) is present on every supported
 *    Windows, and it is the only shell that can project the WinRT
 *    `ToastNotificationManager` type directly. `pwsh` (7.x) cannot without the
 *    extra `Microsoft.Windows.SDK.NET` assemblies.
 *  - `node-notifier` and BurntToast are install-time dependencies on a global
 *    module and a PowerShell module respectively. Neither is required here.
 *
 * Identity: a non-packaged process may only raise a toast under an
 * AppUserModelID that Windows has already registered. The desktop shell
 * registers `com.deepseek.dsh` (its Start Menu shortcut carries the id, which
 * is what also supplies the DeepSeek Harness name and whale icon on the
 * banner), so that id is the default. The registered Windows PowerShell id is
 * kept as a fallback so the notification still lands on a machine where the
 * shell has never run — it then shows as "Windows PowerShell", which is worse
 * than the real identity but better than silence.
 *
 * @module dsh-session-toast/toast
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/** AUMID the DeepSeek Harness desktop shell registers at first launch. */
export const DSH_AUMID = 'com.deepseek.dsh';

/** AUMID Windows registers for Windows PowerShell 5.1; the last-resort identity. */
export const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * URI that brings the DeepSeek Harness desktop window to the front when a toast
 * is clicked.
 *
 * The desktop shell registers the `dsh` protocol for exactly this:
 * `app.setAsDefaultProtocolClient("dsh")` writes
 * `HKCU\Software\Classes\dsh\shell\open\command` →
 * `"...\DeepSeek Harness.exe" "%1"`, and its `open-url` handler answers
 * `dsh://open` with `focusPrimaryWindow()` (restore if minimized, show, focus).
 *
 * Opening the protocol therefore launches a second process, which immediately
 * finds the single-instance lock taken, calls `app.quit()`, and hands off
 * through the `second-instance` event — which is wired to the same focus
 * handler. Either path ends with the existing window in front, and no second
 * window is created.
 *
 * The deep link carries no session id: the shell's `open-url` handler compares
 * the URL against the literal `dsh://open` and ignores anything else, so there
 * is no supported way for a toast to land on one specific session. Clicking
 * re-focuses the app, nothing more. The plugin's notification body names the
 * session instead.
 */
export const DSH_ACTIVATION_URI = 'dsh://open';

/** Absolute path of the Windows PowerShell 5.1 that owns the WinRT projection. */
export function defaultPowershellPath() {
  const windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
  return join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Base64 of a UTF-8 string; the payload transport for every dynamic value. */
function payload(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

/**
 * Build the PowerShell program that raises one toast.
 *
 * Every interpolation point is a base64 payload, so the only characters this
 * template ever contains literally are its own PowerShell syntax.
 *
 * @param input - toast content and delivery options.
 * @returns the PowerShell source to encode.
 */
function toastProgram(input) {
  const scenario = input.scenario === 'reminder' ? 'reminder' : 'default';
  const icon = typeof input.iconPath === 'string' && input.iconPath.length > 0 && existsSync(input.iconPath)
    ? 'file:///' + input.iconPath.replace(/\\/g, '/')
    : '';
  const aumids = [input.aumid ?? DSH_AUMID, POWERSHELL_AUMID];
  const textsJson = JSON.stringify(input.lines);
  const launch = typeof input.launch === 'string' ? input.launch.trim() : '';

  return `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
function B64([string]$v) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }
function X([string]$s) { $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;') }
$lines = @()
$raw = B64 '${payload(textsJson)}'
foreach ($line in ($raw | ConvertFrom-Json)) { if ($line -ne $null -and ([string]$line).Length -gt 0) { $lines += ('<text>' + (X ([string]$line)) + '</text>') } }
if ($lines.Count -eq 0) { exit 2 }
$image = ''
$iconValue = B64 '${payload(icon)}'
if ($iconValue.Length -gt 0) { $image = '<image placement="appLogoOverride" hint-crop="circle" src="' + (X $iconValue) + '"/>' }
$audio = ''
if ((B64 '${payload(input.sound === false ? '0' : '1')}') -eq '1') { $audio = '<audio src="ms-winsoundevent:Notification.Default" loop="false"/>' }
$scenarioAttribute = ''
if ((B64 '${payload(scenario)}') -eq 'reminder') { $scenarioAttribute = ' scenario="reminder"' }
$activationAttribute = ''
$launchValue = B64 '${payload(launch)}'
if ($launchValue.Length -gt 0) { $activationAttribute = ' activationType="protocol" launch="' + (X $launchValue) + '"' }
$xml = '<toast' + $scenarioAttribute + $activationAttribute + '><visual><binding template="ToastGeneric">' + $image + ($lines -join '') + '</binding></visual>' + $audio + '</toast>'
$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$document.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($document)
$identities = @()
foreach ($candidate in @('${aumids.map((id) => payload(id)).join("', '")}')) { $value = B64 $candidate; if ($value.Length -gt 0) { $identities += $value } }
$shown = $false
foreach ($identity in $identities) {
  try { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($identity).Show($toast); $shown = $true; break } catch { }
}
if (-not $shown) { exit 3 }
`.trim();
}

/**
 * Raise one toast. Fire-and-forget: the child is detached and unref'd, so a
 * harness exit or crash never truncates delivery, and a failure never surfaces
 * as an exception into the event that asked for it.
 *
 * @param input - toast content and delivery options.
 * @param input.lines - the toast text lines, first one bold.
 * @param input.sound - whether to play the default notification sound.
 * @param input.scenario - `default`, or `reminder` to keep the banner up.
 * @param input.aumid - AppUserModelID to raise the toast under.
 * @param input.iconPath - optional PNG to override the identity's icon.
 * @param input.powershellPath - optional explicit PowerShell executable.
 * @param input.launch - URI to open when the toast is clicked, e.g.
 *   `dsh://open`. Empty leaves the toast click-inert. See {@link DSH_ACTIVATION_URI}.
 * @param input.wait - await the child's exit before resolving. The plugin never
 *   does this; the smoke script needs it to report an exit code.
 * @param input.onError - called with a diagnostic when delivery cannot start.
 * @returns the child process, or undefined when it could not be spawned.
 *
 * ## Why this spawns with `detached: false` and `unref()`s instead
 *
 * The obvious way to make a fire-and-forget helper outlive its parent is
 * `detached: true`. On Windows that silently breaks the notification: the
 * Action Center history (read through `ToastNotificationManager.History`,
 * which is the only trustworthy oracle here — the `LastNotificationAddedTime`
 * registry value moves even for toasts that never reached the screen) records
 * **no toast at all** from a detached child, while the child still exits 0.
 * Its environment leaves no Window Station/desktop association, and the WinRT
 * toast API then fails in a way that reports success.
 *
 * `detached: false` with `unref()` gives what was actually wanted: the parent
 * does not wait for the child, the event loop does not stay alive for it, and
 * the toast lands. The child is deliberately left attached to this process's
 * console-less stdio so it keeps the desktop association it needs.
 */
export function showToast(input, onError) {
  return spawnToast(input, onError, true);
}

/**
 * Raise one toast and await the delivery process's exit code.
 *
 * @param input - as {@link showToast}.
 * @returns the exit code, or undefined when the process could not be started.
 *   0 means Windows accepted the toast, 2 that the program found no text,
 *   3 that no registered identity accepted it.
 */
export async function showToastAndWait(input) {
  let failure;
  // Keep this child referenced: an unref'd one lets the event loop drain before
  // `close` fires, so the caller could never observe the exit code.
  const child = spawnToast(input, (problem) => { failure = problem; }, false);
  if (child === undefined) return undefined;
  const code = await new Promise((resolve) => child.on('close', (exitCode) => resolve(exitCode)));
  if (code === 0) return 0;
  return failure === undefined ? (code ?? 1) : (code ?? 1);
}

/**
 * One spawn site for every caller, so the `detached: false` invariant below
 * cannot drift between the plugin and the smoke script.
 *
 * @param input - toast content and delivery options.
 * @param onError - diagnostic sink for a failure to start.
 * @param unref - release the child from this process's event loop. The plugin
 *   always wants this; an awaiting caller must not.
 * @returns the child, or undefined when it could not be spawned.
 */
function spawnToast(input, onError, unref) {
  const powershell = input.powershellPath && input.powershellPath.length > 0
    ? input.powershellPath
    : defaultPowershellPath();
  const program = toastProgram(input);
  const encoded = Buffer.from(program, 'utf16le').toString('base64');
  let child;
  try {
    child = spawn(
      powershell,
      ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: process.env, windowsHide: true, stdio: 'ignore', detached: false },
    );
  } catch (error) {
    onError?.(`could not launch ${powershell}: ${String(error)}`);
    return undefined;
  }
  child.on('error', (error) => onError?.(`notification process error: ${String(error)}`));
  if (unref) child.unref();
  return child;
}
