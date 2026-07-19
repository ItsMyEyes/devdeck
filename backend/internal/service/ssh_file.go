package service

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"

	"devdeck/backend/internal/sshmgr"
)

// sshSearchBudget bounds how long Search walks the remote tree before
// returning whatever it has found so far. Unlike WorktreeFileService.Search
// (local disk, effectively free), every directory descended here costs one
// SFTP round trip — a large or slow remote home directory could otherwise
// keep an interactive quick-open search spinning indefinitely.
const sshSearchBudget = 6 * time.Second

// SSHFileEntry is one visible item in an SSH connection's remote directory.
// Same shape as WorktreeFileEntry — kept as its own type since the two
// sources (a local worktree checkout vs. a remote host over SFTP) are
// otherwise unrelated, even though the frontend renders both with the same
// Explorer component.
type SSHFileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// SSHFileContent is the editable text representation of a remote file.
type SSHFileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SSHFileService provides file access to a saved SSH connection's remote
// filesystem over SFTP, rooted at the connection's home directory (SFTP's
// initial working directory) — mirrors WorktreeFileService's "no absolute
// paths, no .. traversal" contract via the same normalizeRelativePath, but
// there is no symlink-escape hardening here: unlike a worktree checkout
// (where escaping the root is a real security boundary), the remote sshd
// already governs what this user's session can reach, so there is nothing
// extra for DevDeck to enforce.
type SSHFileService struct {
	pool *sshmgr.FilePool
}

func NewSSHFileService(pool *sshmgr.FilePool) *SSHFileService {
	return &SSHFileService{pool: pool}
}

// remoteAbsPath resolves clean (already normalizeRelativePath'd) against the
// connection's home directory. Re-fetches the home dir on every call rather
// than caching it — an extra SFTP REALPATH round trip is imperceptible next
// to a human clicking through a file tree, and it keeps the pool free of
// per-connection cached state that would need invalidating on redial.
func remoteAbsPath(client *sftp.Client, clean string) (string, error) {
	home, err := client.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolve home directory failed")
	}
	if clean == "" {
		return home, nil
	}
	return path.Join(home, clean), nil
}

func (svc *SSHFileService) List(ctx context.Context, connectionID, relativePath string) ([]SSHFileEntry, error) {
	clean, err := normalizeRelativePath(relativePath, true)
	if err != nil {
		return nil, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) ([]SSHFileEntry, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return nil, err
		}
		infos, err := client.ReadDir(abs)
		if err != nil {
			return nil, fileOperationError("read folder", clean, err)
		}
		result := make([]SSHFileEntry, 0, len(infos))
		for _, info := range infos {
			size := int64(0)
			if !info.IsDir() {
				size = info.Size()
			}
			result = append(result, SSHFileEntry{
				Name:  info.Name(),
				Path:  path.Join(clean, info.Name()),
				IsDir: info.IsDir(),
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
	})
}

// Search returns remote file paths matched by the same fuzzy/regex matcher
// as WorktreeFileService.Search (shared filePathMatcher, searchSkipDirs,
// maxFileSearchResults — defined in worktree_file.go, same package), walked
// over SFTP instead of the local filesystem.
func (svc *SSHFileService) Search(ctx context.Context, connectionID, pattern string, includeDirs bool) ([]string, error) {
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) ([]string, error) {
		home, err := client.Getwd()
		if err != nil {
			return nil, fmt.Errorf("resolve home directory failed")
		}
		homePrefix := strings.TrimSuffix(home, "/") + "/"

		matcher := newFilePathMatcher(pattern)
		matches := make([]fileSearchMatch, 0)
		deadline := time.Now().Add(sshSearchBudget)
		walker := client.Walk(home)
		for walker.Step() {
			if time.Now().After(deadline) {
				break // time's up — return the best matches found so far rather than hang
			}
			current := walker.Path()
			if current == home {
				continue
			}
			if walker.Err() != nil {
				continue // permission-denied entries are skipped, mirroring the worktree walker's fs.ErrPermission handling
			}
			info := walker.Stat()
			if info.IsDir() && searchSkipDirs[info.Name()] {
				walker.SkipDir()
				continue
			}
			if info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			relative := strings.TrimPrefix(current, homePrefix)
			if info.IsDir() {
				if includeDirs {
					addFileSearchMatch(&matches, matcher, relative+"/", true)
				}
				continue
			}
			addFileSearchMatch(&matches, matcher, relative, false)
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
	})
}

