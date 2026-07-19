package detect

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

const maxSkillContentBytes = 2 << 20

type skillLocation struct {
	dir      string
	readOnly bool
}

type skillContentTarget struct {
	path     string
	readOnly bool
	linked   bool
}

// ReadSkills reads skills installed in the local directories understood by an
// agent. A nil result means no readable skill directory was found.
func ReadSkills(agentID string) []domain.Skill {
	locations, err := agentSkillLocations(agentID)
	if err != nil {
		return nil
	}

	byName := make(map[string]domain.Skill)
	foundDirectory := false
	for _, location := range locations {
		entries, err := os.ReadDir(location.dir)
		if err != nil {
			continue
		}
		foundDirectory = true
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			skillDir := filepath.Join(location.dir, entry.Name())
			info, err := os.Stat(skillDir)
			if err != nil || !info.IsDir() {
				continue
			}
			skill, ok := parseSkill(filepath.Join(skillDir, "SKILL.md"))
			if !ok {
				continue
			}
			skill.ReadOnly = location.readOnly
			if existing, exists := byName[skill.Name]; !exists || existing.ReadOnly {
				byName[skill.Name] = skill
			}
		}
	}
	if !foundDirectory {
		return nil
	}

	skills := make([]domain.Skill, 0, len(byName))
	for _, skill := range byName {
		skills = append(skills, skill)
	}
	sort.Slice(skills, func(i, j int) bool {
		return strings.ToLower(skills[i].Name) < strings.ToLower(skills[j].Name)
	})
	return skills
}

// ReadSkillContent returns one installed skill's fixed SKILL.md file and its
// effective mutability. Linked skills are writable only when their resolved
// source remains inside a configured writable skill root.
func ReadSkillContent(agentID, skillName string) (content string, readOnly, linked bool, err error) {
	target, err := resolveSkillContentTarget(agentID, skillName)
	if err != nil {
		return "", false, false, err
	}
	raw, err := readSkillContentFile(target.path)
	if err != nil {
		return "", false, false, err
	}
	if err := validateSkillContent(raw, skillName); err != nil {
		return "", false, false, err
	}
	return string(raw), target.readOnly, target.linked, nil
}

// WriteSkillContent atomically replaces one installed skill's SKILL.md file.
func WriteSkillContent(agentID, skillName, content string) error {
	target, err := resolveSkillContentTarget(agentID, skillName)
	if err != nil {
		return err
	}
	if target.readOnly {
		return fmt.Errorf("skill %q is read-only: %w", skillName, port.ErrIntegrationConflict)
	}
	raw := []byte(content)
	if err := validateSkillContent(raw, skillName); err != nil {
		return err
	}
	info, err := os.Stat(target.path)
	if err != nil {
		return err
	}
	mode := info.Mode().Perm()
	if mode == 0 {
		mode = 0o600
	}
	return atomicWrite(target.path, raw, mode)
}

func resolveSkillContentTarget(agentID, skillName string) (skillContentTarget, error) {
	if err := validateSkillName(skillName); err != nil {
		return skillContentTarget{}, err
	}
	locations, err := agentSkillLocations(agentID)
	if err != nil {
		return skillContentTarget{}, err
	}

	var selected skillContentTarget
	found := false
	for _, location := range locations {
		entries, err := os.ReadDir(location.dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			skillDir := filepath.Join(location.dir, entry.Name())
			info, err := os.Lstat(skillDir)
			if err != nil {
				continue
			}
			resolvedDir, err := filepath.EvalSymlinks(skillDir)
			if err != nil {
				continue
			}
			resolvedInfo, err := os.Stat(resolvedDir)
			if err != nil || !resolvedInfo.IsDir() {
				continue
			}
			contentPath := filepath.Join(resolvedDir, "SKILL.md")
			skill, ok := parseSkill(contentPath)
			if !ok || skill.Name != skillName {
				continue
			}
			linked := info.Mode()&os.ModeSymlink != 0
			readOnly := location.readOnly
			if linked && !readOnly {
				writable, err := isManagedWritableSkillTarget(resolvedDir)
				if err != nil {
					return skillContentTarget{}, err
				}
				readOnly = !writable
			}
			candidate := skillContentTarget{path: contentPath, readOnly: readOnly, linked: linked}
			if !found || (selected.readOnly && !candidate.readOnly) {
				selected = candidate
				found = true
			}
		}
	}
	if !found {
		return skillContentTarget{}, fmt.Errorf("skill %q is not installed: %w", skillName, port.ErrIntegrationNotFound)
	}
	return selected, nil
}

