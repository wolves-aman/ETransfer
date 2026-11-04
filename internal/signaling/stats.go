package signaling

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"

	"etransfer/internal/logging"
)

type roomStats struct {
	RoomsCreated int64 `json:"rooms_created"`
}

func loadRoomStats(path string, logger *logging.Logger) int64 {
	if path == "" {
		return 0
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn("stats_read_failed", zap.String("path", path), zap.Error(err))
		}
		return 0
	}
	var stats roomStats
	if err := json.Unmarshal(data, &stats); err != nil {
		logger.Warn("stats_parse_failed", zap.String("path", path), zap.Error(err))
		return 0
	}
	if stats.RoomsCreated < 0 {
		return 0
	}
	return stats.RoomsCreated
}

func (s *Server) recordRoomCreated() {
	s.roomsCreated.Add(1)
	if s.cfg.StatsFile == "" {
		return
	}

	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	count := s.roomsCreated.Load()
	data, err := json.Marshal(roomStats{RoomsCreated: count})
	if err != nil {
		return
	}
	dir := filepath.Dir(s.cfg.StatsFile)
	if dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			s.logger.Warn("stats_write_failed", zap.String("path", s.cfg.StatsFile), zap.Error(err))
			return
		}
	}
	tmp := s.cfg.StatsFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		s.logger.Warn("stats_write_failed", zap.String("path", tmp), zap.Error(err))
		return
	}
	if err := os.Rename(tmp, s.cfg.StatsFile); err != nil {
		s.logger.Warn("stats_write_failed", zap.String("path", s.cfg.StatsFile), zap.Error(err))
	}
}

func (s *Server) Stats(c fiber.Ctx) error {
	return c.JSON(fiber.Map{"rooms_created": s.roomsCreated.Load()})
}
