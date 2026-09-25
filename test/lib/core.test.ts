import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadCore(ci: boolean) {
  vi.stubEnv('CI', ci ? 'true' : 'false');
  vi.resetModules();
  const actionsCore = await import('@actions/core');
  const { logger } = await import('../../src/lib/logger');
  const { core } = await import('../../src/lib/core');
  return { actionsCore, logger, core };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('core in CI', () => {
  it('delegates to @actions/core', async () => {
    const { actionsCore, core } = await loadCore(true);
    vi.mocked(actionsCore.getInput).mockReturnValue('github');

    expect(core.isCI).toBe(true);
    expect(core.getInput('provider')).toBe('github');
    core.setFailed('failed');
    core.exportVariable('NAME', 'value');
    core.info('info');
    core.warning('warning');
    core.error('error');
    core.debug('debug');
    core.log('log');
    core.success('success');

    expect(actionsCore.getInput).toHaveBeenCalledWith('provider');
    expect(actionsCore.setFailed).toHaveBeenCalledWith('failed');
    expect(actionsCore.exportVariable).toHaveBeenCalledWith('NAME', 'value');
    expect(actionsCore.warning).toHaveBeenCalledWith('warning');
    expect(actionsCore.error).toHaveBeenCalledWith('error');
    expect(actionsCore.debug).toHaveBeenCalledWith('debug');
    expect(vi.mocked(actionsCore.info).mock.calls).toEqual([
      ['info'],
      ['log'],
      ['success'],
    ]);
  });
});

describe('core outside CI', () => {
  it('uses the local logger and ignores action inputs', async () => {
    const { actionsCore, logger, core } = await loadCore(false);
    const spies = {
      error: vi.spyOn(logger, 'error').mockImplementation(() => undefined),
      info: vi.spyOn(logger, 'info').mockImplementation(() => undefined),
      warn: vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
      debug: vi.spyOn(logger, 'debug').mockImplementation(() => undefined),
      log: vi.spyOn(logger, 'log').mockImplementation(() => undefined),
      success: vi.spyOn(logger, 'success').mockImplementation(() => undefined),
    };

    expect(core.isCI).toBe(false);
    expect(core.getInput('provider')).toBeUndefined();
    core.setFailed('failed');
    core.exportVariable('NAME', 'value');
    core.info('info');
    core.warning('warning');
    core.error('error');
    core.debug('debug');
    core.log('log');
    core.success('success');

    expect(actionsCore.getInput).not.toHaveBeenCalled();
    expect(actionsCore.exportVariable).not.toHaveBeenCalled();
    expect(spies.error.mock.calls).toEqual([['failed'], ['error']]);
    expect(spies.info).toHaveBeenCalledWith('info');
    expect(spies.warn).toHaveBeenCalledWith('warning');
    expect(spies.debug).toHaveBeenCalledWith('debug');
    expect(spies.log).toHaveBeenCalledWith('log');
    expect(spies.success).toHaveBeenCalledWith('success');
  });
});
