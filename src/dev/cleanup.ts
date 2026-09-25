import { config } from 'dotenv';

import { cleanup } from '../lib/server/cleanup';
import { getTracker } from '../lib/tracker';

config({ quiet: true });

async function main(): Promise<void> {
  await cleanup(
    {
      log: {
        // eslint-disable-next-line no-console
        info: console.log,
      },
    },
    getTracker(),
  );
}

void main();
