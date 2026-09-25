import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import waitOn from 'wait-on';
import {
  cachePath,
  cachePrefix,
  serverLogFile,
  serverPort,
  serverPortFile,
} from '../constants';
import { core } from '../core';

const DEFAULT_PORT_TIMEOUT_MS = 5000;
const PORT_POLL_INTERVAL_MS = 50;
const SERVER_START_TIMEOUT_MS = 5000;
//* Short timeout: port file either exists already or server never started
const KILL_PORT_TIMEOUT_MS = 500;
const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;
const TB = GB * KB;

function sleepSync(ms: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    ms,
  );
}

function readPortFromFile(file: string): number | undefined {
  if (!existsSync(file)) return undefined;

  const raw = readFileSync(file, 'utf-8').trim();
  const port = Number.parseInt(raw, 10);
  return !Number.isNaN(port) && port > 0 ? port : undefined;
}

/**
 * Poll for the actual port from the port file. When port 0 is configured,
 * the OS assigns an ephemeral port and the server writes it to a port file
 * after binding. This function polls synchronously with a short timeout.
 *
 * Accepts explicit overrides for testability; defaults to module-level constants.
 */
export function readActualPort(
  timeoutMs = DEFAULT_PORT_TIMEOUT_MS,
  portOverride?: number,
  portFileOverride?: string,
): number {
  const configuredPort = portOverride ?? serverPort;
  const portFile = portFileOverride ?? serverPortFile;
  if (configuredPort !== 0) return configuredPort;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readPortFromFile(portFile);
    if (port !== undefined) return port;

    // Synchronous sleep — we're in a setup-phase spin-wait, not on a hot path.
    // Atomics.wait blocks without burning CPU and, unlike spawning `sleep`, also works on Windows.
    sleepSync(PORT_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for server to write its port to ${portFile}`);
}

export async function readActualPortAsync(
  timeoutMs = DEFAULT_PORT_TIMEOUT_MS,
  portOverride?: number,
  portFileOverride?: string,
): Promise<number> {
  const configuredPort = portOverride ?? serverPort;
  const portFile = portFileOverride ?? serverPortFile;
  if (configuredPort !== 0) return configuredPort;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readPortFromFile(portFile);
    if (port !== undefined) return port;

    // eslint-disable-next-line no-await-in-loop -- polling until the port file appears
    await sleep(PORT_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for server to write its port to ${portFile}`);
}

export async function waitForServer(port?: number): Promise<void> {
  const effectivePort = port ?? serverPort;
  await waitOn({
    resources: [`http-get://localhost:${effectivePort}`],
    timeout: SERVER_START_TIMEOUT_MS,
  }).catch((e: unknown) => {
    core.error(
      `Timed out waiting for cache server on port ${effectivePort}. ` +
        `This often means the server failed to start — check the logs below for EADDRINUSE or other binding errors. ` +
        `If the port is already in use, set server-port to 0 for automatic port assignment.`,
    );
    // Surface the server log file for diagnosis
    try {
      const logs = readFileSync(serverLogFile, 'utf-8');
      core.error(`Server logs (${serverLogFile}):\n${logs}`);
    } catch {
      core.error(
        `Server log file not found at ${serverLogFile} — the server process may not have started`,
      );
    }
    throw e;
  });
}

export function exportVariable(name: string, value: string): void {
  core.exportVariable(name, value);
  core.log(`  ${name}=${value}`);
}

export async function launchServer(devRun = false): Promise<void> {
  //* Remove stale port file from a previous invocation
  try {
    rmSync(serverPortFile, { force: true });
  } catch {
    // ignore — file may not exist
  }

  if (!devRun) {
    //* Launch a detached child process to run the server
    // See: https://nodejs.org/docs/latest-v16.x/api/child_process.html#optionsdetached
    const out = openSync(serverLogFile, 'a');
    const err = openSync(serverLogFile, 'a');
    const [nodePath, scriptPath] = process.argv;
    const child = spawn(nodePath, [scriptPath, '--server'], {
      detached: true,
      stdio: ['ignore', out, err],
    });
    child.unref();
    core.log(`Cache version: ${cachePath}`);
    core.log(`Cache prefix: ${cachePrefix}`);
    core.log(`Launched child process: ${String(child.pid)}`);
    core.log(`Server log file: ${serverLogFile}`);
  }

  //* Resolve the actual port (reads port file when port 0 was requested)
  const actualPort = await readActualPortAsync();

  //* Wait for server
  await waitForServer(actualPort);
  core.info(`Server is now up and running on port ${actualPort}.`);

  //* Export the environment variables for Turbo
  if (devRun) {
    /* eslint-disable no-console */
    console.log('Execute:');
    console.log(`export TURBOGHA_PORT=${actualPort}`);
    console.log(`export TURBO_API=http://localhost:${actualPort}`);
    console.log(`export TURBO_TOKEN=turbogha`);
    console.log(`export TURBO_TEAM=turbogha`);
    /* eslint-enable no-console */
  } else {
    if (core.isCI) {
      core.info('The following environment variables are exported:');
    } else {
      core.info('You need to use the following environment variables for turbo to work:');
    }
    exportVariable('TURBOGHA_PORT', `${actualPort}`);
    exportVariable('TURBO_API', `http://localhost:${actualPort}`);
    exportVariable('TURBO_TOKEN', 'turbogha');
    exportVariable('TURBO_TEAM', 'turbogha');
  }
}

export async function killServer(): Promise<void> {
  //* Kill the server
  const actualPort = readActualPort(KILL_PORT_TIMEOUT_MS);
  await fetch(`http://localhost:${actualPort}/shutdown`, {
    method: 'DELETE',
  });
  //* Clean up the port file
  try {
    rmSync(serverPortFile, { force: true });
  } catch {
    // ignore — best-effort cleanup
  }
}

const FILE_SIZE_UNITS = new Map<string, number>([
  ['b', 1],
  ['kb', KB],
  ['mb', MB],
  ['gb', GB],
  ['tb', TB],
]);

export function parseFileSize(size: string): number {
  const match = /^(?<value>\d+)\s*(?<unit>[a-z]+)$/u.exec(size.toLowerCase());
  if (match?.groups === undefined) {
    throw new Error(`Invalid file size format: ${size}`);
  }

  const { value, unit } = match.groups as { value: string; unit: string };
  const multiplier = FILE_SIZE_UNITS.get(unit);

  if (multiplier === undefined) {
    throw new Error(`Invalid file size unit: ${unit}`);
  }

  return Number.parseInt(value, 10) * multiplier;
}
