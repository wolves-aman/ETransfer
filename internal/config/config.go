package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Host            string
	Port            int
	Transport       string
	StaticDir       string
	AllowedOrigins  []string
	MaxUsers        int
	MaxRoomIDLength int
	DefaultExpiry   int
	MaxExpiry       int
	MaxPayload      int
	Heartbeat       time.Duration
	Sweep           time.Duration
	LogLevel        string
	StatsFile       string
	ProxyHeader     string
}

func Load() Config {
	cfg := Config{
		Host:            env("HOST", "0.0.0.0"),
		Port:            envInt("PORT", 9090),
		Transport:       strings.ToLower(env("SIGNAL_TRANSPORT", "both")),
		StaticDir:       env("STATIC_DIR", "frontend/dist"),
		AllowedOrigins:  splitList(os.Getenv("ALLOWED_ORIGINS")),
		MaxUsers:        envInt("MAX_USERS", 8),
		MaxRoomIDLength: envInt("MAX_ROOM_ID_LENGTH", 12),
		DefaultExpiry:   envInt("DEFAULT_EXPIRY_MINUTES", 180),
		MaxExpiry:       envInt("MAX_EXPIRY_MINUTES", 1440),
		MaxPayload:      envInt("MAX_PAYLOAD", 65536),
		Heartbeat:       time.Duration(envInt("HEARTBEAT_INTERVAL", 30000)) * time.Millisecond,
		Sweep:           time.Duration(envInt("SWEEP_INTERVAL", 30000)) * time.Millisecond,
		LogLevel:        strings.ToLower(env("LOG_LEVEL", "info")),
		StatsFile:       env("STATS_FILE", "stats.json"),
		ProxyHeader:     env("PROXY_HEADER", "X-Forwarded-For"),
	}
	if cfg.Transport != "ws" && cfg.Transport != "sse" {
		cfg.Transport = "both"
	}
	if _, err := os.Stat(cfg.StaticDir); err != nil {
		if _, altErr := os.Stat(filepath.Join("..", "frontend", "dist")); altErr == nil {
			cfg.StaticDir = filepath.Join("..", "frontend", "dist")
		}
	}
	return cfg
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func splitList(value string) []string {
	parts := strings.Split(value, ",")
	result := []string{}
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}
