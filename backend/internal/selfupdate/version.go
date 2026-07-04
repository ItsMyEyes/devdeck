package selfupdate

import (
	"fmt"

	"golang.org/x/mod/semver"
)

// NeedsUpdate reports whether latestTag is a newer semver version than
// currentVersion. currentVersion "dev" (an unreleased/local build with no
// version tag) is rejected — there's nothing meaningful to compare against.
func NeedsUpdate(currentVersion, latestTag string) (bool, error) {
	if currentVersion == "dev" {
		return false, fmt.Errorf("running a dev build (no version tag) — can't check for updates")
	}

	current := withVPrefix(currentVersion)
	latest := withVPrefix(latestTag)

	if !semver.IsValid(current) {
		return false, fmt.Errorf("current version %q is not a valid semver tag", currentVersion)
	}
	if !semver.IsValid(latest) {
		return false, fmt.Errorf("latest release tag %q is not a valid semver tag", latestTag)
	}

	return semver.Compare(latest, current) > 0, nil
}

func withVPrefix(tag string) string {
	if tag != "" && tag[0] != 'v' {
		return "v" + tag
	}
	return tag
}
