// Package webui serves the production frontend embedded in the Loom binary.
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// dist is populated by `make prepare-webui`. The committed placeholder keeps
// normal Go development commands working before the frontend has been built.
//
//go:embed all:dist
var embedded embed.FS

var assets, assetsErr = fs.Sub(embedded, "dist")

// Available reports whether a production frontend has been embedded.
func Available() bool {
	if assetsErr != nil {
		return false
	}
	info, err := fs.Stat(assets, "index.html")
	return err == nil && !info.IsDir()
}

// Handler serves immutable Vite assets and falls back to index.html for
// client-side routes used by the TanStack Router SPA.
func Handler() http.Handler {
	if !Available() {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "Loom UI is not embedded; run `make build` or use the Vite development server", http.StatusServiceUnavailable)
		})
	}

	index, _ := fs.ReadFile(assets, "index.html")
	files := http.FileServer(http.FS(assets))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
			return
		}

		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name != "" && name != "." {
			if info, err := fs.Stat(assets, name); err == nil && !info.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(index)
		}
	})
}
