#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: find-container-digest.sh IMAGE_TAG}
if inspection=$(docker buildx imagetools inspect "$image" --format '{{.Manifest.Digest}}' 2>&1); then
    if [[ ! "$inspection" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        printf 'Registry returned an invalid manifest digest for %s.\n' "$image" >&2
        exit 1
    fi
    printf '%s\n' "$inspection"
elif [[ "$inspection" != "ERROR: $image: not found" ]]; then
    printf 'Could not look up %s in the registry.\n' "$image" >&2
    exit 1
fi
