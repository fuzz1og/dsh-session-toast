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
$xml = '<toast' + $scenarioAttribute + '><visual><binding template="ToastGeneric">' + $image + ($lines -join '') + '</binding></visual>' + $audio + '</toast>'
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
 * @param input.detach - detach and unref the child (default true). Set false to
 *   keep the process attached so the caller can await its exit code, which is
 *   what the smoke script needs and the plugin never does.
 * @param input.onError - called with a diagnostic when delivery cannot start.
 * @returns the child process, or undefined when it could not be spawned.
 */
export function showToast(input, onError) {
  const powershell = input.powershellPath && input.powershellPath.length > 0
    ? input.powershellPath
    : defaultPowershellPath();
  const detach = input.detach !== false;
  const program = toastProgram(input);
  const encoded = Buffer.from(program, 'utf16le').toString('base64');
  let child;
  try {
    child = spawn(
      powershell,
      ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: process.env, windowsHide: true, stdio: 'ignore', detached: detach },
    );
  } catch (error) {
    onError?.(`could not launch ${powershell}: ${String(error)}`);
    return undefined;
  }
  child.on('error', (error) => onError?.(`notification process error: ${String(error)}`));
  if (detach) child.unref();
  return child;
}
