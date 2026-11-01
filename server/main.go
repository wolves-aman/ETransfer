package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/websocket/v2"
	"golang.org/x/crypto/bcrypt"
)

const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type Config struct {
	Host            string
	Port            int
	Transport       string // both | ws | sse
	StaticDir       string
	AllowedOrigins  []string
	MaxUsers        int
	MaxRoomIDLength int
	DefaultExpiry   int
	MaxExpiry       int
	MaxPayload      int
	Heartbeat       time.Duration
	Sweep           time.Duration
}

type User struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	IsHost   bool   `json:"is_host"`
	JoinedAt int64  `json:"joined_at"`
}

type Room struct {
	ID           string
	MaxUsers     int
	OneTime      bool
	ExpiresAt    int64
	CreatedAt    int64
	PasswordHash []byte
	Users        map[*Client]*User
	HostID       string
}

type RateLimiter struct {
	windowStart time.Time
	count       int
	max         int
	window      time.Duration
}

func (r *RateLimiter) allow() bool {
	now := time.Now()
	if now.Sub(r.windowStart) >= r.window {
		r.windowStart = now
		r.count = 0
	}
	r.count++
	return r.count <= r.max
}

type Session struct {
	Room    *Room
	User    *User
	Limiter *RateLimiter
}

type wireEvent struct {
	data  []byte
	close bool
}

type Client struct {
	ID        string
	Token     string
	Transport string
	Session   *Session

	mu      sync.Mutex
	ws      *websocket.Conn
	events  chan wireEvent
	closed  bool
	onClose func()
}

func (c *Client) SendJSON(v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	if c.Transport == "ws" {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.closed || c.ws == nil {
			return
		}
		_ = c.ws.WriteMessage(websocket.TextMessage, raw)
		return
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return
	}
	select {
	case c.events <- wireEvent{data: raw}:
	default:
	}
}

func (c *Client) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if c.Transport == "ws" {
		ws := c.ws
		c.mu.Unlock()
		if ws != nil {
			_ = ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4000, "closed"))
			_ = ws.Close()
		}
		return
	}
	c.mu.Unlock()
	select {
	case c.events <- wireEvent{close: true}:
	default:
	}
}

type Server struct {
	cfg Config

	mu      sync.Mutex
	rooms   map[string]*Room
	sse     map[string]*Client
	sseMu   sync.RWMutex
	clients map[*Client]*Session
}

func main() {
	cfg := loadConfig()
	s := &Server{
		cfg:     cfg,
		rooms:   make(map[string]*Room),
		sse:     make(map[string]*Client),
		clients: make(map[*Client]*Session),
	}
	go s.sweepLoop()

	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		BodyLimit:             cfg.MaxPayload,
	})
	allowOrigins := strings.Join(cfg.AllowedOrigins, ",")
	if allowOrigins == "" {
		allowOrigins = "*"
	}
	app.Use(cors.New(cors.Config{
		AllowOrigins: allowOrigins,
		AllowHeaders: "Content-Type",
		AllowMethods: "GET,POST,OPTIONS",
	}))

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{
			"status":    "ok",
			"transport": cfg.Transport,
			"ws":        cfg.Transport != "sse",
			"sse":       cfg.Transport != "ws",
		})
	})

	if cfg.Transport != "ws" {
		app.Get("/api/events", s.handleSSE)
		app.Post("/api/signal", s.handleSignal)
	}

	if cfg.Transport != "sse" {
		app.Use("/ws", func(c *fiber.Ctx) error {
			if websocket.IsWebSocketUpgrade(c) {
				return c.Next()
			}
			return fiber.ErrUpgradeRequired
		})
		app.Get("/ws", websocket.New(s.handleWS))
	}

	app.All("/api/*", func(c *fiber.Ctx) error {
		return c.Status(404).JSON(fiber.Map{"error": "API not found", "code": "NOT_FOUND"})
	})
	if cfg.Transport == "sse" {
		app.All("/ws", func(c *fiber.Ctx) error {
			return c.Status(404).JSON(fiber.Map{"error": "WebSocket disabled", "code": "WS_DISABLED"})
		})
	}

	app.Static("/", cfg.StaticDir, fiber.Static{Index: "index.html"})
	app.Get("/*", func(c *fiber.Ctx) error {
		if strings.HasPrefix(c.Path(), "/api/") || c.Path() == "/ws" {
			return c.SendStatus(404)
		}
		index := filepath.Join(cfg.StaticDir, "index.html")
		if _, err := os.Stat(index); err != nil {
			return c.Status(404).SendString("client/dist not found")
		}
		return c.SendFile(index)
	})

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("etransfer go server listening on %s transport=%s static=%s", addr, cfg.Transport, cfg.StaticDir)
	if err := app.Listen(addr); err != nil {
		log.Fatal(err)
	}
}

