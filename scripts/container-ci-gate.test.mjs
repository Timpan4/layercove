import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const sha = 'a'.repeat(40);
const repository = 'Timpan4/layercove';
const valid = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', id: 42 };

function gate(runs, {
  output = JSON.stringify({ workflow_runs: runs }), apiStatus = '0', ref = 'refs/heads/main', tagSha = sha,
} = {}) {
  return spawnSync('bash', ['-c', `
    gh() {
      if [[ "$SOURCE_REF" == refs/tags/* && "$*" == "api repos/$GITHUB_REPOSITORY/commits/tags/\${SOURCE_REF#refs/tags/} --jq .sha" ]]; then
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

test('publishing accepts a valid prerelease tag', () => {
  const result = gate([valid], { ref: 'refs/tags/v1.2.3-rc.1' });
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

for (const version of ['01.2.3', '1.2.3-rc..1', '1.2.3-rc.01']) {
  test(`publishing rejects the malformed release version ${version}`, () => {
    const result = gate([valid], { ref: `refs/tags/v${version}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid SemVer/);
  });
}

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

const imageName = 'ghcr.io/timpan4/layercove';
const image = `${imageName}:sha-${sha}`;
const digest = 'sha256:' + 'b'.repeat(64);
for (const [name, response, registryStatus, verifiedRevision, attestationStatus, status, stdout] of [
  ['existing attested image despite a registry warning', digest, '0', sha, '0', 0, digest + '\n'],
  ['missing image', `ERROR: ${image}: not found`, '1', sha, '0', 0, ''],
  ['registry outage', '502 Bad Gateway', '1', sha, '0', 1, ''],
  ['invalid registry digest', 'invalid', '0', sha, '0', 1, ''],
  ['unattested image at the commit tag', digest, '0', sha, '1', 1, ''],
  ['attested image for another revision', digest, '0', 'c'.repeat(40), '0', 1, ''],
]) {
  test(`publishing checks for ${name} before building`, () => {
    const result = spawnSync('bash', ['-c', `
      docker() {
        if [[ "$4" == "$IMAGE_NAME@$DIGEST" && "$5" == --raw ]]; then
          jq -n --arg revision "$VERIFIED_REVISION" '{annotations: {"org.opencontainers.image.revision": $revision}}'
        elif [[ "$REGISTRY_STATUS" == 0 ]]; then
          printf '%s\n' "$REGISTRY_RESPONSE"
          printf '%s\n' 'WARNING: registry returned a fallback media type' >&2
        else
          printf '%s\n' "$REGISTRY_RESPONSE" >&2
          return "$REGISTRY_STATUS"
        fi
      }
      gh() {
        local expected="attestation verify oci://$IMAGE_NAME@$DIGEST --bundle-from-oci --repo $GITHUB_REPOSITORY --signer-workflow $GITHUB_REPOSITORY/.github/workflows/publish-container.yml --source-ref refs/heads/main"
        [[ "$*" == "$expected" ]] || return 64
        return "$ATTESTATION_STATUS"
      }
      export -f docker gh
      bash scripts/find-container-digest.sh "$IMAGE_NAME" "$SOURCE_SHA"
    `], {
      encoding: 'utf8',
      env: {
        ...process.env, IMAGE_NAME: imageName, DIGEST: digest, SOURCE_SHA: sha, GITHUB_REPOSITORY: repository,
        REGISTRY_RESPONSE: response, REGISTRY_STATUS: registryStatus, VERIFIED_REVISION: verifiedRevision,
        ATTESTATION_STATUS: attestationStatus,
      },
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, stdout);
  });
}

const publisher = readFileSync(new URL('../.github/workflows/publish-container.yml', import.meta.url), 'utf8');
const promotion = publisher.split('        run: |\n').at(-1).trimEnd().split('\n').map(line => line.slice(10)).join('\n');
const tip = 'd'.repeat(40);
const tipDigest = 'sha256:' + 'e'.repeat(64);

function promote(releaseTag, mainDigest = tipDigest, publishedTags = '') {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
    gh() {
      case "$2" in
        "repos/$GITHUB_REPOSITORY/commits/main") printf '%s\n' "$TIP" ;;
        "repos/$GITHUB_REPOSITORY/commits/tags/$RELEASE_TAG") printf '%s\n' "$SOURCE_SHA" ;;
        --paginate) printf '%s\n' "$PUBLISHED_TAGS" ;;
        *) return 64 ;;
      esac
    }
    bash() {
      [[ "$*" == "scripts/find-container-digest.sh $IMAGE_NAME $TIP" ]] || return 64
      printf '%s\n' "$TIP_DIGEST"
    }
    docker() { printf '%s\n' "$*"; }
    ${promotion}
  `], {
    encoding: 'utf8',
    env: {
      ...process.env, GITHUB_REPOSITORY: repository, IMAGE_NAME: imageName, IMAGE_DIGEST: digest,
      SOURCE_SHA: sha, RELEASE_TAG: releaseTag, TIP: tip, TIP_DIGEST: mainDigest,
      PUBLISHED_TAGS: publishedTags, GITHUB_REPOSITORY_OWNER: 'Timpan4',
    },
  });
}

test('a late publisher reconciles latest to the verified main tip digest', () => {
  const result = promote('');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `buildx imagetools create --tag ${imageName}:latest ${imageName}@${tipDigest}\n`);
});

test('a late publisher leaves latest in place before the main tip is published', () => {
  const result = promote('', '');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /imagetools create/);
});

test('release tags use the attested digest instead of rereading a mutable commit tag', () => {
  const result = promote('v1.2.3');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `buildx imagetools create --tag ${imageName}:1.2.3 --tag ${imageName}:1.2 ${imageName}@${digest}\n`);
});

test('rerunning an older release publishes its exact tag without moving the minor alias back', () => {
  const result = promote('v1.2.3', tipDigest, '1.2.10\n1.2.2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `buildx imagetools create --tag ${imageName}:1.2.3 ${imageName}@${digest}\n`);
});
