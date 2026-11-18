#!/usr/bin/env bash
set -euo pipefail

source_sha=${1:?Usage: require-container-ci.sh COMMIT_SHA [REF]}
source_ref=${2:-refs/heads/main}
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Invalid source commit SHA.\n' >&2
    exit 1
fi
if [[ "$source_ref" != refs/heads/main ]]; then
    number='(0|[1-9][0-9]*)'
    identifier='[0-9A-Za-z-]+'
    if [[ ! "$source_ref" =~ ^refs/tags/v$number\.$number\.$number(-$identifier(\.$identifier)*)?$ ]]; then
        printf 'Container release requires a valid SemVer vX.Y.Z tag or main.\n' >&2
        exit 1
    fi
    tag=${source_ref#refs/tags/}
    if [[ "$tag" == *-* ]]; then
        IFS=. read -r -a prerelease <<< "${tag#*-}"
        for component in "${prerelease[@]}"; do
            if [[ "$component" =~ ^0[0-9]+$ ]]; then
                printf 'Container release requires valid SemVer prerelease identifiers.\n' >&2
                exit 1
            fi
        done
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
