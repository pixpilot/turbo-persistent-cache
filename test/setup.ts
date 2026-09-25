import { vi } from 'vitest';

// Never talk to the real GitHub Actions runtime from unit tests. Without these
// mocks `core.setFailed` would set `process.exitCode` when tests run in CI.
vi.mock('@actions/core');
vi.mock('@actions/cache');
