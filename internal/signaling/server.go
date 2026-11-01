package signaling

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/gofiber/contrib/v3/websocket"
	"github.com/gofiber/fiber/v3"

	"etransfer/internal/config"
	"etransfer/internal/protocol"
	"etransfer/internal/room"
)

type Session struct {
	Room    *room.Room
	User    *room.User
	Limiter *RateLimiter
}

type Server struct {
	cfg config.Config

	mu       sync.Mutex
	registry *room.Registry
	sse      map[string]*Client
	sseMu    sync.RWMutex
	sessions map[room.Conn]*Session
}

func New(cfg config.Config) *Server {
	return &Server{
		cfg:      cfg,
		registry: room.NewRegistry(),
		sse:      make(map[string]*Client),
		sessions: make(map[room.Conn]*Session),
	}
}

func (s *Server) HandleWS(conn *websocket.Conn) {
	client := &Client{ID: protocol.RandomHex(8), Transport: "ws", ws: conn}
	session := &Session{Limiter: &RateLimiter{max: 200, window: 10 * time.Second}}
	s.mu.Lock()
	s.sessions[client] = session
	s.mu.Unlock()

	defer func() {
		s.disconnect(client)
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
	client := &Client{
		ID:        protocol.RandomHex(8),
		Token:     protocol.RandomHex(24),
		Transport: "sse",
		events:    make(chan wireEvent, 256),
	}
	session := &Session{Limiter: &RateLimiter{max: 200, window: 10 * time.Second}}
	s.sseMu.Lock()
	s.sse[client.ID] = client
	s.sseMu.Unlock()
	s.mu.Lock()
	s.sessions[client] = session
	s.mu.Unlock()

	c.Set("Content-Type", "text/event-stream; charset=utf-8")
	c.Set("Cache-Control", "no-cache, no-transform")
	c.Set("Connection", "keep-alive")
	c.Set("X-Accel-Buffering", "no")
	return c.SendStreamWriter(func(w *bufio.Writer) {
		defer s.disconnect(client)
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
		return c.Status(400).JSON(fiber.Map{"error": "invalid json", "code": "INVALID_JSON"})
	}
	id, _ := body["client_id"].(string)
	token, _ := body["token"].(string)
	s.sseMu.RLock()
	client := s.sse[id]
	s.sseMu.RUnlock()
	if client == nil || client.Token != token {
		return c.Status(401).JSON(fiber.Map{"error": "invalid token", "code": "INVALID_TOKEN"})
	}
	raw, _ := json.Marshal(body)
	s.handleMessage(client, s.sessions[client], raw)
	return c.Status(202).JSON(fiber.Map{"ok": true})
}

func (s *Server) disconnect(client *Client) {
	s.mu.Lock()
	session := s.sessions[client]
	if session != nil && session.Room != nil {
		s.leaveLocked(client, session, "connection_closed")
	}
	delete(s.sessions, client)
	s.mu.Unlock()
	client.Close()
	s.sseMu.Lock()
	delete(s.sse, client.ID)
	s.sseMu.Unlock()
}

func (s *Server) handleMessage(client *Client, session *Session, raw []byte) {
	if session == nil {
		return
	}
	if !session.Limiter.allow() {
		client.SendJSON(fiber.Map{"action": "ERROR", "status": false, "code": "RATE_LIMITED", "msg": "消息发送过于频繁"})
		client.Close()
		return
	}

	var message map[string]any
	if err := json.Unmarshal(raw, &message); err != nil {
		s.sendError(client, "", "BAD_REQUEST", "消息必须是 JSON")
		return
	}
	action, _ := message["action"].(string)
	if action == "" {
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
			s.sendError(client, action, pe.Code, pe.Msg)
		} else {
			s.sendError(client, action, "INTERNAL", "服务器处理消息失败")
		}
	}
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
