//go:build !dev

package main

import (
	"embed"
	"io/fs"

	"etransfer/internal/config"
)

//go:embed all:frontend/dist
var embeddedFrontend embed.FS

func staticFS(cfg config.Config) (fs.FS, error) {
	return fs.Sub(embeddedFrontend, "frontend/dist")
}
