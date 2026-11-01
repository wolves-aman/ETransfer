//go:build dev

package main

import (
	"io/fs"
	"os"
	"path/filepath"

	"etransfer/internal/config"
)

func staticFS(cfg config.Config) (fs.FS, error) {
	dir := cfg.StaticDir
	if _, err := os.Stat(dir); err != nil {
		alt := filepath.Join("..", "frontend", "dist")
		if _, altErr := os.Stat(alt); altErr == nil {
			dir = alt
		}
	}
	return os.DirFS(dir), nil
}
