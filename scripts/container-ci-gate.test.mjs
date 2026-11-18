import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const sha = 'a'.repeat(40);
const repository = 'Timpan4/layercove';
const valid = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', id: 42 };

function gate(runs) {
  return spawnSync('bash', ['-c', `
    gh() {
      local expected="api --method GET repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs -f head_sha=$SOURCE_SHA -f branch=main -f event=push -F per_page=1"
      [[ "$*" == "$expected" ]] || return 64
      printf '%s\n' "$CI_RUNS"
    }
    export -f gh
    bash scripts/require-container-ci.sh "$SOURCE_SHA"
  `], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: repository, SOURCE_SHA: sha, CI_RUNS: JSON.stringify({ workflow_runs: runs }) },
  });
}

test('publishing accepts a successful main CI run for the checked-out commit', () => {
  const result = gate([valid]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /42/);
});

for (const [name, runs] of [
  ['no CI run', []],
  ['different commit', [{ ...valid, head_sha: 'b'.repeat(40) }]],
  ['pull request CI', [{ ...valid, event: 'pull_request' }]],
  ['different branch', [{ ...valid, head_branch: 'feature' }]],
  ['pending CI', [{ ...valid, status: 'in_progress', conclusion: null }, valid]],
  ['failed CI', [{ ...valid, conclusion: 'failure' }, valid]],
  ['cancelled CI', [{ ...valid, conclusion: 'cancelled' }, valid]],
]) {
  test(`publishing rejects ${name}`, () => {
    const result = gate(runs);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /CI must succeed/);
  });
}
