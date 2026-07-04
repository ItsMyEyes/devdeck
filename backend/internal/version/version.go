package version

// Version is the running build's version string, e.g. "v1.2.3". It defaults
// to "dev" for a plain `go build`/`go run` and is overridden at build time
// via `-ldflags "-X loom/backend/internal/version.Version=vX.Y.Z"` (see
// Makefile), which the release workflow sets from the pushed git tag.
var Version = "dev"
