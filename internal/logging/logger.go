package logging

import (
	"crypto/rand"
	"encoding/hex"
	"strings"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

type Logger struct {
	*zap.Logger
}

func New(level string) *Logger {
	parsed, err := zapcore.ParseLevel(strings.ToLower(level))
	if err != nil {
		parsed = zapcore.InfoLevel
	}

	cfg := zap.NewProductionConfig()
	cfg.OutputPaths = []string{"stdout"}
	cfg.ErrorOutputPaths = []string{"stderr"}
	cfg.Level = zap.NewAtomicLevelAt(parsed)
	cfg.EncoderConfig.TimeKey = "ts"
	cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	base, buildErr := cfg.Build(zap.AddCaller(), zap.AddStacktrace(zapcore.ErrorLevel))
	if buildErr != nil {
		base = zap.NewNop()
	}
	logger := &Logger{Logger: base}
	if err != nil {
		logger.Warn("invalid_log_level",
			zap.String("value", level),
			zap.String("fallback", "info"),
		)
	}
	return logger
}

// Fatal 只写日志，不退出进程。启动失败由 main 决定 os.Exit。
func (l *Logger) Fatal(msg string, fields ...zap.Field) {
	l.Log(zapcore.FatalLevel, msg, fields...)
}

func NewID() string {
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(raw)
}
