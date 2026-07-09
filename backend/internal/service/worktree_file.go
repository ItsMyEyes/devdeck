package service

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"unicode/utf8"

	gitpkg "loom/backend/internal/git"
	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

const (
	maxEditableFileSize  = 2 << 20
	maxFileSearchResults = 200
)

var (
	errSearchLimit = errors.New("search result limit reached")
	searchSkipDirs = map[string]bool{
		".git":         true,
		".wt":          true,
		".codegraph":   true,
		".next":        true,
		"build":        true,
		"dist":         true,
		"node_modules": true,
		"vendor":       true,
	}
)

// WorktreeFileEntry is one visible item in a worktree directory.
type WorktreeFileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// WorktreeFileContent is the editable text representation of a worktree file.
type WorktreeFileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// WorktreeFileService provides file access rooted strictly inside one
// worktree. It never accepts absolute paths or paths containing "..".
type WorktreeFileService struct {
	store port.Store
}

func NewWorktreeFileService(s port.Store) *WorktreeFileService {
	return &WorktreeFileService{store: s}
}

func (svc *WorktreeFileService) List(worktreeID, relativePath string) ([]WorktreeFileEntry, error) {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, true, false)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, fileOperationError("read folder", clean, err)
	}

	result := make([]WorktreeFileEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Name() == ".git" || entry.Name() == ".wt" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		size := int64(0)
		if !entry.IsDir() {
			size = info.Size()
		}
		result = append(result, WorktreeFileEntry{
			Name:  entry.Name(),
			Path:  path.Join(clean, entry.Name()),
			IsDir: entry.IsDir(),
			Size:  size,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}

func (svc *WorktreeFileService) Read(worktreeID, relativePath string) (WorktreeFileContent, error) {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, false)
	if err != nil {
		return WorktreeFileContent{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return WorktreeFileContent{}, fileOperationError("read file", clean, err)
	}
	if info.IsDir() {
		return WorktreeFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
	}
	if info.Size() > maxEditableFileSize {
		return WorktreeFileContent{}, fmt.Errorf(
			"%q is larger than the %d MB editor limit: %w",
			clean,
			maxEditableFileSize/(1<<20),
			ErrValidation,
		)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return WorktreeFileContent{}, fileOperationError("read file", clean, err)
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return WorktreeFileContent{}, fmt.Errorf("%q is not a UTF-8 text file: %w", clean, ErrValidation)
	}
	return WorktreeFileContent{Path: clean, Content: string(data)}, nil
}

func (svc *WorktreeFileService) Write(worktreeID, relativePath, content string) (WorktreeFileContent, error) {
	if len(content) > maxEditableFileSize {
		return WorktreeFileContent{}, fmt.Errorf(
			"content is larger than the %d MB editor limit: %w",
			maxEditableFileSize/(1<<20),
			ErrValidation,
		)
	}
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, true)
	if err != nil {
		return WorktreeFileContent{}, err
	}

	mode := fs.FileMode(0o644)
	if info, statErr := os.Stat(target); statErr == nil {
		if info.IsDir() {
			return WorktreeFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
		}
		mode = info.Mode().Perm()
	} else if !os.IsNotExist(statErr) {
		return WorktreeFileContent{}, fileOperationError("inspect file", clean, statErr)
	}

	if err := os.WriteFile(target, []byte(content), mode); err != nil {
		return WorktreeFileContent{}, fileOperationError("write file", clean, err)
	}
	return WorktreeFileContent{Path: clean, Content: content}, nil
}

func (svc *WorktreeFileService) Delete(worktreeID, relativePath string) error {
	_, target, clean, err := svc.resolve(worktreeID, relativePath, false, false)
	if err != nil {
		return err
	}
	if err := os.Remove(target); err != nil {
		if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
			return fmt.Errorf("%q is not empty: %w", clean, ErrConflict)
		}
		return fileOperationError("delete file", clean, err)
	}
	return nil
}

