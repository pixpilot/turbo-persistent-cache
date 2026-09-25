import { core } from './core';
import { readActualPort } from './server/utils';

//* Short timeout: port file either exists already or server never started
const PORT_FILE_TIMEOUT_MS = 500;
const PING_TIMEOUT_MS = 15_000;

interface PingResponse {
  ok: boolean;
  tests?: string[];
  error?: string;
}

export async function ping(): Promise<void> {
  try {
    const actualPort = readActualPort(PORT_FILE_TIMEOUT_MS);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      core.error('Cache provider test timed out');
      controller.abort();
    }, PING_TIMEOUT_MS);

    const response = await fetch(`http://localhost:${actualPort}/ping`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const result = (await response.json()) as PingResponse;

    if (result.ok) {
      core.success('Cache provider functionality test completed successfully');
      core.info(`Tests performed: ${(result.tests ?? []).join(', ')}`);
    } else {
      core.error(`Cache provider test failed: ${String(result.error)}`);
      throw new Error(result.error);
    }
  } catch (error) {
    core.error(`Failed to test cache provider: ${String(error)}`);
    throw error;
  }
}
