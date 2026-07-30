package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"runtime"
	"strings"
)

// Owner and Repo identify this project's own GitHub repository — self-update
// isn't generic infrastructure, it's this app updating itself, so these are
// not configurable.
const (
	Owner = "ItsMyEyes"
	Repo  = "devdeck"
)

// Checksum verification outcomes for the running binary, compared against the
// manifest its own release published. "unknown" is a normal answer — a dev
// build, a deleted release, or a release cut without checksums.txt all land
// there — never an error.
const (
	ChecksumVerifiedMatch    = "match"
	ChecksumVerifiedMismatch = "mismatch"
	ChecksumVerifiedUnknown  = "unknown"
)

// releaseFetcher is the subset of *Client that Run depends on, so tests can
// substitute a fake instead of spinning up an HTTP server.
type releaseFetcher interface {
	LatestRelease(ctx context.Context) (*Release, error)
	DownloadAsset(ctx context.Context, asset Asset) ([]byte, error)
}

// taggedReleaseFetcher adds the by-tag lookup Check needs to find the manifest
// for the version already running.
type taggedReleaseFetcher interface {
	releaseFetcher
	ReleaseByTag(ctx context.Context, tag string) (*Release, error)
}

// Options configures Run.
type Options struct {
	// CurrentVersion is the running binary's embedded version (version.Version).
	CurrentVersion string
	// ExecPath is the path of the currently running executable to replace,
	// e.g. from os.Executable().
	ExecPath string
}

// CheckResult describes what a check found, without changing anything.
type CheckResult struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"updateAvailable"`
	// ChecksumVerified compares the running binary against the manifest its
	// own release published: match, mismatch, or unknown.
	ChecksumVerified string `json:"checksumVerified"`
	AssetName        string `json:"assetName"`
}

// RunResult describes what an install did.
type RunResult struct {
	Updated bool   `json:"updated"`
	Version string `json:"version"`
	// Warning is non-empty when the install completed but something about it
	// deserves the operator's attention — today, only a release that published
	// no checksums.txt.
	Warning string `json:"warning"`
}

// Updater binds a Client to the package's two operations, so callers (the
// HTTP handler) depend on a small interface instead of package functions.
type Updater struct {
	Client *Client
}

// Check reports what the latest release is and whether the running binary
// matches what its own release published.
func (u *Updater) Check(ctx context.Context, currentVersion, selfSHA256 string) (*CheckResult, error) {
	return Check(ctx, u.Client, currentVersion, selfSHA256)
}

// Install downloads and installs the latest release over execPath.
func (u *Updater) Install(ctx context.Context, currentVersion, execPath string) (*RunResult, error) {
	return Run(ctx, u.Client, Options{CurrentVersion: currentVersion, ExecPath: execPath})
}

// Check compares currentVersion against the latest published release and, if
// currentVersion is a real tag, verifies selfSHA256 against that tag's
// checksums.txt. It downloads nothing and writes nothing.
func Check(ctx context.Context, client taggedReleaseFetcher, currentVersion, selfSHA256 string) (*CheckResult, error) {
	release, err := client.LatestRelease(ctx)
	if err != nil {
		return nil, fmt.Errorf("check latest release: %w", err)
	}

	update, err := NeedsUpdate(currentVersion, release.TagName)
	if err != nil {
		return nil, err
	}

	return &CheckResult{
		Current:          currentVersion,
		Latest:           release.TagName,
		UpdateAvailable:  update,
		ChecksumVerified: verifySelf(ctx, client, currentVersion, selfSHA256),
		AssetName:        AssetName(runtime.GOOS, runtime.GOARCH),
	}, nil
}

// verifySelf looks up the release for the running tag and compares its
// manifest entry against selfSHA256. Every failure along the way — no digest
// to compare, release deleted, no manifest, asset not listed — is "unknown"
// rather than an error: an unverifiable binary is a weaker claim, not a
// broken check.
func verifySelf(ctx context.Context, client taggedReleaseFetcher, currentVersion, selfSHA256 string) string {
	if selfSHA256 == "" {
		return ChecksumVerifiedUnknown
	}
	release, err := client.ReleaseByTag(ctx, currentVersion)
	if err != nil {
		return ChecksumVerifiedUnknown
	}
	want, err := expectedChecksum(ctx, client, release)
	if err != nil {
		return ChecksumVerifiedUnknown
	}
	if strings.EqualFold(want, selfSHA256) {
		return ChecksumVerifiedMatch
	}
	return ChecksumVerifiedMismatch
}

// expectedChecksum downloads a release's checksums.txt and returns the digest
// it records for this platform's asset. ErrChecksumNotListed passes through
// unwrapped so callers can tell "no manifest" from "manifest without us".
func expectedChecksum(ctx context.Context, client releaseFetcher, release *Release) (string, error) {
	var manifestAsset Asset
	for _, a := range release.Assets {
		if a.Name == ChecksumsFileName {
			manifestAsset = a
			break
		}
	}
	if manifestAsset.Name == "" {
		return "", fmt.Errorf("%w: release %s publishes no %s", ErrChecksumNotListed, release.TagName, ChecksumsFileName)
	}
	manifest, err := client.DownloadAsset(ctx, manifestAsset)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", ChecksumsFileName, err)
	}
	return ChecksumFor(manifest, AssetName(runtime.GOOS, runtime.GOARCH))
}

// Run checks the latest GitHub release against opts.CurrentVersion and, if
// newer, downloads it, verifies it against the release's checksums.txt, and
// installs it in place of opts.ExecPath. It never restarts the process — the
// caller decides when the new binary takes effect.
func Run(ctx context.Context, client releaseFetcher, opts Options) (*RunResult, error) {
	release, err := client.LatestRelease(ctx)
	if err != nil {
		return nil, fmt.Errorf("check latest release: %w", err)
	}

	update, err := NeedsUpdate(opts.CurrentVersion, release.TagName)
	if err != nil {
		return nil, err
	}
	if !update {
		return &RunResult{Updated: false, Version: release.TagName}, nil
	}

	asset, err := PickAsset(release.Assets, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return nil, err
	}

	log.Printf("downloading %s (%s)...", release.TagName, asset.Name)
	data, err := client.DownloadAsset(ctx, asset)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", asset.Name, err)
	}

	// Verify before touching disk. A release with no manifest is a warning,
	// not a failure — install.sh and install.ps1 already treat it that way,
	// and diverging would make the same release installable by the install
	// script but not by self-update.
	warning := ""
	want, err := expectedChecksum(ctx, client, release)
	switch {
	case errors.Is(err, ErrChecksumNotListed):
		warning = fmt.Sprintf("release %s published no verifiable %s — installed without checksum verification", release.TagName, ChecksumsFileName)
		log.Printf("warning: %s", warning)
	case err != nil:
		return nil, fmt.Errorf("verify %s: %w", asset.Name, err)
	default:
		if err := VerifySHA256(data, want); err != nil {
			return nil, fmt.Errorf("verify %s: %w", asset.Name, err)
		}
	}

	if err := ReplaceSelf(runtime.GOOS, opts.ExecPath, data); err != nil {
		return nil, fmt.Errorf("install update: %w", err)
	}

	log.Printf("updated to %s — restart devdeck to use it", release.TagName)
	return &RunResult{Updated: true, Version: release.TagName, Warning: warning}, nil
}
