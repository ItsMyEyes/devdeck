package service

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
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

var searchSkipDirs = map[string]bool{
	".git":         true,
	".wt":          true,
	".codegraph":   true,
	".next":        true,
	"build":        true,
	"dist":         true,
	"node_modules": true,
	"vendor":       true,
}

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

// WorktreeUploadFile is one multipart upload stream destined for a worktree folder.
type WorktreeUploadFile struct {
	Name   string
	Reader io.Reader
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

func (svc *WorktreeFileService) Upload(worktreeID, folderPath string, uploads []WorktreeUploadFile) ([]WorktreeFileEntry, error) {
	if len(uploads) == 0 {
		return nil, fmt.Errorf("at least one file is required: %w", ErrValidation)
	}
	root, targetDir, cleanDir, err := svc.resolve(worktreeID, folderPath, true, false)
	if err != nil {
		return nil, err
	}
	if err := rejectReservedPath(cleanDir, true); err != nil {
		return nil, err
	}
	info, err := os.Stat(targetDir)
	if err != nil {
		return nil, fileOperationError("inspect upload folder", cleanDir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q is not a folder: %w", cleanDir, ErrValidation)
	}

	entries := make([]WorktreeFileEntry, 0, len(uploads))
	for _, upload := range uploads {
		name, err := safeUploadName(upload.Name)
		if err != nil {
			return nil, err
		}
		cleanPath := path.Join(cleanDir, name)
		if err := rejectReservedPath(cleanPath, false); err != nil {
			return nil, err
		}
		target := filepath.Join(targetDir, filepath.FromSlash(name))
		if err := ensureInside(root, target); err != nil {
			return nil, err
		}
		if existing, err := os.Stat(target); err == nil && existing.IsDir() {
			return nil, fmt.Errorf("%q is a folder: %w", cleanPath, ErrValidation)
		} else if err != nil && !os.IsNotExist(err) {
			return nil, fileOperationError("inspect upload target", cleanPath, err)
		}

		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return nil, fileOperationError("write upload", cleanPath, err)
		}
		_, copyErr := io.Copy(out, upload.Reader)
		closeErr := out.Close()
		if copyErr != nil {
			return nil, fileOperationError("write upload", cleanPath, copyErr)
		}
		if closeErr != nil {
			return nil, fileOperationError("write upload", cleanPath, closeErr)
		}
		info, err := os.Stat(target)
		if err != nil {
			return nil, fileOperationError("inspect upload", cleanPath, err)
		}
		entries = append(entries, WorktreeFileEntry{Name: name, Path: cleanPath, IsDir: false, Size: info.Size()})
	}
	return entries, nil
}

func (svc *WorktreeFileService) DeleteMany(worktreeID string, paths []string) error {
	selection, err := svc.resolveSelection(worktreeID, paths)
	if err != nil {
		return err
	}
	for _, item := range selection {
		if err := os.RemoveAll(item.target); err != nil {
			return fileOperationError("delete file", item.clean, err)
		}
	}
	return nil
}

func (svc *WorktreeFileService) Archive(worktreeID string, paths []string, dst io.Writer) error {
	selection, err := svc.resolveSelection(worktreeID, paths)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(dst)
	seen := make(map[string]bool)
	for _, item := range selection {
		if err := addPathToZip(zw, item, seen); err != nil {
			_ = zw.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("zip selection failed")
	}
	return nil
}

// Search returns relative file paths matched by regex syntax or forgiving
// case-insensitive path search. Directory matches are returned with a trailing
// slash when includeDirs is true.
func (svc *WorktreeFileService) Search(worktreeID, pattern string, includeDirs bool) ([]string, error) {
	root, _, _, err := svc.resolve(worktreeID, "", true, false)
	if err != nil {
		return nil, err
	}

	matcher := newFilePathMatcher(pattern)
	matches := make([]fileSearchMatch, 0)
	err = filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrPermission) {
				return nil
			}
			return walkErr
		}
		if current == root {
			return nil
		}
		if entry.IsDir() && searchSkipDirs[entry.Name()] {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if includeDirs {
				addFileSearchMatch(&matches, matcher, relative+"/", true)
			}
			return nil
		}
		addFileSearchMatch(&matches, matcher, relative, false)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("search files failed")
	}

	sort.Slice(matches, func(i, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score < matches[j].score
		}
		return matches[i].path < matches[j].path
	})
	if len(matches) > maxFileSearchResults {
		matches = matches[:maxFileSearchResults]
	}
	result := make([]string, 0, len(matches))
	for _, match := range matches {
		result = append(result, match.path)
	}
	return result, nil
}

