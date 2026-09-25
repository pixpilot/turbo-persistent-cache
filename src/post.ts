import { readFile } from 'node:fs/promises';
import { serverLogFile } from './lib/constants';
import { core } from './lib/core';
import { readActualPort } from './lib/server/utils';

//* Short timeout: in post hook the port file either exists already or never will
const PORT_FILE_TIMEOUT_MS = 500;

/**
 * The out script for the action.
 */
async function post(): Promise<void> {
  try {
    //* Read the actual port (supports port 0 auto-assignment)
    const actualPort = readActualPort(PORT_FILE_TIMEOUT_MS);

    //* Kill the server
    const response = await fetch(`http://localhost:${actualPort}/shutdown`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      core.warning(
        `Cache server shutdown returned ${response.status}: ${await response.text()}`,
      );
    }

    //* Read the logs
    const logs = await readFile(serverLogFile, 'utf-8');
    //* Print the logs
    core.info(logs);
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}

// Run the out script
void post();
