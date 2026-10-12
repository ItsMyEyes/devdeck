package detect

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"devdeck/backend/internal/domain"
)

func readAntigravityModels(ctx context.Context) ([]domain.Model, error) {
	bin, err := Resolve("antigravity")
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, bin, "models")
	cmd.Env = AugmentedEnv()
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("agy models failed; check CLI login and connectivity")
	}
	models := parseAntigravityModels(string(out))
	if len(models) == 0 {
		return nil, fmt.Errorf("agy models returned no models")
	}
	// Empty model means let agy choose its configured default.
	return append([]domain.Model{{ID: "", Name: "CLI default"}}, models...), nil
}

func parseAntigravityModels(out string) []domain.Model {
	models := []domain.Model{}
	seen := map[string]bool{}
	for _, line := range strings.Split(stripANSI(out), "\n") {
		id, name, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if !ok || id == "" || strings.ContainsAny(id, " \r\n") || strings.TrimSpace(name) == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, domain.Model{ID: id, Name: strings.TrimSpace(name)})
	}
	return models
}
