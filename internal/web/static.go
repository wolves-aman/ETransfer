package web

import (
	"io/fs"
	"mime"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v3"
)

// Mount serves the embedded or development frontend with SPA fallback.
func Mount(app *fiber.App, root fs.FS) {
	app.Use(func(c fiber.Ctx) error {
		path := strings.TrimPrefix(c.Path(), "/")
		if path == "" {
			path = "index.html"
		}

		if data, err := fs.ReadFile(root, path); err == nil {
			setContentType(c, path)
			return c.Send(data)
		}

		if strings.HasPrefix(c.Path(), "/api/") || filepath.Ext(path) != "" {
			return c.SendStatus(404)
		}

		data, err := fs.ReadFile(root, "index.html")
		if err != nil {
			return c.Status(404).SendString("frontend/dist not found")
		}
		c.Set("Content-Type", "text/html; charset=utf-8")
		return c.Send(data)
	})
}

func setContentType(c fiber.Ctx, path string) {
	if ext := filepath.Ext(path); ext != "" {
		if value := mime.TypeByExtension(ext); value != "" {
			c.Set("Content-Type", value)
			return
		}
	}
	if strings.HasSuffix(path, ".js") {
		c.Set("Content-Type", "text/javascript; charset=utf-8")
	}
}
