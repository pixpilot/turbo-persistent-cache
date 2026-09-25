/* eslint-disable no-console -- this module is the console logger used outside of GitHub Actions */
import process from 'node:process';

const BG_RED = 41;
const BG_GREEN = 42;
const BG_YELLOW = 43;
const BG_BLUE = 44;
const BG_MAGENTA = 45;

function supportsColor(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

function label(text: string, background: number): string {
  const padded = ` ${text} `;
  return supportsColor() ? `\u001B[30;${background}m${padded}\u001B[0m` : padded;
}

/**
 * Minimal console logger for local (non-CI) runs. Debug output is only printed
 * when `LOG_LEVEL=debug`.
 */
export const logger = {
  log: (message: string): void => {
    console.log(message);
  },
  info: (message: string): void => {
    console.log(label('INFO', BG_BLUE), message);
  },
  success: (message: string): void => {
    console.log(label('SUCCESS', BG_GREEN), message);
  },
  warn: (message: string): void => {
    console.warn(label('WARN', BG_YELLOW), message);
  },
  error: (message: string): void => {
    console.error(label('ERROR', BG_RED), message);
  },
  debug: (message: string): void => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(label('DEBUG', BG_MAGENTA), message);
    }
  },
};
