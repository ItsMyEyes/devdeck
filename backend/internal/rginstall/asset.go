package rginstall

import (
	"fmt"
	"strings"
)

// platformAssetSuffix maps "goos/goarch" to the exact suffix ripgrep's
// GitHub release asset names end with — "ripgrep-<version>-<suffix>" —
// verified against the live release API (BurntSushi/ripgrep, current
// version 15.2.0). Only these six combos are supported; everything else is
// an "unsupported platform" error. Linux picks the musl-libc variant over
// the also-published gnu variant: there is no x86_64-unknown-linux-gnu
// asset at all for amd64, and musl is preferred for arm64 too, for
// portability across distros/glibc versions.
var platformAssetSuffix = map[string]string{
	"darwin/arm64":  "aarch64-apple-darwin.tar.gz",
	"darwin/amd64":  "x86_64-apple-darwin.tar.gz",
	"linux/amd64":   "x86_64-unknown-linux-musl.tar.gz",
	"linux/arm64":   "aarch64-unknown-linux-musl.tar.gz",
	"windows/amd64": "x86_64-pc-windows-msvc.zip",
	"windows/arm64": "aarch64-pc-windows-msvc.zip",
}

// supportedPlatform reports whether goos/goarch is one of the six combos
// ripgrep publishes a release asset for.
func supportedPlatform(goos, goarch string) bool {
	_, ok := platformAssetSuffix[goos+"/"+goarch]
	return ok
}

// PickAsset returns the release asset matching goos/goarch's exact naming
// convention. Returns an error for platform/arch combos ripgrep doesn't
// publish a release for, and for a supported combo whose expected asset is
// unexpectedly missing from assets (a malformed/incomplete release).
func PickAsset(assets []Asset, goos, goarch string) (Asset, error) {
	suffix, ok := platformAssetSuffix[goos+"/"+goarch]
	if !ok {
		return Asset{}, fmt.Errorf("rginstall: unsupported platform %s/%s", goos, goarch)
	}
	for _, a := range assets {
		if strings.HasPrefix(a.Name, "ripgrep-") && strings.HasSuffix(a.Name, suffix) {
			return a, nil
		}
	}
	return Asset{}, fmt.Errorf("rginstall: no ripgrep release asset found for %s/%s", goos, goarch)
}