func isManagedWritableSkillTarget(target string) (bool, error) {
	ids := []string{"claude", "codex", "pi", "opencode", "gemini"}
	writable := false
	for _, agentID := range ids {
		locations, err := agentSkillLocations(agentID)
		if err != nil {
			return false, err
		}
		for _, location := range locations {
			contains, err := pathContains(location.dir, target)
			if err != nil {
				return false, err
			}
			if !contains {
				continue
			}
			if location.readOnly {
				return false, nil
			}
			writable = true
		}
	}
	return writable, nil
}

func pathContains(root, target string) (bool, error) {
	rootPath, err := filepath.Abs(root)
	if err != nil {
		return false, err
	}
	if resolved, err := filepath.EvalSymlinks(rootPath); err == nil {
		rootPath = resolved
	}
	targetPath, err := filepath.Abs(target)
	if err != nil {
		return false, err
	}
	relative, err := filepath.Rel(rootPath, targetPath)
	if err != nil {
		return false, err
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) && !filepath.IsAbs(relative), nil
}

func readSkillContentFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxSkillContentBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxSkillContentBytes {
		return nil, fmt.Errorf("skill content exceeds %d bytes: %w", maxSkillContentBytes, port.ErrIntegrationConflict)
	}
	return raw, nil
}

func validateSkillContent(content []byte, expectedName string) error {
	if len(content) > maxSkillContentBytes {
		return fmt.Errorf("skill content exceeds %d bytes: %w", maxSkillContentBytes, port.ErrIntegrationConflict)
	}
	if !utf8.Valid(content) {
		return fmt.Errorf("skill content must be valid UTF-8: %w", port.ErrIntegrationConflict)
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return fmt.Errorf("skill content contains a NUL byte: %w", port.ErrIntegrationConflict)
	}
	skill, ok := parseSkillReader(bytes.NewReader(content))
	if !ok {
		return fmt.Errorf("skill content must include valid frontmatter with a name: %w", port.ErrIntegrationConflict)
	}
	if skill.Name != expectedName {
		return fmt.Errorf("skill name must remain %q: %w", expectedName, port.ErrIntegrationConflict)
	}
	return nil
}

// InstallSkill links a skill that already exists in another supported agent's
// library into the target agent. It falls back to a bounded directory copy on
// systems where symlink creation is unavailable.
func InstallSkill(agentID, skillName string) error {
	if err := validateSkillName(skillName); err != nil {
		return err
	}
	targetRoot, err := writableSkillDir(agentID)
	if err != nil {
		return err
	}
	target := filepath.Join(targetRoot, skillName)
	if _, err := os.Lstat(target); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	source, err := findSkillSource(skillName)
	if err != nil {
		return err
	}
	if filepath.Clean(source) == filepath.Clean(target) {
		return nil
	}
	if err := os.MkdirAll(targetRoot, 0o700); err != nil {
		return fmt.Errorf("create skill directory: %w", err)
	}
	if err := os.Symlink(source, target); err == nil {
		return nil
	} else if runtime.GOOS != "windows" {
		return fmt.Errorf("link skill into %s: %w", agentID, err)
	}
	if err := copySkillDir(source, target); err != nil {
		_ = os.RemoveAll(target)
		return err
	}
	return nil
}

