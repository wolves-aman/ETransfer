package signaling

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/contrib/v3/websocket"
	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"

	"etransfer/internal/config"
	"etransfer/internal/logging"
	"etransfer/internal/protocol"
	"etransfer/internal/room"
)

type Session struct {
	Room    *room.Room
	User    *room.User
	Limiter *RateLimiter
}

type Server struct {
	cfg    config.Config
	logger *logging.Logger

	mu       sync.Mutex
	registry *room.Registry
	sse      map[string]*Client
	sseMu    sync.RWMutex
	sessions map[room.Conn]*Session

	roomsCreated atomic.Int64
	statsMu      sync.Mutex
}

func New(cfg config.Config, logger *logging.Logger) *Server {
	server := &Server{
		cfg:      cfg,
		logger:   logger,
		registry: room.NewRegistry(),
		sse:      make(map[string]*Client),
		sessions: make(map[room.Conn]*Session),
	}
	server.roomsCreated.Store(loadRoomStats(cfg.StatsFile, logger))
	return server
}

func (s *Server) HandleWS(conn *websocket.Conn) {
	requestID, _ := conn.Locals("request_id").(string)
	client := &Client{
		ID:        protocol.RandomHex(8),
		Transport: "ws",
		IP:        conn.IP(),
		RequestID: requestID,
		ws:        conn,
	}
	session := &Session{Limiter: &RateLimiter{max: 200, window: 10 * time.Second}}
	s.mu.Lock()
	s.sessions[client] = session
	s.mu.Unlock()
	s.logger.Info("connection_open",
		zap.String("transport", "ws"),
		zap.String("client_id", client.ID),
		zap.String("request_id", client.RequestID),
		zap.String("ip", client.IP),
	)

	defer func() {
		s.disconnect(client, "read_error")
		_ = conn.Close()
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		s.handleMessage(client, session, raw)
	}
}

func (s *Server) HandleSSE(c fiber.Ctx) error {
	requestID, _ := c.Locals("request_id").(string)
	client := &Client{
		ID:        protocol.RandomHex(8),
		Token:     protocol.RandomHex(24),
		Transport: "sse",
		IP:        c.IP(),
		RequestID: requestID,
		events:    make(chan wireEvent, 256),
	}
	session := &Session{Limiter: &RateLimiter{max: 200, window: 10 * time.Second}}
	s.sseMu.Lock()
	s.sse[client.ID] = client
	s.sseMu.Unlock()
	s.mu.Lock()
	s.sessions[client] = session
	s.mu.Unlock()
	s.logger.Info("connection_open",
		zap.String("transport", "sse"),
		zap.String("client_id", client.ID),
		zap.String("request_id", client.RequestID),
		zap.String("ip", client.IP),
	)

	c.Set("Content-Type", "text/event-stream; charset=utf-8")
	c.Set("Cache-Control", "no-cache, no-transform")
	c.Set("Connection", "keep-alive")
	c.Set("X-Accel-Buffering", "no")
	return c.SendStreamWriter(func(w *bufio.Writer) {
		defer s.disconnect(client, "sse_closed")
		first, _ := json.Marshal(fiber.Map{
			"action":       "CONNECTED",
			"client_id":    client.ID,
			"token":        client.Token,
			"transport":    "sse",
			"heartbeat_ms": 15000,
		})
		fmt.Fprintf(w, "data: %s\n\n", first)
		if err := w.Flush(); err != nil {
			return
		}

		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case event := <-client.events:
				if event.close {
					return
				}
				if _, err := fmt.Fprintf(w, "data: %s\n\n", event.data); err != nil {
					return
				}
				if err := w.Flush(); err != nil {
					return
				}
			case <-ticker.C:
				if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
					return
				}
				if err := w.Flush(); err != nil {
					return
				}
			}
		}
	})
}

func (s *Server) HandleSignal(c fiber.Ctx) error {
	var body map[string]any
	if err := c.Bind().Body(&body); err != nil {
		s.logger.Warn("signal_body_invalid", zap.Error(err))
		return c.Status(400).JSON(fiber.Map{"error": "invalid json", "code": "INVALID_JSON"})
	}
	id, _ := body["client_id"].(string)
	token, _ := body["token"].(string)
	s.sseMu.RLock()
	client := s.sse[id]
	s.sseMu.RUnlock()
	if client == nil || client.Token != token {
		s.logger.Warn("signal_token_invalid", zap.String("client_id", id))
		return c.Status(401).JSON(fiber.Map{"error": "invalid token", "code": "INVALID_TOKEN"})
	}
	raw, _ := json.Marshal(body)
	session := s.sessions[client]
	if session == nil {
		s.logger.Warn("signal_session_missing", zap.String("client_id", id))
		return c.Status(409).JSON(fiber.Map{"error": "session missing", "code": "SESSION_MISSING"})
	}
	s.handleMessage(client, session, raw)
	return c.Status(202).JSON(fiber.Map{"ok": true})
}

