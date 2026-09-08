package service

import (
	"fmt"

	htmltomarkdown "github.com/JohannesKaufmann/html-to-markdown/v2"
)

// htmlToMarkdown converts HTML to GFM markdown via html-to-markdown (pure Go).
func htmlToMarkdown(data []byte) (string, error) {
	md, err := htmltomarkdown.ConvertString(string(data))
	if err != nil {
		return "", fmt.Errorf("convert html: %w", err)
	}
	return md, nil
}
