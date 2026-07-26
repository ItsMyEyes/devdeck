package selfupdate

import (
	"context"
	"fmt"
	"log"
	"runtime"
)

// Owner and Repo identify this project's own GitHub repository — self-update
// isn't generic infrastructure, it's this app updating itself, so these are
// not configurable.
const (
	Owner = "ItsMyEyes"
	Repo  = "devdeck"
)

// releaseFetcher is the subset of *Client that Run depends on, so tests can
// substitute a fake instead of spinning up an HTTP server.
type releaseFetcher interface {
	LatestRelease(ctx context.Context) (*Release, error)
	DownloadAsset(ctx context.Context, asset Asset) ([]byte, error)
}

// Options configures Run.
type Options struct {
	// CurrentVersion is the running binary's embedded version (version.Version).
	CurrentVersion string
	// ExecPath is the path of the currently running executable to replace,
	// e.g. from os.Executable().
	ExecPath string
}

// Run checks the latest GitHub release against opts.CurrentVersion and, if
// newer, downloads and installs it in place of opts.ExecPath. It never
// restarts the process — the caller exits and the operator restarts DevDeck.
func Run(ctx context.Context, client releaseFetcher, opts Options) error {
	release, err := client.LatestRelease(ctx)
	if err != nil {
		return fmt.Errorf("check latest release: %w", err)
	}

	update, err := NeedsUpdate(opts.CurrentVersion, release.TagName)
	if err != nil {
		return err
	}
	if !update {
		log.Printf("already on latest version %s", opts.CurrentVersion)
		return nil
	}

	asset, err := PickAsset(release.Assets, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}

	log.Printf("downloading %s (%s)...", release.TagName, asset.Name)
	data, err := client.DownloadAsset(ctx, asset)
	if err != nil {
		return fmt.Errorf("download %s: %w", asset.Name, err)
	}

	if err := ReplaceSelf(runtime.GOOS, opts.ExecPath, data); err != nil {
		return fmt.Errorf("install update: %w", err)
	}

	log.Printf("updated to %s — restart devdeck to use it", release.TagName)
	return nil
}
