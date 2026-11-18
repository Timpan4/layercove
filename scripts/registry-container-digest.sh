#!/usr/bin/env bash
set -euo pipefail

tag=${1:?Usage: registry-container-digest.sh IMAGE_TAG}
error_log=$(mktemp)
trap 'rm -f -- "$error_log"' EXIT

if digest=$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>"$error_log"); then
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        printf 'Registry returned an invalid manifest digest for %s.\n' "$tag" >&2
        exit 1
    fi
    printf '%s\n' "$digest"
    exit 0
fi

missing=false
while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
        "ERROR: $tag: not found") missing=true ;;
        WARNING:*|'') ;;
        *) missing=false; break ;;
    esac
done < "$error_log"
if [[ "$missing" != true ]]; then
    printf 'Could not look up %s in the registry.\n' "$tag" >&2
    exit 1
fi
