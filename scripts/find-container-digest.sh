#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: find-container-digest.sh IMAGE_NAME COMMIT_SHA}
sha=${2:?Expected commit SHA}
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Expected a full commit SHA.\n' >&2
    exit 1
fi
digest=$(bash "${BASH_SOURCE[0]%/*}/registry-container-digest.sh" "$image:sha-$sha")
if [[ -z "$digest" ]]; then
    exit 0
fi

subject="$image@$digest"
gh attestation verify "oci://$subject" --bundle-from-oci --repo "$GITHUB_REPOSITORY" \
    --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/publish-container.yml" \
    --source-ref refs/heads/main >&2

# The attestation covers this index digest, including its revision annotation.
if ! docker buildx imagetools inspect "$subject" --raw |
    jq -e --arg sha "$sha" '.annotations["org.opencontainers.image.revision"] == $sha' >/dev/null; then
    printf 'Attested image %s does not identify commit %s.\n' "$subject" "$sha" >&2
    exit 1
fi
printf '%s\n' "$digest"
