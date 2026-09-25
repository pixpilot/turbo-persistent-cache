import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/main';

const mocks = vi.hoisted(() => ({
  server: vi.fn(),
  launchServer: vi.fn(),
  setFailed: vi.fn(),
}));

vi.mock('../src/lib/server', () => ({ server: mocks.server }));
vi.mock('../src/lib/server/utils', () => ({ launchServer: mocks.launchServer }));
vi.mock('../src/lib/core', () => ({ core: { setFailed: mocks.setFailed } }));

const originalArgv = process.argv;

describe('run', () => {
  beforeEach(() => {
    process.argv = ['node', 'dist/setup/index.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.resetAllMocks();
  });

  it('launches the background server', async () => {
    await run();

    expect(mocks.launchServer).toHaveBeenCalledTimes(1);
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it('runs the server itself in the daemon process', async () => {
    process.argv = ['node', 'dist/setup/index.js', '--server'];

    await run();

    expect(mocks.server).toHaveBeenCalledTimes(1);
    expect(mocks.launchServer).not.toHaveBeenCalled();
  });

  it('fails the step when the server cannot start', async () => {
    mocks.launchServer.mockRejectedValue(new Error('EADDRINUSE'));

    await run();

    expect(mocks.setFailed).toHaveBeenCalledWith('EADDRINUSE');
  });

  it('ignores non-Error rejections', async () => {
    mocks.launchServer.mockRejectedValue('boom');

    await run();

    expect(mocks.setFailed).not.toHaveBeenCalled();
  });
});
