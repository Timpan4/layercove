# Shared SemVer validation for container release requests and promotion.
is_container_release_tag() {
    local tag=$1 number='(0|[1-9][0-9]*)' identifier='[0-9A-Za-z-]+' component
    local -a prerelease
    [[ "$tag" =~ ^v$number\.$number\.$number(-$identifier(\.$identifier)*)?$ ]] || return 1
    if [[ "$tag" == *-* ]]; then
        IFS=. read -r -a prerelease <<< "${tag#*-}"
        for component in "${prerelease[@]}"; do
            if [[ "$component" =~ ^0[0-9]+$ ]]; then
                return 1
            fi
        done
    fi
    return 0
}
