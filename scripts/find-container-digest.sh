#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: find-container-digest.sh IMAGE_NAME COMMIT_SHA}
sha=${2:?Expected commit SHA}
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Expected a full commit SHA.\n' >&2
    exit 1
fi
tag="$image:sha-$sha"
error_log=$(mktemp)
trap 'rm -f -- "$error_log"' EXIT
if digest=$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>"$error_log"); then
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        printf 'Registry returned an invalid manifest digest for %s.\n' "$tag" >&2
        exit 1
    fi
else
    if [[ $(<"$error_log") == "ERROR: $tag: not found" ]]; then
        exit 0
    fi
    printf 'Could not look up %s in the registry.\n' "$tag" >&2
    exit 1
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
