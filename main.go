package main

import (
	"fmt"
	"os"

	"go.uber.org/zap"

	"etransfer/internal/app"
	"etransfer/internal/config"
	"etransfer/internal/logging"
	"etransfer/internal/signaling"

	"github.com/gofiber/fiber/v3"
)

func main() {
	cfg := config.Load()
	logger := logging.New(cfg.LogLevel)
	defer func() {
		_ = logger.Sync()
	}()

	if err := run(cfg, logger); err != nil {
		logger.Fatal("server_failed", zap.Error(err))
		_ = logger.Sync()
		os.Exit(1)
	}
}

func run(cfg config.Config, logger *logging.Logger) error {
	static, err := staticFS(cfg)
	if err != nil {
		return fmt.Errorf("static init: %w", err)
	}

	server := signaling.New(cfg, logger)
	go server.SweepLoop()

	fiberApp := app.New(cfg, server, static, logger)
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	logger.Info("server_starting",
		zap.String("addr", addr),
		zap.String("transport", cfg.Transport),
		zap.String("static_dir", cfg.StaticDir),
	)
	return fiberApp.Listen(addr, fiber.ListenConfig{DisableStartupMessage: true})
}
