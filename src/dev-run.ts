// Run the server in foreground and kill it after the test

import { config } from 'dotenv';

import { server } from './lib/server';
import { launchServer } from './lib/server/utils';

config({ quiet: true });

async function main(): Promise<void> {
  //* Run server
  void server();
  //* Run launch server
  await launchServer(true);
}

void main();
