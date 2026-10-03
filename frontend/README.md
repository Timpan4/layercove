# LayerCove frontend

React, TypeScript, Vite, and Tailwind CSS, managed with Bun 1.3.14. `bun run build` writes the production bundle to `../static`, which the backend serves.

## Development

```bash
bun install --frozen-lockfile
bun run dev
```

The dev server runs on `http://localhost:5173` and proxies API and WebSocket traffic to `http://localhost:${BACKEND_PORT:-8000}`. Set `BACKEND_URL` to use a remote LayerCove backend instead. To start the backend too, run `bash scripts/dev.sh` from the repository root.

## Scripts

| Command | Purpose |
|---|---|
| `bun run dev` | Vite dev server |
| `bun run build` | Type-check and build into `../static` |
| `bun run lint` | Oxlint, warnings as errors |
| `bun x tsc -b` | Type check of the app and node projects |
| `bun run test` | Vitest in watch mode |
| `bun run test:run` | Vitest once, then i18n parity and brand-asset checks |
| `bun run test:coverage` | Vitest with coverage |
| `bun run test:e2e` | Playwright E2E against a running server |
| `bun run check:i18n` | Locale key and translation parity |
| `bun run generate:api` | Regenerate `src/api/generated.ts` from the backend OpenAPI schema |
| `bun run check:api` | Fail if `src/api/generated.ts` is out of date |

## Layout

- `src/pages/`, `src/components/`, `src/features/`: UI
- `src/api/`: API client and generated OpenAPI types
- `src/i18n/locales/`: translations; every key must exist in all locales
- `src/__tests__/`: Vitest tests
- `e2e/`: Playwright tests

## E2E tests

Playwright runs against a live server, `http://localhost:8001` by default:

```bash
LAYERCOVE_URL=http://localhost:8001 bun run test:e2e
```

Each run writes `playwright-report/`, plus a trace on failure. To use an external CDP browser such as [Obscura](https://github.com/h4ckf0r0day/obscura), set `E2E_CDP_URL`. See [AGENTS.md](../AGENTS.md#testing) for its current limitations.
