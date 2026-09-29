# Repository agent instructions

## Development environment

- The supported development and test environment is Linux/macOS, not native Windows.
- From a Windows Claude Code session, run Python tests and tooling through WSL from `/mnt/d/layercove`.
- Use the repository-declared dependencies when the environment is not already provisioned:
  - Tests: `uv run --with-requirements requirements.txt --with-requirements requirements-dev.txt pytest ...`
  - Ruff: `uv run --with-requirements requirements-dev.txt ruff ...`
- Treat native-Windows-only test failures as environment evidence, not product defects. Reproduce them in WSL before changing code.

## Testing

- Prefer E2E tests. Browser E2E lives in `frontend/e2e/` (Playwright) and runs against a live server: `LAYERCOVE_URL=http://localhost:8001 bun run test:e2e` from `frontend/`. Each run leaves `frontend/playwright-report/` (plus a trace on failure); CI uploads it as the `playwright-report` artifact.
- To run E2E in [Obscura](https://github.com/h4ckf0r0day/obscura) instead of bundled Chromium, start `obscura serve --port 9222 --allow-private-network` and set `E2E_CDP_URL=http://127.0.0.1:9222`. As of Obscura 0.2.3, `selectOption` fails because `HTMLOptionElement.label` is unimplemented, so Chromium stays the CI default.
- Do not write unit tests after the code. Tests that restate the implementation (asserting mock calls, internal call order, or source/config text) always pass and break on refactor.
- If a component must be tested in isolation, first write down the ways it can fail, then write the code and tests against those failure modes.

## Bug fixes

- Every bug fix must include an automated regression test that reproduces the specific reported failure.
- Confirm the regression test fails before the fix and passes after it. Generic coverage is not a substitute.

## Git safety

- Before every Git write, run `git branch --show-current`.
- On `gitbutler/workspace`, use `but` for all Git writes. Never use raw Git write commands.
- Preserve unrelated user changes and untracked files.