func (s *Server) disconnect(client *Client, reason string) {
	s.mu.Lock()
	session := s.sessions[client]
	roomID := ""
	if session != nil && session.Room != nil {
		roomID = session.Room.ID
		s.leaveLocked(client, session, reason)
	}
	delete(s.sessions, client)
	s.mu.Unlock()
	client.Close()
	s.sseMu.Lock()
	delete(s.sse, client.ID)
	s.sseMu.Unlock()
	s.logger.Info("connection_closed",
		zap.String("transport", client.Transport),
		zap.String("client_id", client.ID),
		zap.String("request_id", client.RequestID),
		zap.String("ip", client.IP),
		zap.String("room_id", roomID),
		zap.String("reason", reason),
	)
}

func (s *Server) handleMessage(client *Client, session *Session, raw []byte) {
	if session == nil {
		return
	}
	if !session.Limiter.allow() {
		s.logger.Warn("rate_limited",
			zap.String("transport", client.Transport),
			zap.String("client_id", client.ID),
		)
		client.SendJSON(fiber.Map{"action": "ERROR", "status": false, "code": "RATE_LIMITED", "msg": "消息发送过于频繁"})
		client.Close()
		return
	}

	var message map[string]any
	if err := json.Unmarshal(raw, &message); err != nil {
		s.logger.Warn("message_invalid_json", zap.String("client_id", client.ID))
		s.sendError(client, "", "BAD_REQUEST", "消息必须是 JSON")
		return
	}
	action, _ := message["action"].(string)
	if action == "" {
		s.logger.Warn("message_missing_action", zap.String("client_id", client.ID))
		s.sendError(client, "", "BAD_REQUEST", "缺少 action")
		return
	}

	var err error
	switch action {
	case "CREATE_ROOM":
		err = s.createRoom(client, session, message)
	case "JOIN_ROOM":
		err = s.joinRoom(client, session, message)
	case "LEAVE_ROOM":
		s.mu.Lock()
		s.leaveLocked(client, session, "left")
		s.mu.Unlock()
	case "KICK":
		err = s.kick(client, session, message)
	case "CLOSE_ROOM":
		err = s.closeRoom(client, session)
	case "TRANSFER":
		err = s.transfer(client, session, message)
	case "HEART_BEAT":
		client.SendJSON(fiber.Map{"action": "HEART_BEAT", "status": true, "timestamp": time.Now().UnixMilli()})
	default:
		err = protocol.NewError("UNKNOWN_ACTION", "未知 action")
	}
	if err != nil {
		var pe *protocol.Error
		if errors.As(err, &pe) {
			s.logger.Warn("message_rejected",
				zap.String("transport", client.Transport),
				zap.String("client_id", client.ID),
				zap.String("action", action),
				zap.String("code", pe.Code),
				zap.String("room_id", sessionRoomID(session)),
			)
			s.sendError(client, action, pe.Code, pe.Msg)
		} else {
			s.logger.Error("message_handler_failed",
				zap.String("transport", client.Transport),
				zap.String("client_id", client.ID),
				zap.String("action", action),
				zap.Error(err),
			)
			s.sendError(client, action, "INTERNAL", "服务器处理消息失败")
		}
	}
}

func sessionRoomID(session *Session) string {
	if session == nil || session.Room == nil {
		return ""
	}
	return session.Room.ID
}

func (s *Server) sendError(client *Client, action, code, msg string) {
	if action == "" {
		action = "ERROR"
	}
	client.SendJSON(fiber.Map{"action": action, "status": false, "code": code, "msg": msg})
}

func (s *Server) SweepLoop() {
	ticker := time.NewTicker(s.cfg.Sweep)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now().UnixMilli()
		s.mu.Lock()
		for id, current := range s.registry.All() {
			if current.IsExpired(now) {
				s.closeRoomLocked(current, "expired")
				s.registry.Delete(id)
			}
		}
		s.mu.Unlock()
	}
}

func (s *Server) Health(c fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status":    "ok",
		"transport": s.cfg.Transport,
		"ws":        s.cfg.Transport != "sse",
		"sse":       s.cfg.Transport != "ws",
	})
}
