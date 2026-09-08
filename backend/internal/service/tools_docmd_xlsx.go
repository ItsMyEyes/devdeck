package service

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/xuri/excelize/v2"
)

// xlsxToMarkdown renders every sheet in a workbook as its own "## <sheet>"
// section followed by a GFM table, via excelize (pure Go, no cgo).
func xlsxToMarkdown(data []byte) (string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("open xlsx: %w", err)
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return "", fmt.Errorf("workbook has no sheets")
	}

	var sb strings.Builder
	for i, sheet := range sheets {
		rows, err := f.GetRows(sheet)
		if err != nil {
			return "", fmt.Errorf("read sheet %q: %w", sheet, err)
		}
		if i > 0 {
			sb.WriteString("\n")
		}
		if len(sheets) > 1 {
			sb.WriteString("## " + sheet + "\n\n")
		}
		if len(rows) == 0 {
			sb.WriteString("_(empty sheet)_\n")
			continue
		}
		sb.WriteString(rowsToMarkdownTable(rows))
	}
	return sb.String(), nil
}
