// @ts-check
/** How the installer was started, so messages name the command people actually run. */

/** Set by AnalyticsHubInstaller.exe, which runs the installer with the Node.js it carries. */
export const EXE_ENV = 'ANALYTICS_HUB_EXE';
export const EXE_NAME = 'AnalyticsHubInstaller.exe';

/**
 * Whether the installer was started from the downloaded exe.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const fromExe = (env = process.env) => env[EXE_ENV] === '1';

/**
 * The command to run the installer with, optionally followed by its arguments.
 * @param {string} [args]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function commandLine(args = '', env = process.env) {
  const name = fromExe(env) ? EXE_NAME : 'valuelens-install';
  return args ? `${name} ${args}` : name;
}

/**
 * Where the installer prints its messages and the wizard link.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const installerWindow = (env = process.env) => (fromExe(env) ? 'the installer window' : 'your terminal');
