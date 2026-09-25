import defineConfig from '@pixpilot/dev-config/vitest';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    coverage: {
      enabled: true,
      reportsDirectory: 'coverage',
      // Thin entrypoints that only wire modules together and run on import.
      exclude: [
        'src/index.ts',
        'src/post.ts',
        'src/cli.ts',
        'src/dev-run.ts',
        'src/dev/**',
      ],
    },
  },
});
