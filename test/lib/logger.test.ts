import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger';

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function setIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

describe('logger', () => {
  beforeEach(() => {
    setIsTTY(false);
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('LOG_LEVEL', undefined);
  });

  afterEach(() => {
    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY');
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prints plain messages with log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.log('hello');
    expect(log).toHaveBeenCalledWith('hello');
  });

  it('prefixes messages with a level label', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.info('a');
    logger.success('b');
    logger.warn('c');
    logger.error('d');

    expect(log).toHaveBeenCalledWith(' INFO ', 'a');
    expect(log).toHaveBeenCalledWith(' SUCCESS ', 'b');
    expect(warn).toHaveBeenCalledWith(' WARN ', 'c');
    expect(error).toHaveBeenCalledWith(' ERROR ', 'd');
  });

  it('only prints debug messages when LOG_LEVEL is debug', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    logger.debug('hidden');
    expect(debug).not.toHaveBeenCalled();

    vi.stubEnv('LOG_LEVEL', 'debug');
    logger.debug('shown');
    expect(debug).toHaveBeenCalledWith(' DEBUG ', 'shown');
  });

  it('colors labels on a TTY', () => {
    setIsTTY(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('a');

    expect(log).toHaveBeenCalledWith('\u001B[30;44m INFO \u001B[0m', 'a');
  });

  it('respects NO_COLOR', () => {
    setIsTTY(true);
    vi.stubEnv('NO_COLOR', '1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('a');

    expect(log).toHaveBeenCalledWith(' INFO ', 'a');
  });
});
