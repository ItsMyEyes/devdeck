package selfupdate

import "fmt"

// AssetName returns the release asset filename for a platform, matching the
// naming `make portable-all` produces (see Makefile's portable-all target).
func AssetName(goos, goarch string) string {
	name := fmt.Sprintf("loom-%s-%s", goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// PickAsset finds the asset matching goos/goarch, or an error naming the
// platform if the release doesn't have one (e.g. it was cut without running
// portable-all for that platform combo).
func PickAsset(assets []Asset, goos, goarch string) (Asset, error) {
	name := AssetName(goos, goarch)
	for _, a := range assets {
		if a.Name == name {
			return a, nil
		}
	}
	return Asset{}, fmt.Errorf("no release asset named %q for %s/%s", name, goos, goarch)
}