func loadConfig() Config {
	cfg := Config{
		Host:            env("HOST", "0.0.0.0"),
		Port:            envInt("PORT", 9090),
		Transport:       strings.ToLower(env("SIGNAL_TRANSPORT", "both")),
		StaticDir:       env("STATIC_DIR", "client/dist"),
		AllowedOrigins:  splitList(os.Getenv("ALLOWED_ORIGINS")),
		MaxUsers:        envInt("MAX_USERS", 8),
		MaxRoomIDLength: envInt("MAX_ROOM_ID_LENGTH", 12),
		DefaultExpiry:   envInt("DEFAULT_EXPIRY_MINUTES", 180),
		MaxExpiry:       envInt("MAX_EXPIRY_MINUTES", 1440),
		MaxPayload:      envInt("MAX_PAYLOAD", 65536),
		Heartbeat:       time.Duration(envInt("HEARTBEAT_INTERVAL", 30000)) * time.Millisecond,
		Sweep:           time.Duration(envInt("SWEEP_INTERVAL", 30000)) * time.Millisecond,
	}
	if cfg.Transport != "ws" && cfg.Transport != "sse" {
		cfg.Transport = "both"
	}
	if _, err := os.Stat(cfg.StaticDir); err != nil {
		if _, altErr := os.Stat(filepath.Join("..", "client", "dist")); altErr == nil {
			cfg.StaticDir = filepath.Join("..", "client", "dist")
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

func randomHex(bytes int) string {
	raw := make([]byte, bytes)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

func randomCode(length int) string {
	buf := make([]byte, length)
	for i := range buf {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(roomAlphabet))))
		buf[i] = roomAlphabet[n.Int64()]
	}
	return string(buf)
}

func (s *Server) handleWS(conn *websocket.Conn) {
	client := &Client{ID: randomHex(8), Transport: "ws", ws: conn}
	session := &Session{Limiter: &RateLimiter{max: 200, window: 10 * time.Second}}
	client.Session = session
	s.mu.Lock()
	s.clients[client] = session
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
		s.handleMessage(client, raw)
	}
}

func (s *Server) handleSSE(c *fiber.Ctx) error {
	client := &Client{
		ID:        randomHex(8),
		Token:     randomHex(24),
		Transport: "sse",
		events:    make(chan wireEvent, 256),
	}
	client.Session = &Session{Limiter: &RateLimiter{max: 200, window: 10 * time.Second}}
	s.sseMu.Lock()
	s.sse[client.ID] = client
	s.sseMu.Unlock()
	s.mu.Lock()
	s.clients[client] = client.Session
	s.mu.Unlock()

	c.Set("Content-Type", "text/event-stream; charset=utf-8")
	c.Set("Cache-Control", "no-cache, no-transform")
	c.Set("Connection", "keep-alive")
	c.Set("X-Accel-Buffering", "no")
	c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
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
	return nil
}

func (s *Server) handleSignal(c *fiber.Ctx) error {
	var body map[string]any
	if err := c.BodyParser(&body); err != nil {
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
	s.handleMessage(client, raw)
	return c.Status(202).JSON(fiber.Map{"ok": true})
}

func (s *Server) disconnect(client *Client) {
	s.mu.Lock()
	session := client.Session
	if session != nil && session.Room != nil {
		s.leaveLocked(client, session, "connection_closed")
	}
	delete(s.clients, client)
	s.mu.Unlock()
	client.Close()
	s.sseMu.Lock()
	delete(s.sse, client.ID)
	s.sseMu.Unlock()
}

func (s *Server) handleMessage(client *Client, raw []byte) {
	session := client.Session
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
		err = &protoError{code: "UNKNOWN_ACTION", msg: "未知 action"}
	}
	if err != nil {
		var pe *protoError
		if errors.As(err, &pe) {
			s.sendError(client, action, pe.code, pe.msg)
		} else {
			s.sendError(client, action, "INTERNAL", "服务器处理消息失败")
		}
	}
}

