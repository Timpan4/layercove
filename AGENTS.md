# Repository agent instructions

## Development environment

- The supported development and test environment is Linux/macOS, not native Windows.
- From a Windows Claude Code session, run Python tests and tooling through WSL from `/mnt/d/layercove`.
- Use the repository-declared dependencies when the environment is not already provisioned:
  - Tests: `uv run --with-requirements requirements.txt --with-requirements requirements-dev.txt pytest ...`
  - Ruff: `uv run --with-requirements requirements-dev.txt ruff ...`
- Treat native-Windows-only test failures as environment evidence, not product defects. Reproduce them in WSL before changing code.

## Git safety

- Before every Git write, run `git branch --show-current`.
- On `gitbutler/workspace`, use `but` for all Git writes. Never use raw Git write commands.
- Preserve unrelated user changes and untracked files.