// Search returns relative file paths matched by a Go regular expression.
// Go's RE2 implementation guarantees linear-time matching.
func (svc *WorktreeFileService) Search(worktreeID, pattern string) ([]string, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("invalid regex: %v: %w", err, ErrValidation)
	}
	root, _, _, err := svc.resolve(worktreeID, "", true, false)
	if err != nil {
		return nil, err
	}

	result := make([]string, 0)
	err = filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrPermission) {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() && current != root && searchSkipDirs[entry.Name()] {
			return filepath.SkipDir
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if re.MatchString(relative) {
			result = append(result, relative)
			if len(result) >= maxFileSearchResults {
				return errSearchLimit
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, errSearchLimit) {
		return nil, fmt.Errorf("search files failed")
	}
	sort.Strings(result)
	return result, nil
}

func (svc *WorktreeFileService) resolve(
	worktreeID string,
	relativePath string,
	allowRoot bool,
	allowMissing bool,
) (root string, target string, clean string, err error) {
	clean, err = normalizeRelativePath(relativePath, allowRoot)
	if err != nil {
		return "", "", "", err
	}

	root, err = svc.worktreeRoot(worktreeID)
	if err != nil {
		return "", "", "", err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", "", "", fmt.Errorf("resolve worktree path failed")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", "", fileOperationError("resolve worktree", "", err)
	}

	target = filepath.Join(root, filepath.FromSlash(clean))
	if err := ensureInside(root, target); err != nil {
		return "", "", "", err
	}

	if allowMissing {
		if _, err := os.Lstat(target); err == nil {
			resolved, err := filepath.EvalSymlinks(target)
			if err != nil {
				return "", "", "", fileOperationError("resolve file", clean, err)
			}
			if err := ensureInside(root, resolved); err != nil {
				return "", "", "", err
			}
		} else if os.IsNotExist(err) {
			parent, err := filepath.EvalSymlinks(filepath.Dir(target))
			if err != nil {
				return "", "", "", fileOperationError("resolve parent folder", clean, err)
			}
			if err := ensureInside(root, parent); err != nil {
				return "", "", "", err
			}
		} else {
			return "", "", "", fileOperationError("inspect file", clean, err)
		}
		return root, target, clean, nil
	}

	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", "", "", fileOperationError("resolve path", clean, err)
	}
	if err := ensureInside(root, resolved); err != nil {
		return "", "", "", err
	}
	return root, target, clean, nil
}

func (svc *WorktreeFileService) worktreeRoot(worktreeID string) (string, error) {
	worktree, err := svc.store.WorktreeByID(worktreeID)
	if err != nil {
		return "", err
	}
	projectRoot := gitpkg.ExpandHome(worktree.Path)
	if worktree.Root {
		return projectRoot, nil
	}
	return filepath.Join(projectRoot, ".wt", worktreeID), nil
}

func normalizeRelativePath(raw string, allowRoot bool) (string, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	if normalized == "" || normalized == "." {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("file path is required: %w", ErrValidation)
	}
	nativePath := filepath.FromSlash(normalized)
	hasWindowsVolume := len(normalized) >= 2 &&
		normalized[1] == ':' &&
		((normalized[0] >= 'a' && normalized[0] <= 'z') ||
			(normalized[0] >= 'A' && normalized[0] <= 'Z'))
	if strings.HasPrefix(normalized, "/") ||
		hasWindowsVolume ||
		filepath.IsAbs(nativePath) ||
		filepath.VolumeName(nativePath) != "" {
		return "", fmt.Errorf("absolute paths are not allowed: %w", ErrValidation)
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return "", fmt.Errorf("path traversal is not allowed: %w", ErrValidation)
		}
	}
	clean := path.Clean(normalized)
	if clean == "." || clean == "" {
		if allowRoot {
			return "", nil
		}
		return "", fmt.Errorf("file path is required: %w", ErrValidation)
	}
	return clean, nil
}

func ensureInside(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes the worktree: %w", ErrValidation)
	}
	return nil
}

func fileOperationError(operation, relativePath string, err error) error {
	if os.IsNotExist(err) {
		return fmt.Errorf("%s %q: %w", operation, relativePath, store.ErrNotFound)
	}
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("permission denied for %q: %w", relativePath, ErrValidation)
	}
	return fmt.Errorf("%s %q failed", operation, relativePath)
}
