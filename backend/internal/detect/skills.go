package detect

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"

	"loom/backend/internal/domain"
)

// ReadSkills reads installed skills for the given agent from its local config.
// Returns nil if the agent is not detected or its config is unreadable —
// callers should fall back to the registry's static data.
func ReadSkills(agentID string) []domain.Skill {
	switch agentID {
	case "claude":
		return readClaudeSkills()
	case "codex":
		return readCodexSkills()
	default:
		return nil
	}
}

// ---- Claude skills (~/.claude/skills/<name>/SKILL.md) ----

func claudeSkillsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "skills"), nil
}

func readClaudeSkills() []domain.Skill {
	dir, err := claudeSkillsDir()
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var skills []domain.Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		skillPath := filepath.Join(dir, entry.Name(), "SKILL.md")
		s, ok := parseClaudeSkill(skillPath)
		if !ok {
			continue
		}
		skills = append(skills, s)
	}
	if len(skills) == 0 {
		return nil
	}
	return skills
}

// parseClaudeSkill reads a SKILL.md file and extracts the frontmatter fields.
// The format is YAML between --- delimiters:
//
//	---
//	name: my-skill
//	description: Does something
//	od:
//	  category: analysis
//	---
func parseClaudeSkill(path string) (domain.Skill, bool) {
	f, err := os.Open(path)
	if err != nil {
		return domain.Skill{}, false
	}
	defer f.Close()

	var (
		inFrontmatter bool
		started       bool
		name          string
		descLines     []string
		category      string
		inDesc        bool
		descIndent    string
	)

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()

		if !started && strings.TrimSpace(line) == "---" {
			started = true
			inFrontmatter = true
			continue
		}
		if inFrontmatter && strings.TrimSpace(line) == "---" {
			break // end of frontmatter
		}
		if !inFrontmatter {
			continue
		}

		// Handle multi-line description continuation (| style)
		if inDesc {
			if strings.HasPrefix(line, descIndent+"  ") || strings.TrimSpace(line) == "" {
				trimmed := strings.TrimSpace(line)
				if trimmed != "" {
					descLines = append(descLines, trimmed)
				}
				continue
			}
			// Description ended — flush and continue parsing
			inDesc = false
			// fall through to parse this line as a new key
		}

		// Skip empty lines in frontmatter
		if strings.TrimSpace(line) == "" {
			continue
		}

		// Check for nested keys first (od:)
		if strings.HasPrefix(line, "  category:") || strings.HasPrefix(line, "\tcategory:") {
			category = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "  category:"), "\tcategory:"))
			category = strings.TrimSpace(category)
			continue
		}

		// name:
		if strings.HasPrefix(line, "name:") {
			name = strings.TrimSpace(strings.TrimPrefix(line, "name:"))
			continue
		}

		// description: (simple one-line)
		if strings.HasPrefix(line, "description:") {
			rest := strings.TrimSpace(strings.TrimPrefix(line, "description:"))
			if rest == "|" {
				// Multi-line description following
				inDesc = true
				descIndent = line[:len(line)-len(strings.TrimLeft(line, " \t"))]
				continue
			}
			if rest != "" {
				descLines = append(descLines, rest)
			}
			continue
		}
	}

	if name == "" {
		return domain.Skill{}, false
	}

	desc := strings.Join(descLines, " ")
	return domain.Skill{
		Name:        name,
		Description: desc,
		Category:    category,
	}, true
}

// ---- Codex skills (~/.codex/config.toml plugins) ----

func readCodexSkills() []domain.Skill {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	configPath := filepath.Join(home, ".codex", "config.toml")
	f, err := os.Open(configPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	var skills []domain.Skill
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Match [plugins."name@source"] sections
		if strings.HasPrefix(line, "[plugins.") && strings.HasSuffix(line, "]") {
			inner := line[len("[plugins.") : len(line)-1]
			name := strings.Trim(inner, `"`)
			skills = append(skills, domain.Skill{
				Name:        name,
				Description: "Codex plugin: " + name,
				Category:    "plugin",
			})
		}
	}
	if len(skills) == 0 {
		return nil
	}
	return skills
}