func (s *Server) createRoom(client *Client, session *Session, message map[string]any) error {
	if session.Room != nil {
		return &protoError{code: "ALREADY_IN_ROOM", msg: "你已在房间中，请先离开"}
	}
	roomID, err := normalizeRoomID(stringField(message, "room_id"), s.cfg.MaxRoomIDLength)
	if err != nil {
		return err
	}
	if roomID == "" {
		roomID = randomCode(6)
	}
	password, err := normalizePassword(stringField(message, "password"))
	if err != nil {
		return err
	}
	expiry := normalizeExpiry(intField(message, "expires_in"), s.cfg.DefaultExpiry, s.cfg.MaxExpiry)
	oneTime, _ := message["one_time"].(bool)
	maxUsers := s.cfg.MaxUsers
	if oneTime {
		maxUsers = 2
	} else if value := intField(message, "max_users"); value > 0 {
		maxUsers = min(value, s.cfg.MaxUsers)
	}
	name := normalizeName(stringField(message, "name"))
	if name == "" {
		name = "房主"
	}

	hash, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	now := time.Now().UnixMilli()
	user := &User{ID: randomHex(4), Name: name, IsHost: true, JoinedAt: now}
	room := &Room{
		ID:           roomID,
		MaxUsers:     maxUsers,
		OneTime:      oneTime,
		ExpiresAt:    expiryTime(expiry),
		CreatedAt:    now,
		PasswordHash: hash,
		Users:        map[*Client]*User{client: user},
		HostID:       user.ID,
	}
	if password == "" {
		room.PasswordHash = nil
	}

	s.mu.Lock()
	if _, exists := s.rooms[roomID]; exists {
		s.mu.Unlock()
		return &protoError{code: "ROOM_EXISTS", msg: "房间已存在"}
	}
	s.rooms[roomID] = room
	session.Room = room
	session.User = user
	s.mu.Unlock()

	client.SendJSON(fiber.Map{
		"action": "CREATE_ROOM", "status": true,
		"room_id": room.ID, "self_id": user.ID, "self_name": user.Name,
		"host": true, "peers": []any{},
		"host_id": room.HostID, "has_password": len(room.PasswordHash) > 0,
		"one_time": room.OneTime, "max_users": room.MaxUsers,
		"expires_at": room.ExpiresAt, "created_at": room.CreatedAt,
	})
	return nil
}

func (s *Server) joinRoom(client *Client, session *Session, message map[string]any) error {
	if session.Room != nil {
		return &protoError{code: "ALREADY_IN_ROOM", msg: "你已在房间中，请先离开"}
	}
	roomID, err := normalizeRoomID(stringField(message, "room_id"), s.cfg.MaxRoomIDLength)
	if err != nil || roomID == "" {
		return &protoError{code: "ROOM_ID_REQUIRED", msg: "房间号不能为空"}
	}
	password, err := normalizePassword(stringField(message, "password"))
	if err != nil {
		return err
	}
	name := normalizeName(stringField(message, "name"))

	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[roomID]
	if room == nil {
		return &protoError{code: "ROOM_NOT_FOUND", msg: "房间不存在或已失效"}
	}
	if room.ExpiresAt > 0 && time.Now().UnixMilli() >= room.ExpiresAt {
		delete(s.rooms, roomID)
		return &protoError{code: "ROOM_EXPIRED", msg: "房间已过期"}
	}
	if room.OneTime && len(room.Users) >= 2 {
		return &protoError{code: "ROOM_USED", msg: "一次性房间已被使用"}
	}
	if len(room.Users) >= room.MaxUsers {
		return &protoError{code: "ROOM_FULL", msg: "房间已满"}
	}
	if len(room.PasswordHash) > 0 && bcrypt.CompareHashAndPassword(room.PasswordHash, []byte(password)) != nil {
		if password == "" {
			return &protoError{code: "PASSWORD_REQUIRED", msg: "该房间需要密码"}
		}
		return &protoError{code: "WRONG_PASSWORD", msg: "房间密码错误"}
	}
	if name == "" {
		name = "访客-" + strings.ToUpper(randomHex(2))
	}
	user := &User{ID: randomHex(4), Name: name, JoinedAt: time.Now().UnixMilli()}
	room.Users[client] = user
	session.Room = room
	session.User = user

	peers := make([]fiber.Map, 0, len(room.Users)-1)
	for other, member := range room.Users {
		if other != client {
			peers = append(peers, publicUser(member))
		}
	}
	client.SendJSON(fiber.Map{
		"action": "JOIN_ROOM", "status": true,
		"room_id": room.ID, "self_id": user.ID, "self_name": user.Name,
		"host": false, "peers": peers,
		"host_id": room.HostID, "has_password": len(room.PasswordHash) > 0,
		"one_time": room.OneTime, "max_users": room.MaxUsers,
		"expires_at": room.ExpiresAt, "created_at": room.CreatedAt,
	})
	for other := range room.Users {
		if other != client {
			other.SendJSON(fiber.Map{"action": "PEER_JOINED", "peer": publicUser(user)})
		}
	}
	return nil
}

