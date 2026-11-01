package logging

import (
	"testing"

	"go.uber.org/zap/zapcore"
)

func TestParseLevel(t *testing.T) {
	tests := map[string]zapcore.Level{
		"debug": zapcore.DebugLevel,
		"INFO":  zapcore.InfoLevel,
		"warn":  zapcore.WarnLevel,
		"error": zapcore.ErrorLevel,
		"fatal": zapcore.FatalLevel,
	}
	for value, expected := range tests {
		parsed, err := zapcore.ParseLevel(value)
		if err != nil || parsed != expected {
			t.Fatalf("parse %q: got %v, %v", value, parsed, err)
		}
	}
}

func TestNewFallsBackToInfo(t *testing.T) {
	logger := New("not-a-level")
	defer logger.Sync()
	if !logger.Core().Enabled(zapcore.InfoLevel) {
		t.Fatal("fallback logger should enable info")
	}
}
