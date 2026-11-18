#!/usr/bin/env bash
set -euo pipefail

source_sha=${1:?Usage: require-container-ci.sh COMMIT_SHA}
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