func (s *Server) leaveLocked(client *Client, session *Session, reason string) {
	room := session.Room
	user := session.User
	if room == nil || user == nil {
		return
	}
	delete(room.Users, client)
	if len(room.Users) == 0 || room.OneTime {
		s.closeRoomLocked(room, "room_closed")
		delete(s.rooms, room.ID)
	} else {
		if user.IsHost {
			var next *User
			for _, member := range room.Users {
				if next == nil || member.JoinedAt < next.JoinedAt {
					next = member
				}
			}
			if next != nil {
				next.IsHost = true
				room.HostID = next.ID
				s.broadcastLocked(room, fiber.Map{"action": "HOST_CHANGED", "peer_id": next.ID}, nil)
			}
		}
		s.broadcastLocked(room, fiber.Map{"action": "PEER_LEFT", "peer_id": user.ID, "reason": reason}, client)
	}
	session.Room = nil
	session.User = nil
	client.Close()
}

func (s *Server) kick(client *Client, session *Session, message map[string]any) error {
	if session.Room == nil || session.User == nil {
		return &protoError{code: "NOT_IN_ROOM", msg: "尚未加入房间"}
	}
	if !session.User.IsHost {
		return &protoError{code: "FORBIDDEN", msg: "只有房主可以踢人"}
	}
	targetID := stringField(message, "peer_id")
	if targetID == "" {
		return &protoError{code: "TARGET_REQUIRED", msg: "缺少被踢成员 ID"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room := session.Room
	var targetClient *Client
	var targetUser *User
	for other, member := range room.Users {
		if member.ID == targetID {
			targetClient = other
			targetUser = member
			break
		}
	}
	if targetUser == nil {
		return &protoError{code: "TARGET_NOT_FOUND", msg: "成员不存在"}
	}
	delete(room.Users, targetClient)
	targetClient.SendJSON(fiber.Map{"action": "KICKED", "status": false, "reason": "host_kicked", "msg": "你已被房主移出房间"})
	targetClient.Close()
	targetSession := targetClient.Session
	if targetSession != nil {
		targetSession.Room = nil
		targetSession.User = nil
	}
	if len(room.Users) == 0 || room.OneTime {
		s.closeRoomLocked(room, "one_time_closed")
		delete(s.rooms, room.ID)
	} else {
		s.broadcastLocked(room, fiber.Map{"action": "PEER_LEFT", "peer_id": targetID, "reason": "kicked"}, nil)
	}
	return nil
}

func (s *Server) closeRoom(client *Client, session *Session) error {
	if session.Room == nil || session.User == nil {
		return &protoError{code: "NOT_IN_ROOM", msg: "尚未加入房间"}
	}
	if !session.User.IsHost {
		return &protoError{code: "FORBIDDEN", msg: "只有房主可以关闭房间"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room := session.Room
	s.closeRoomLocked(room, "host_closed")
	delete(s.rooms, room.ID)
	return nil
}

func (s *Server) closeRoomLocked(room *Room, reason string) {
	for memberClient := range room.Users {
		memberClient.SendJSON(fiber.Map{
			"action": "ROOM_CLOSED", "status": false,
			"reason": reason, "msg": "房间已关闭",
		})
		memberClient.Close()
		if session := memberClient.Session; session != nil {
			session.Room = nil
			session.User = nil
		}
	}
}

func (s *Server) transfer(client *Client, session *Session, message map[string]any) error {
	if session.Room == nil || session.User == nil {
		return &protoError{code: "NOT_IN_ROOM", msg: "尚未加入房间"}
	}
	transferType := stringField(message, "type")
	if transferType != "offer" && transferType != "answer" && transferType != "candidate" {
		return &protoError{code: "INVALID_TRANSFER_TYPE", msg: "不支持的传输类型"}
	}
	targetID := stringField(message, "target")
	s.mu.Lock()
	defer s.mu.Unlock()
	room := session.Room
	var target *Client
	if targetID == "" {
		for other, member := range room.Users {
			if other != client {
				target = other
				targetID = member.ID
				break
			}
		}
		if target == nil {
			return &protoError{code: "TARGET_REQUIRED", msg: "多人房间必须指定传输目标"}
		}
	} else {
		for other, member := range room.Users {
			if member.ID == targetID {
				target = other
				break
			}
		}
	}
	if target == nil {
		return &protoError{code: "TARGET_NOT_FOUND", msg: "目标成员不存在"}
	}
	payload := fiber.Map{"action": "TRANSFER", "from": session.User.ID, "type": transferType}
	if transferType == "candidate" {
		payload["candidate"] = message["candidate"]
	} else {
		payload[transferType] = message[transferType]
	}
	target.SendJSON(payload)
	return nil
}

func (s *Server) broadcastLocked(room *Room, message fiber.Map, except *Client) {
	for member := range room.Users {
		if member == except {
			continue
		}
		member.SendJSON(message)
	}
}

func (s *Server) sendError(client *Client, action, code, msg string) {
	if action == "" {
		action = "ERROR"
	}
	client.SendJSON(fiber.Map{"action": action, "status": false, "code": code, "msg": msg})
}

func (s *Server) sweepLoop() {
	ticker := time.NewTicker(s.cfg.Sweep)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now().UnixMilli()
		s.mu.Lock()
		for id, room := range s.rooms {
			if room.ExpiresAt > 0 && now >= room.ExpiresAt {
				s.closeRoomLocked(room, "expired")
				delete(s.rooms, id)
			}
		}
		s.mu.Unlock()
	}
}

type protoError struct {
	code string
	msg  string
}

func (e *protoError) Error() string { return e.msg }

func normalizeRoomID(value string, max int) (string, error) {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "" {
		return "", nil
	}
	if len(value) < 4 || len(value) > max {
		return "", &protoError{code: "INVALID_ROOM_ID", msg: "房间号长度无效"}
	}
	for _, char := range value {
		if !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') && char != '_' && char != '-' {
			return "", &protoError{code: "INVALID_ROOM_ID", msg: "房间号只能包含字母、数字、_、-"}
		}
	}
	return value, nil
}

func normalizePassword(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len(value) < 4 || len(value) > 64 {
		return "", &protoError{code: "INVALID_PASSWORD", msg: "密码长度需为 4~64 位"}
	}
	return value, nil
}

func normalizeName(value string) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > 24 {
		runes = runes[:24]
	}
	return string(runes)
}

func normalizeExpiry(value, fallback, max int) int {
	if value < 0 {
		return fallback
	}
	if value == 0 {
		return 0
	}
	if value > max {
		return max
	}
	return value
}

func expiryTime(minutes int) int64 {
	if minutes <= 0 {
		return 0
	}
	return time.Now().Add(time.Duration(minutes) * time.Minute).UnixMilli()
}

func intField(message map[string]any, key string) int {
	switch value := message[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case string:
		parsed, _ := strconv.Atoi(value)
		return parsed
	default:
		return 0
	}
}

func stringField(message map[string]any, key string) string {
	value, _ := message[key].(string)
	return value
}

func publicUser(user *User) fiber.Map {
	return fiber.Map{
		"id": user.ID, "name": user.Name, "is_host": user.IsHost, "joined_at": user.JoinedAt,
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
