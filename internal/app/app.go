package app

import (
	"io/fs"
	"strings"
	"time"

	"github.com/gofiber/contrib/v3/websocket"
	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/cors"
	"go.uber.org/zap"

	"etransfer/internal/config"
	"etransfer/internal/logging"
	"etransfer/internal/signaling"
	"etransfer/internal/web"
)

func New(cfg config.Config, server *signaling.Server, staticRoot fs.FS, logger *logging.Logger) *fiber.App {
	app := fiber.New(fiber.Config{
		BodyLimit: cfg.MaxPayload,
	})

	allowOrigins := []string{"*"}
	if len(cfg.AllowedOrigins) > 0 {
		allowOrigins = cfg.AllowedOrigins
	}
	app.Use(cors.New(cors.Config{
		AllowOrigins: allowOrigins,
		AllowHeaders: []string{"Content-Type"},
		AllowMethods: []string{"GET", "POST", "OPTIONS"},
	}))

	app.Use(func(c fiber.Ctx) error {
		requestID := c.Get("X-Request-ID")
		if requestID == "" {
			requestID = logging.NewID()
		}
		c.Set("X-Request-ID", requestID)
		c.Locals("request_id", requestID)
		start := time.Now()
		err := c.Next()
		if shouldLogAccess(c.Path()) {
			logger.Info("http_request",
				zap.String("request_id", requestID),
				zap.String("method", c.Method()),
				zap.String("path", c.Path()),
				zap.Int("status", c.Response().StatusCode()),
				zap.Int64("duration_ms", time.Since(start).Milliseconds()),
				zap.String("ip", c.IP()),
			)
		}
		return err
	})

	app.Get("/health", server.Health)

	if cfg.Transport != "ws" {
		app.Get("/api/events", server.HandleSSE)
		app.Post("/api/signal", server.HandleSignal)
	}

	if cfg.Transport != "sse" {
		app.Use("/ws", func(c fiber.Ctx) error {
			if websocket.IsWebSocketUpgrade(c) {
				return c.Next()
			}
			return fiber.ErrUpgradeRequired
		})
		app.Get("/ws", websocket.New(server.HandleWS))
	}

	app.All("/api/*", func(c fiber.Ctx) error {
		return c.Status(404).JSON(fiber.Map{"error": "API not found", "code": "NOT_FOUND"})
	})
	if cfg.Transport == "sse" {
		app.All("/ws", func(c fiber.Ctx) error {
			return c.Status(404).JSON(fiber.Map{"error": "WebSocket disabled", "code": "WS_DISABLED"})
		})
	}

	web.Mount(app, staticRoot)
	return app
}

func shouldLogAccess(path string) bool {
	if path == "/health" {
		return false
	}
	if path == "/ws" {
		return true
	}
	return strings.HasPrefix(path, "/api/")
}
