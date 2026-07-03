// Package config loads optional local configuration for the server, such as
// a .env file supplying LLM API credentials for the Tools module.
package config

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// LoadDotEnv reads KEY=VALUE lines from path and applies them to the process
// environment, skipping any key that's already set (real environment
// variables always win over the file). Blank lines and lines starting with
// # are ignored. A missing file is not an error — .env is optional.
// Returns the number of variables applied.
func LoadDotEnv(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	applied := 0
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = unquote(strings.TrimSpace(value))
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return applied, fmt.Errorf("set %s: %w", key, err)
		}
		applied++
	}
	if err := scanner.Err(); err != nil {
		return applied, fmt.Errorf("read %s: %w", path, err)
	}
	return applied, nil
}

func unquote(v string) string {
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}
