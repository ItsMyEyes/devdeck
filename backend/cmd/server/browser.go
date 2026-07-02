package main

import (
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"time"
)

func browserURL(addr net.Addr) (string, error) {
	_, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return "", fmt.Errorf("parse listen address %q: %w", addr.String(), err)
	}
	return "http://127.0.0.1:" + port, nil
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

func openBrowserSoon(url string) {
	go func() {
		time.Sleep(150 * time.Millisecond)
		if err := openBrowser(url); err != nil {
			fmt.Printf("open Loom UI at %s (%v)\n", url, err)
		}
	}()
}