// RemoveSkill uninstalls a skill from one agent. Real directories are moved to
// ~/.devdeck/trash/skills instead of being permanently deleted.
func RemoveSkill(agentID, skillName string) error {
	if err := validateSkillName(skillName); err != nil {
		return err
	}
	root, err := writableSkillDir(agentID)
	if err != nil {
		return err
	}
	target := filepath.Join(root, skillName)
	info, err := os.Lstat(target)
	if errors.Is(err, fs.ErrNotExist) {
		return port.ErrIntegrationNotFound
	}
	if err != nil {
		return err
	}

	if info.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(target); err != nil {
			return fmt.Errorf("remove skill link: %w", err)
		}
		return nil
	}
	if !info.IsDir() {
		return fmt.Errorf("skill path is not a directory: %w", port.ErrIntegrationConflict)
	}

	dependents, err := dependentSkillLinks(target, agentID)
	if err != nil {
		return err
	}
	if len(dependents) > 0 {
		return fmt.Errorf(
			"skill is linked by %s; remove it there first: %w",
			strings.Join(dependents, ", "),
			port.ErrIntegrationConflict,
		)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	trashRoot := filepath.Join(home, ".devdeck", "trash", "skills", agentID)
	if err := os.MkdirAll(trashRoot, 0o700); err != nil {
		return fmt.Errorf("create skill trash: %w", err)
	}
	trashName := fmt.Sprintf("%s-%s", skillName, time.Now().UTC().Format("20060102T150405.000000000"))
	if err := os.Rename(target, filepath.Join(trashRoot, trashName)); err != nil {
		return fmt.Errorf("move skill to trash: %w", err)
	}
	return nil
}

func agentSkillLocations(agentID string) ([]skillLocation, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	switch agentID {
	case "claude":
		return []skillLocation{{dir: filepath.Join(home, ".claude", "skills")}}, nil
	case "codex":
		return []skillLocation{
			{dir: filepath.Join(home, ".agents", "skills")},
			{dir: filepath.Join(home, ".codex", "skills")},
			{dir: filepath.Join(home, ".codex", "skills", ".system"), readOnly: true},
		}, nil
	case "pi":
		return []skillLocation{{dir: filepath.Join(home, ".pi", "agent", "skills")}}, nil
	case "opencode":
		return []skillLocation{{dir: filepath.Join(home, ".config", "opencode", "skills")}}, nil
	case "gemini":
		return []skillLocation{{dir: filepath.Join(home, ".gemini", "skills")}}, nil
	default:
		return nil, port.ErrAgentManagementUnsupported
	}
}

func writableSkillDir(agentID string) (string, error) {
	locations, err := agentSkillLocations(agentID)
	if err != nil {
		return "", err
	}
	for _, location := range locations {
		if !location.readOnly {
			return location.dir, nil
		}
	}
	return "", port.ErrAgentManagementUnsupported
}

func allWritableSkillLocations() ([]struct {
	agentID string
	dir     string
}, error) {
	ids := []string{"claude", "codex", "pi", "opencode", "gemini"}
	locations := make([]struct {
		agentID string
		dir     string
	}, 0, len(ids))
	for _, agentID := range ids {
		dir, err := writableSkillDir(agentID)
		if err != nil {
			return nil, err
		}
		locations = append(locations, struct {
			agentID string
			dir     string
		}{agentID: agentID, dir: dir})
	}
	return locations, nil
}

func findSkillSource(skillName string) (string, error) {
	locations, err := allWritableSkillLocations()
	if err != nil {
		return "", err
	}
	for _, location := range locations {
		candidate := filepath.Join(location.dir, skillName)
		info, err := os.Stat(filepath.Join(candidate, "SKILL.md"))
		if err == nil && !info.IsDir() {
			resolved, err := filepath.EvalSymlinks(candidate)
			if err != nil {
				return "", err
			}
			return resolved, nil
		}
	}
	return "", fmt.Errorf("skill %q is not installed in another agent: %w", skillName, port.ErrIntegrationNotFound)
}

