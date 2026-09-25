const process = require('node:process');
const esbuild = require('esbuild');

// `setup` and `post` are referenced by action.yml, `cli` is the `turbogha` binary.
esbuild
  .build({
    entryPoints: [
      { in: './src/index.ts', out: 'setup/index' },
      { in: './src/post.ts', out: 'post/index' },
      { in: './src/cli.ts', out: 'cli/index' },
    ],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outdir: 'dist',
    format: 'esm',
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __createRequire } from 'node:module';",
        "import { fileURLToPath as __fileURLToPath } from 'node:url';",
        "import { dirname as __pathDirname } from 'node:path';",
        'const require = __createRequire(import.meta.url);',
        'const __filename = __fileURLToPath(import.meta.url);',
        'const __dirname = __pathDirname(__filename);',
      ].join('\n'),
    },
    sourcemap: false,
    tsconfig: 'tsconfig.build.json',
    logLevel: 'info',
  })
  .catch(() => process.exit(1));