func (svc *SSHFileService) Read(ctx context.Context, connectionID, relativePath string) (SSHFileContent, error) {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return SSHFileContent{}, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileContent, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return SSHFileContent{}, err
		}
		info, err := client.Stat(abs)
		if err != nil {
			return SSHFileContent{}, fileOperationError("read file", clean, err)
		}
		if info.IsDir() {
			return SSHFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
		}
		if info.Size() > maxEditableFileSize {
			return SSHFileContent{}, fmt.Errorf(
				"%q is larger than the %d MB editor limit: %w",
				clean,
				maxEditableFileSize/(1<<20),
				ErrValidation,
			)
		}
		file, err := client.Open(abs)
		if err != nil {
			return SSHFileContent{}, fileOperationError("read file", clean, err)
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil {
			return SSHFileContent{}, fileOperationError("read file", clean, err)
		}
		if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			return SSHFileContent{}, fmt.Errorf("%q is not a UTF-8 text file: %w", clean, ErrValidation)
		}
		return SSHFileContent{Path: clean, Content: string(data)}, nil
	})
}

func (svc *SSHFileService) Write(ctx context.Context, connectionID, relativePath, content string) (SSHFileContent, error) {
	if len(content) > maxEditableFileSize {
		return SSHFileContent{}, fmt.Errorf(
			"content is larger than the %d MB editor limit: %w",
			maxEditableFileSize/(1<<20),
			ErrValidation,
		)
	}
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return SSHFileContent{}, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (SSHFileContent, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return SSHFileContent{}, err
		}
		if info, statErr := client.Stat(abs); statErr == nil {
			if info.IsDir() {
				return SSHFileContent{}, fmt.Errorf("%q is a folder: %w", clean, ErrValidation)
			}
		} else if !os.IsNotExist(statErr) {
			return SSHFileContent{}, fileOperationError("inspect file", clean, statErr)
		}

		out, err := client.Create(abs)
		if err != nil {
			return SSHFileContent{}, fileOperationError("write file", clean, err)
		}
		_, writeErr := out.Write([]byte(content))
		closeErr := out.Close()
		if writeErr != nil {
			return SSHFileContent{}, fileOperationError("write file", clean, writeErr)
		}
		if closeErr != nil {
			return SSHFileContent{}, fileOperationError("write file", clean, closeErr)
		}
		return SSHFileContent{Path: clean, Content: content}, nil
	})
}

func (svc *SSHFileService) Delete(ctx context.Context, connectionID, relativePath string) error {
	clean, err := normalizeRelativePath(relativePath, false)
	if err != nil {
		return err
	}
	_, err = sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		abs, err := remoteAbsPath(client, clean)
		if err != nil {
			return struct{}{}, err
		}
		if err := client.Remove(abs); err != nil {
			return struct{}{}, fileOperationError("delete file", clean, err)
		}
		return struct{}{}, nil
	})
	return err
}

func (svc *SSHFileService) Upload(ctx context.Context, connectionID, folderPath string, uploads []WorktreeUploadFile) ([]SSHFileEntry, error) {
	if len(uploads) == 0 {
		return nil, fmt.Errorf("at least one file is required: %w", ErrValidation)
	}
	cleanDir, err := normalizeRelativePath(folderPath, true)
	if err != nil {
		return nil, err
	}
	return sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) ([]SSHFileEntry, error) {
		absDir, err := remoteAbsPath(client, cleanDir)
		if err != nil {
			return nil, err
		}
		info, err := client.Stat(absDir)
		if err != nil {
			return nil, fileOperationError("inspect upload folder", cleanDir, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("%q is not a folder: %w", cleanDir, ErrValidation)
		}

		entries := make([]SSHFileEntry, 0, len(uploads))
		for _, upload := range uploads {
			name, err := safeUploadName(upload.Name)
			if err != nil {
				return nil, err
			}
			cleanPath := path.Join(cleanDir, name)
			abs := path.Join(absDir, name)
			if existing, statErr := client.Stat(abs); statErr == nil && existing.IsDir() {
				return nil, fmt.Errorf("%q is a folder: %w", cleanPath, ErrValidation)
			} else if statErr != nil && !os.IsNotExist(statErr) {
				return nil, fileOperationError("inspect upload target", cleanPath, statErr)
			}

			out, err := client.Create(abs)
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
			written, err := client.Stat(abs)
			if err != nil {
				return nil, fileOperationError("inspect upload", cleanPath, err)
			}
			entries = append(entries, SSHFileEntry{Name: name, Path: cleanPath, IsDir: false, Size: written.Size()})
		}
		return entries, nil
	})
}