type fileSearchMatch struct {
	path  string
	score int
}

type filePathMatcher struct {
	raw       string
	lower     string
	tokens    []string
	compact   string
	regex     *regexp.Regexp
	regexOnly bool
}

func newFilePathMatcher(pattern string) filePathMatcher {
	rawInput := strings.TrimSpace(pattern)
	if looksLikeRegex(rawInput) {
		if re, err := regexp.Compile(rawInput); err == nil {
			return filePathMatcher{raw: rawInput, lower: strings.ToLower(rawInput), regex: re, regexOnly: true}
		}
	}
	raw := strings.ReplaceAll(rawInput, "\\", "/")
	matcher := filePathMatcher{raw: raw, lower: strings.ToLower(raw)}
	matcher.tokens = searchTokens(raw)
	matcher.compact = compactSearchText(matcher.lower)
	return matcher
}

func looksLikeRegex(query string) bool {
	return strings.ContainsAny(query, `^$*+?()[]{}|`) || strings.Contains(query, `\.`)
}

func addFileSearchMatch(matches *[]fileSearchMatch, matcher filePathMatcher, candidate string, isDir bool) {
	if score, ok := matcher.score(candidate, isDir); ok {
		*matches = append(*matches, fileSearchMatch{path: candidate, score: score})
	}
}

func (matcher filePathMatcher) score(candidate string, isDir bool) (int, bool) {
	if matcher.raw == "" {
		score := 500 + strings.Count(candidate, "/")*8 + len(candidate)
		if isDir {
			score -= 4
		}
		return score, true
	}
	if matcher.regexOnly {
		if matcher.regex.MatchString(candidate) || matcher.regex.MatchString(strings.TrimSuffix(candidate, "/")) {
			return 0, true
		}
		return 0, false
	}

	lowerCandidate := strings.ToLower(candidate)
	cleanCandidate := strings.TrimSuffix(lowerCandidate, "/")
	cleanQuery := strings.TrimSuffix(matcher.lower, "/")
	base := path.Base(cleanCandidate)
	bias := 0
	if isDir {
		bias = -2
	}

	if cleanCandidate == cleanQuery || lowerCandidate == matcher.lower {
		return bias, true
	}
	if base == cleanQuery {
		return bias + 5, true
	}
	if strings.HasPrefix(lowerCandidate, matcher.lower) || strings.HasPrefix(cleanCandidate, cleanQuery) {
		return bias + 10 + len(cleanCandidate) - len(cleanQuery), true
	}
	if strings.HasPrefix(base, cleanQuery) {
		return bias + 25 + len(base) - len(cleanQuery), true
	}
	if index := strings.Index(lowerCandidate, matcher.lower); index >= 0 {
		return bias + 40 + index, true
	}
	if score, ok := tokenSequenceScore(lowerCandidate, matcher.tokens); ok {
		return bias + 80 + score, true
	}
	if score, ok := subsequenceScore(compactSearchText(cleanCandidate), matcher.compact); ok {
		return bias + 120 + score, true
	}
	return 0, false
}

func searchTokens(query string) []string {
	return strings.FieldsFunc(strings.ToLower(query), func(r rune) bool {
		switch r {
		case '/', '\\', ' ', '-', '_', '.':
			return true
		default:
			return false
		}
	})
}

func tokenSequenceScore(candidate string, tokens []string) (int, bool) {
	if len(tokens) == 0 {
		return 0, false
	}
	cursor := 0
	score := 0
	for _, token := range tokens {
		index := strings.Index(candidate[cursor:], token)
		if index < 0 {
			return 0, false
		}
		score += cursor + index
		cursor += index + len(token)
	}
	return score, true
}

