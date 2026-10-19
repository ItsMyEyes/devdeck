package antigravity

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"devdeck/backend/internal/agentcore/provider"
)

// Headless input accepts text only; view_file can read images in the workspace.
func prepareImages(cwd string, attachments []provider.Attachment) (dir string, paths []string, err error) {
	if len(attachments) == 0 {
		return "", nil, nil
	}
	exts := make([]string, len(attachments))
	for i, att := range attachments {
		if att.Kind != "image" {
			return "", nil, fmt.Errorf("antigravity: only image attachments are supported")
		}
		switch http.DetectContentType(att.Data) {
		case "image/png":
			exts[i] = ".png"
		case "image/jpeg":
			exts[i] = ".jpg"
		case "image/gif":
			exts[i] = ".gif"
		case "image/webp":
			exts[i] = ".webp"
		default:
			return "", nil, fmt.Errorf("antigravity: image must contain PNG, JPEG, GIF or WebP data")
		}
	}
	root, err := filepath.Abs(cwd)
	if err != nil {
		return "", nil, fmt.Errorf("antigravity: image workspace: %w", err)
	}
	dir, err = os.MkdirTemp(root, ".devdeck-images-")
	if err != nil {
		return "", nil, fmt.Errorf("antigravity: create image directory: %w", err)
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(dir)
		}
	}()
	for i, att := range attachments {
		path := filepath.Join(dir, fmt.Sprintf("image-%d%s", i+1, exts[i]))
		if err = os.WriteFile(path, att.Data, 0600); err != nil {
			return dir, nil, fmt.Errorf("antigravity: write image: %w", err)
		}
		paths = append(paths, path)
	}
	return dir, paths, nil
}
