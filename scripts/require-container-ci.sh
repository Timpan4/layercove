#!/usr/bin/env bash
set -euo pipefail

source_sha=${1:?Usage: require-container-ci.sh COMMIT_SHA [REF]}
source_ref=${2:-refs/heads/main}
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Invalid source commit SHA.\n' >&2
    exit 1
fi
if [[ "$source_ref" != refs/heads/main ]]; then
    source "${BASH_SOURCE[0]%/*}/container-release-tag.sh"
    tag=${source_ref#refs/tags/}
    if [[ "$tag" == "$source_ref" ]] || ! is_container_release_tag "$tag"; then
        printf 'Container release requires main or a valid SemVer vX.Y.Z tag with at most %s characters after v.\n' \
            "$CONTAINER_TAG_MAX_LENGTH" >&2
        exit 1
    fi
    if ! tag_sha=$(gh api "repos/$GITHUB_REPOSITORY/commits/tags/$tag" --jq .sha) || [[ "$tag_sha" != "$source_sha" ]]; then
        printf 'Release tag %s does not resolve to the requested commit.\n' "$tag" >&2
        exit 1
    fi
fi
query=(
    --method GET "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs"
    -f "head_sha=$source_sha" -f branch=main -f event=push -F per_page=1
)
if ! ci_run_id=$(
    gh api "${query[@]}" |
        jq -er --arg sha "$source_sha" '
            .workflow_runs[0]
            | select(.head_sha == $sha and .head_branch == "main" and .event == "push")
            | select(.status == "completed" and .conclusion == "success")
            | .id
        '
); then
    printf 'CI must succeed on main for commit %s before its image can be published.\n' "$source_sha" >&2
    exit 1
fi

printf '%s\n' "$ci_run_id"