func compactSearchText(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		switch r {
		case '/', '\\', ' ', '-', '_', '.':
			continue
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func subsequenceScore(candidate, query string) (int, bool) {
	if query == "" {
		return 0, true
	}
	queryIndex := 0
	previous := -1
	score := 0
	for index := 0; index < len(candidate); index++ {
		if candidate[index] != query[queryIndex] {
			continue
		}
		if previous >= 0 {
			score += index - previous - 1
		}
		previous = index
		queryIndex++
		if queryIndex == len(query) {
			return score, true
		}
	}
	return 0, false
}

type resolvedWorktreePath struct {
	clean  string
	target string
	info   fs.FileInfo
}

func (svc *WorktreeFileService) resolveSelection(worktreeID string, paths []string) ([]resolvedWorktreePath, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("at least one path is required: %w", ErrValidation)
	}
	cleaned := make([]string, 0, len(paths))
	seen := make(map[string]bool, len(paths))
	for _, raw := range paths {
		clean, err := normalizeRelativePath(raw, false)
		if err != nil {
			return nil, err
		}
		if err := rejectReservedPath(clean, false); err != nil {
			return nil, err
		}
		if seen[clean] {
			continue
		}
		seen[clean] = true
		cleaned = append(cleaned, clean)
	}
	if len(cleaned) == 0 {
		return nil, fmt.Errorf("at least one path is required: %w", ErrValidation)
	}
	sort.Slice(cleaned, func(i, j int) bool {
		if strings.Count(cleaned[i], "/") != strings.Count(cleaned[j], "/") {
			return strings.Count(cleaned[i], "/") < strings.Count(cleaned[j], "/")
		}
		return cleaned[i] < cleaned[j]
	})
	pruned := cleaned[:0]
	for _, candidate := range cleaned {
		nested := false
		for _, parent := range pruned {
			if strings.HasPrefix(candidate, parent+"/") {
				nested = true
				break
			}
		}
		if !nested {
			pruned = append(pruned, candidate)
		}
	}

	selection := make([]resolvedWorktreePath, 0, len(pruned))
	for _, clean := range pruned {
		_, target, _, err := svc.resolve(worktreeID, clean, false, false)
		if err != nil {
			return nil, err
		}
		info, err := os.Lstat(target)
		if err != nil {
			return nil, fileOperationError("inspect file", clean, err)
		}
		selection = append(selection, resolvedWorktreePath{clean: clean, target: target, info: info})
	}
	return selection, nil
}

func safeUploadName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || name == "." || name == ".." {
		return "", fmt.Errorf("file name is required: %w", ErrValidation)
	}
	if strings.ContainsAny(name, "/\\") || strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("file name must not contain folder separators: %w", ErrValidation)
	}
	if isReservedSegment(name) {
		return "", fmt.Errorf("%q is reserved: %w", name, ErrValidation)
	}
	return name, nil
}

func rejectReservedPath(clean string, allowRoot bool) error {
	if clean == "" {
		if allowRoot {
			return nil
		}
		return fmt.Errorf("file path is required: %w", ErrValidation)
	}
	for _, segment := range strings.Split(clean, "/") {
		if isReservedSegment(segment) {
			return fmt.Errorf("%q is reserved: %w", segment, ErrValidation)
		}
	}
	return nil
}

func isReservedSegment(segment string) bool {
	return segment == ".git" || segment == ".wt"
}

func addPathToZip(zw *zip.Writer, item resolvedWorktreePath, seen map[string]bool) error {
	if item.info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%q is a symlink: %w", item.clean, ErrValidation)
	}
	if !item.info.IsDir() {
		return addFileToZip(zw, item.target, item.clean, item.info, seen)
	}
	parent := filepath.Dir(item.target)
	return filepath.WalkDir(item.target, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrPermission) {
				return nil
			}
			return walkErr
		}
		if current != item.target && entry.IsDir() && isReservedSegment(entry.Name()) {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		relative, err := filepath.Rel(parent, current)
		if err != nil {
			return err
		}
		zipName := filepath.ToSlash(relative)
		info, err := entry.Info()
		if err != nil {
			return fileOperationError("inspect file", zipName, err)
		}
		if entry.IsDir() {
			return addDirToZip(zw, zipName, info, seen)
		}
		return addFileToZip(zw, current, zipName, info, seen)
	})
}

func addDirToZip(zw *zip.Writer, zipName string, info fs.FileInfo, seen map[string]bool) error {
	if !strings.HasSuffix(zipName, "/") {
		zipName += "/"
	}
	if seen[zipName] {
		return nil
	}
	seen[zipName] = true
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return fmt.Errorf("zip folder %q failed", zipName)
	}
	header.Name = zipName
	_, err = zw.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("zip folder %q failed", zipName)
	}
	return nil
}

func addFileToZip(zw *zip.Writer, filePath, zipName string, info fs.FileInfo, seen map[string]bool) error {
	if seen[zipName] {
		return nil
	}
	seen[zipName] = true
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	header.Name = zipName
	header.Method = zip.Deflate
	writer, err := zw.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	file, err := os.Open(filePath)
	if err != nil {
		return fileOperationError("read file", zipName, err)
	}
	defer file.Close()
	if _, err := io.Copy(writer, file); err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	return nil
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
