import process from 'node:process';
import { core } from './lib/core';
import { server } from './lib/server';
import { launchServer } from './lib/server/utils';

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    //* Daemon process
    if (process.argv[2] === '--server') {
      await server();
      return;
    }
    //* Base process
    await launchServer();
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}
