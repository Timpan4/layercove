import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const sha = 'a'.repeat(40);
const repository = 'Timpan4/layercove';
const valid = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', id: 42 };

function gate(runs, {
  output = JSON.stringify({ workflow_runs: runs }), apiStatus = '0', ref = 'refs/heads/main', tagSha = sha,
} = {}) {
  return spawnSync('bash', ['-c', `
    gh() {
      if [[ "$*" == "api repos/$GITHUB_REPOSITORY/commits/tags/v1.2.3 --jq .sha" ]]; then
        printf '%s\n' "$TAG_SHA"
        return
      fi
      local expected="api --method GET repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs -f head_sha=$SOURCE_SHA -f branch=main -f event=push -F per_page=1"
      [[ "$*" == "$expected" ]] || return 64
      printf '%s\n' "$CI_RUNS"
      return "$CI_API_STATUS"
    }
    export -f gh
    bash scripts/require-container-ci.sh "$SOURCE_SHA" "$SOURCE_REF"
  `], {
    encoding: 'utf8',
    env: {
      ...process.env, GITHUB_REPOSITORY: repository, SOURCE_SHA: sha, SOURCE_REF: ref, TAG_SHA: tagSha,
      CI_RUNS: output, CI_API_STATUS: apiStatus,
    },
  });
}

for (const [name, overrides] of [
  ['a failed API request with a valid response body', { apiStatus: '1' }],
  ['malformed API JSON', { output: '{"workflow_runs":' }],
]) {
  test(`publishing rejects ${name}`, () => {
    const result = gate([valid], overrides);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /CI must succeed/);
  });
}

test('publishing accepts a successful main CI run for the checked-out commit', () => {
  const result = gate([valid]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /42/);
});

test('publishing accepts a release tag that points to the exact tested commit', () => {
  const result = gate([valid], { ref: 'refs/tags/v1.2.3' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '42\n');
});

test('publishing rejects a moved release tag despite successful CI for the original commit', () => {
  const result = gate([valid], { ref: 'refs/tags/v1.2.3', tagSha: 'b'.repeat(40) });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('publishing rejects a manual request from a feature branch', () => {
  const result = gate([valid], { ref: 'refs/heads/feature' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
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

const image = 'ghcr.io/timpan4/layercove:sha-' + sha;
const digest = 'sha256:' + 'b'.repeat(64);
for (const [name, response, registryStatus, status, stdout] of [
  ['existing attested image', digest, '0', 0, digest + '\n'],
  ['missing image', `ERROR: ${image}: not found`, '1', 0, ''],
  ['registry outage', '502 Bad Gateway', '1', 1, ''],
  ['invalid registry digest', 'invalid', '0', 1, ''],
]) {
  test(`publishing checks for ${name} before building`, () => {
    const result = spawnSync('bash', ['-c', `
      docker() { printf '%s\n' "$REGISTRY_RESPONSE"; return "$REGISTRY_STATUS"; }
      export -f docker
      bash scripts/find-container-digest.sh "$IMAGE"
    `], {
      encoding: 'utf8',
      env: { ...process.env, IMAGE: image, REGISTRY_RESPONSE: response, REGISTRY_STATUS: registryStatus },
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, stdout);
  });
}