func dependentSkillLinks(target, excludingAgentID string) ([]string, error) {
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return nil, err
	}
	locations, err := allWritableSkillLocations()
	if err != nil {
		return nil, err
	}
	var dependents []string
	for _, location := range locations {
		if location.agentID == excludingAgentID {
			continue
		}
		link := filepath.Join(location.dir, filepath.Base(target))
		info, err := os.Lstat(link)
		if err != nil || info.Mode()&os.ModeSymlink == 0 {
			continue
		}
		resolved, err := filepath.EvalSymlinks(link)
		if err == nil && filepath.Clean(resolved) == filepath.Clean(resolvedTarget) {
			dependents = append(dependents, location.agentID)
		}
	}
	sort.Strings(dependents)
	return dependents, nil
}

func validateSkillName(name string) error {
	if name == "" || strings.HasPrefix(name, ".") || len(name) > 128 {
		return fmt.Errorf("invalid skill name: %w", port.ErrIntegrationConflict)
	}
	for _, r := range name {
		if (r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			r == '-' || r == '_' || r == '.' || r == ':' || r == '@' {
			continue
		}
		return fmt.Errorf("invalid skill name: %w", port.ErrIntegrationConflict)
	}
	return nil
}

func copySkillDir(source, target string) error {
	const (
		maxFiles = 2_000
		maxBytes = int64(64 << 20)
	)
	files := 0
	bytes := int64(0)
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("skill contains unsupported symlink %q", relative)
		}
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o700)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files++
		bytes += info.Size()
		if files > maxFiles || bytes > maxBytes {
			return fmt.Errorf("skill exceeds the copy safety limit")
		}
		sourceFile, err := os.Open(path)
		if err != nil {
			return err
		}
		defer sourceFile.Close()
		destinationFile, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(destinationFile, sourceFile)
		closeErr := destinationFile.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

// parseSkill reads a SKILL.md file and extracts the small frontmatter subset
// needed by the management UI without introducing a YAML dependency.
func parseSkill(path string) (domain.Skill, bool) {
	file, err := os.Open(path)
	if err != nil {
		return domain.Skill{}, false
	}
	defer file.Close()
	return parseSkillReader(file)
}

func parseSkillReader(reader io.Reader) (domain.Skill, bool) {
	var (
		inFrontmatter bool
		started       bool
		closed        bool
		name          string
		description   []string
		category      string
		inDescription bool
	)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4<<10), 256<<10)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if !started && trimmed == "---" {
			started = true
			inFrontmatter = true
			continue
		}
		if inFrontmatter && trimmed == "---" {
			closed = true
			break
		}
		if !inFrontmatter {
			continue
		}
		if inDescription {
			if line == "" || strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t") {
				if trimmed != "" {
					description = append(description, trimmed)
				}
				continue
			}
			inDescription = false
		}
		switch {
		case strings.HasPrefix(line, "name:"):
			name = cleanYAMLScalar(strings.TrimSpace(strings.TrimPrefix(line, "name:")))
		case strings.HasPrefix(line, "description:"):
			value := strings.TrimSpace(strings.TrimPrefix(line, "description:"))
			if value == "|" || value == ">" {
				inDescription = true
			} else if value != "" {
				description = append(description, cleanYAMLScalar(value))
			}
		case strings.HasPrefix(trimmed, "category:"):
			category = cleanYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "category:")))
		}
	}
	if name == "" || !closed {
		return domain.Skill{}, false
	}
	if category == "" {
		category = "general"
	}
	return domain.Skill{
		Name:        name,
		Description: strings.Join(description, " "),
		Category:    category,
	}, true
}

func cleanYAMLScalar(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') ||
			(value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}
