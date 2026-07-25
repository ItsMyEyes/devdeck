package rginstall

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

// extractBinary pulls the rg (or rg.exe on windows) binary out of a
// downloaded release archive — a .tar.gz for macOS/Linux, a .zip for
// Windows, per ripgrep's release asset naming (archiveName is the asset's
// file name, used only to pick the archive format).
func extractBinary(archiveName string, data []byte, goos string) ([]byte, error) {
	binName := "rg"
	if goos == "windows" {
		binName = "rg.exe"
	}
	switch {
	case strings.HasSuffix(archiveName, ".tar.gz"):
		return extractFromTarGz(data, binName)
	case strings.HasSuffix(archiveName, ".zip"):
		return extractFromZip(data, binName)
	default:
		return nil, fmt.Errorf("rginstall: unrecognized ripgrep archive format: %s", archiveName)
	}
}

func extractFromTarGz(data []byte, binName string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("open ripgrep archive: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read ripgrep archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg || filepath.Base(hdr.Name) != binName {
			continue
		}
		return io.ReadAll(tr)
	}
	return nil, fmt.Errorf("rginstall: %s not found in downloaded archive", binName)
}

func extractFromZip(data []byte, binName string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("open ripgrep archive: %w", err)
	}
	for _, f := range zr.File {
		if filepath.Base(f.Name) != binName {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("open %s in archive: %w", binName, err)
		}
		defer rc.Close()
		return io.ReadAll(rc)
	}
	return nil, fmt.Errorf("rginstall: %s not found in downloaded archive", binName)
}