func (svc *SSHFileService) DeleteMany(ctx context.Context, connectionID string, paths []string) error {
	pruned, err := cleanAndPruneSelection(paths, nil)
	if err != nil {
		return err
	}
	_, err = sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		for _, clean := range pruned {
			abs, err := remoteAbsPath(client, clean)
			if err != nil {
				return struct{}{}, err
			}
			if err := client.RemoveAll(abs); err != nil {
				return struct{}{}, fileOperationError("delete file", clean, err)
			}
		}
		return struct{}{}, nil
	})
	return err
}

func (svc *SSHFileService) Archive(ctx context.Context, connectionID string, paths []string, dst io.Writer) error {
	pruned, err := cleanAndPruneSelection(paths, nil)
	if err != nil {
		return err
	}
	_, err = sshmgr.WithSFTPClient(ctx, svc.pool, connectionID, func(client *sftp.Client) (struct{}, error) {
		zw := zip.NewWriter(dst)
		seen := make(map[string]bool)
		for _, clean := range pruned {
			abs, err := remoteAbsPath(client, clean)
			if err != nil {
				_ = zw.Close()
				return struct{}{}, err
			}
			info, err := client.Lstat(abs)
			if err != nil {
				_ = zw.Close()
				return struct{}{}, fileOperationError("inspect file", clean, err)
			}
			if err := addRemoteSelectionToZip(client, zw, abs, clean, info, seen); err != nil {
				_ = zw.Close()
				return struct{}{}, err
			}
		}
		if err := zw.Close(); err != nil {
			return struct{}{}, fmt.Errorf("zip selection failed")
		}
		return struct{}{}, nil
	})
	return err
}

func addRemoteSelectionToZip(client *sftp.Client, zw *zip.Writer, abs, clean string, info os.FileInfo, seen map[string]bool) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%q is a symlink: %w", clean, ErrValidation)
	}
	if !info.IsDir() {
		return addRemoteFileToZip(client, zw, abs, clean, info, seen)
	}

	parentPrefix := path.Dir(abs) + "/"
	walker := client.Walk(abs)
	for walker.Step() {
		if walker.Err() != nil {
			continue // permission-denied entries are skipped, mirroring the worktree archiver's fs.ErrPermission handling
		}
		current := walker.Path()
		entryInfo := walker.Stat()
		if entryInfo.Mode()&os.ModeSymlink != 0 {
			continue
		}
		zipName := strings.TrimPrefix(current, parentPrefix)
		if entryInfo.IsDir() {
			if err := addRemoteDirToZip(zw, zipName, entryInfo, seen); err != nil {
				return err
			}
			continue
		}
		if err := addRemoteFileToZip(client, zw, current, zipName, entryInfo, seen); err != nil {
			return err
		}
	}
	return nil
}

func addRemoteDirToZip(zw *zip.Writer, zipName string, info os.FileInfo, seen map[string]bool) error {
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
	if _, err := zw.CreateHeader(header); err != nil {
		return fmt.Errorf("zip folder %q failed", zipName)
	}
	return nil
}

func addRemoteFileToZip(client *sftp.Client, zw *zip.Writer, abs, zipName string, info os.FileInfo, seen map[string]bool) error {
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
	file, err := client.Open(abs)
	if err != nil {
		return fileOperationError("read file", zipName, err)
	}
	defer file.Close()
	if _, err := io.Copy(writer, file); err != nil {
		return fmt.Errorf("zip file %q failed", zipName)
	}
	return nil
}
