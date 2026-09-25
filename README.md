# Turbo Persistent Cache

![CI](https://github.com/pixpilot/turbo-persistent-cache/actions/workflows/ci.yml/badge.svg)
![Lint](https://github.com/pixpilot/turbo-persistent-cache/actions/workflows/linter.yml/badge.svg)

A GitHub Action that gives [Turborepo](https://turborepo.com/) a remote cache
backed by the **GitHub Actions cache**, or by any **S3-compatible** bucket. You
don't need a Vercel account or token.

> [!NOTE]
>
> This project is based on
> [**rharkor/caching-for-turbo**](https://github.com/rharkor/caching-for-turbo)
> by [HUORT Louis](https://github.com/rharkor). Its caching server, providers and
> CLI are all his work, used under the MIT License. This repository maintains
> its own copy with its own tooling, tests and fixes. See
> [Differences from upstream](#differences-from-upstream) and
> [Credits](#credits).

## How it works

1. The action starts a small Turborepo remote-cache server on `localhost` in
   the background.
2. It exports `TURBO_API`, `TURBO_TOKEN` and `TURBO_TEAM`, so every later
   `turbo` command in the job uses that server.
3. The server saves each task artifact as its own entry in the GitHub Actions
   cache (or S3) and restores it in later runs.
4. A post step stops the server and prints its log.

## Quick start

Add the action **before** any `turbo` command:

```yaml
steps:
  - uses: actions/checkout@v4

  - name: Turbo cache
    uses: pixpilot/turbo-persistent-cache@v1

  - run: pnpm turbo run build test
```

## Inputs

| Input                     | Default                    | Description                                                                                                           |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `provider`                | `github`                   | Storage backend: `github` or `s3`.                                                                                    |
| `cache-prefix`            | `turbogha_`                | Prefix for cache keys. Change it to start from an empty cache.                                                        |
| `server-port`             | `41230`                    | Port for the local server. Use `0` to let the OS pick a free port (avoids `EADDRINUSE` on shared runners).            |
| `use-relative-cache-path` | `false`                    | GitHub provider: archive a relative path so runners with different temp directories (e.g. self-hosted) share entries. |
| `max-age`                 |                            | S3 only: delete entries older than this (`1d`, `2w`, `1mo`, …).                                                       |
| `max-files`               |                            | S3 only: keep at most this many entries (oldest are deleted first).                                                   |
| `max-size`                |                            | S3 only: keep the total size under this (`500mb`, `10gb`, …).                                                         |
| `s3-access-key-id`        |                            | S3 access key ID.                                                                                                     |
| `s3-secret-access-key`    |                            | S3 secret access key.                                                                                                 |
| `s3-session-token`        |                            | S3 session token, for temporary credentials (e.g. OIDC).                                                              |
| `s3-bucket`               |                            | S3 bucket name.                                                                                                       |
| `s3-region`               |                            | S3 region.                                                                                                            |
| `s3-endpoint`             | `https://s3.amazonaws.com` | S3 endpoint. Set it for MinIO, Cloudflare R2, DigitalOcean Spaces, etc.                                               |
| `s3-prefix`               | `turbogha/`                | Prefix for S3 object keys.                                                                                            |

If an S3 input is not set, the action reads the matching environment variable
instead (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`,
…). See [`.env.example`](./.env.example) for the full list.

## Using the GitHub Actions cache

The default `github` provider needs no setup. How long entries last is up to
GitHub's cache rules, not this action:

- **Eviction:** entries not used for 7 days are removed. Each repository has a
  cache quota (10 GB by default). When it is full, the least recently used
  entries are removed first. Other caches in the repository, such as
  `setup-node`'s npm or pnpm cache, count toward the same quota.
- **Branch scope:** a branch can read caches from itself and from the default
  branch. A pull request can also read its base branch. To share hits across
  PRs, run the workflow on pushes to `main` so the cache is filled there.
- **No cleanup options:** GitHub removes old entries itself. `max-age`,
  `max-files` and `max-size` cause an error with the `github` provider.
- **Rate limits:** if restoring an entry is rate limited, the action retries
  once and then treats it as a cache miss.

> [!IMPORTANT]
>
> The provider only uses the GitHub cache service when the runner provides
> `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_CACHE_URL` and `RUNNER_TEMP`. If any of them
> is missing, it falls back to local files in `RUNNER_TEMP`, which are deleted
> when the job ends. If the post-step log shows
> `Using filesystem cache because cache API env vars are not set`, nothing is
> being stored between runs.

## Using S3

```yaml
- name: Turbo cache
  uses: pixpilot/turbo-persistent-cache@v1
  with:
    provider: s3
    s3-access-key-id: ${{ secrets.S3_ACCESS_KEY_ID }}
    s3-secret-access-key: ${{ secrets.S3_SECRET_ACCESS_KEY }}
    s3-bucket: my-turbo-cache
    s3-region: us-east-1
    # S3 keeps objects forever, so set at least one limit:
    max-age: 2w
    max-size: 5gb
```

The limits are applied when the post step stops the server. Files are deleted
oldest first. `max-size` counts only the files that the other limits keep.

## Running the server locally

The same server can run on your machine, for example to share an S3 cache
between local development and CI. After building the CLI (`pnpm build`), from
this repository:

```bash
cp .env.example .env         # set PROVIDER and, for S3, the credentials
pnpm turbogha start          # start in the background (add --foreground to keep it attached)
pnpm turbogha ping           # check that the provider can save and load
pnpm turbogha kill           # stop the server
```

Then point `turbo` at it:

```bash
export TURBO_API=http://localhost:41230
export TURBO_TOKEN=turbogha
export TURBO_TEAM=turbogha
turbo run build
```

Outside GitHub Actions, the `github` provider stores artifacts in
`RUNNER_TEMP` (or `/tmp`). Use `s3` if you need a cache that outlasts the
machine.

## Development

Uses pnpm, TypeScript, esbuild and Vitest.

```bash
pnpm install
pnpm run check:all   # format check, lint, typecheck, tests (with coverage thresholds)
pnpm run build       # bundle dist/setup, dist/post and dist/cli
pnpm run dev-run     # run the server in the foreground from source
```

The action runs from `dist/`, so rebuild it before you test the action in a
workflow. CI also runs the action end to end on Linux and Windows. It runs this
repository's own turbo tasks twice and expects `FULL TURBO` the second time,
then checks that a fresh job restores those entries from the GitHub cache.

## Differences from upstream

Ported from `rharkor/caching-for-turbo` at commit
[`347ddfd`](https://github.com/rharkor/caching-for-turbo/commit/347ddfd1c03bfbfe5719d083d3f7a74123212943).
The inputs and cache key format are unchanged. Changes:

- **Tooling:** pnpm, esbuild, Vitest and the `@pixpilot` ESLint/Prettier
  configs, with strict type-checking and a test suite that covers every
  provider, the cleanup logic and the server routes.
- **No `@rharkor/logger`:** replaced by a small built-in console logger.
  `LOG_LEVEL=debug` turns on debug output.
- **Fixes:**
  - `max-size` cleanup no longer deletes more than needed when `max-age` or
    `max-files` already removed some files.
  - The S3 provider only restores objects for the exact hash, not for other
    hashes that start with the same characters.
  - The server exits even when cleanup fails, and the post step logs a warning
    instead of hiding the error.
  - The temporary archive is deleted when an upload to the GitHub cache fails.
  - Errors while the server starts are reported with `core.setFailed`.
    Previously they were unhandled promise rejections.
  - Waiting for the port file no longer runs `sleep` in a child process, so
    it also works on Windows without spinning the CPU.
  - Cleanup logs the deleted path instead of `[object Object]`.

## Credits

- [HUORT Louis (rharkor)](https://github.com/rharkor) created
  [caching-for-turbo](https://github.com/rharkor/caching-for-turbo), which this
  project is based on. If you don't need the changes listed above, use the
  original.
- Upstream was in turn inspired by
  [dtinth/setup-github-actions-caching-for-turbo](https://github.com/dtinth/setup-github-actions-caching-for-turbo).

## License

[MIT](./LICENSE). The license file also includes the upstream project's MIT
notice.
