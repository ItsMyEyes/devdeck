// Package dbquery builds SQL fragments for the database module. It is
// engine-agnostic: per-engine differences arrive as port.DBCaps and a
// Placeholder function. Nothing here talks to a database.
package dbquery

import (
	"fmt"
	"strings"

	"devdeck/backend/internal/port"
)

// Placeholder renders the nth bind placeholder (1-based).
type Placeholder func(n int) string

// DollarPlaceholder renders PostgreSQL's $1, $2, … numbering.
func DollarPlaceholder(n int) string { return fmt.Sprintf("$%d", n) }

// QuestionPlaceholder renders the positional ? used by MySQL and SQLite.
func QuestionPlaceholder(int) string { return "?" }

// QuoteIdent wraps an identifier in the engine's quote character.
//
// Identifiers can never be bound as parameters, so this is the last line of
// defense. Callers must already have validated the name against an
// introspected list; an embedded quote character here means either a bug in
// that validation or a genuinely hostile name, and both are rejected rather
// than escaped.
func QuoteIdent(name, quoteChar string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("empty identifier")
	}
	if quoteChar == "" {
		return "", fmt.Errorf("no quote character configured for engine")
	}
	if strings.Contains(name, quoteChar) {
		return "", fmt.Errorf("identifier %q contains the quote character", name)
	}
	if strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("identifier contains a null byte")
	}
	return quoteChar + name + quoteChar, nil
}

// QuoteObject renders a fully qualified object name, including the schema on
// engines that have one.
func QuoteObject(obj port.ObjectRef, caps port.DBCaps) (string, error) {
	name, err := QuoteIdent(obj.Name, caps.QuoteChar)
	if err != nil {
		return "", err
	}
	if caps.Schemas && obj.Schema != "" {
		schema, err := QuoteIdent(obj.Schema, caps.QuoteChar)
		if err != nil {
			return "", err
		}
		return schema + "." + name, nil
	}
	return name, nil
}
