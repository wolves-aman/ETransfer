package signaling

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gofiber/contrib/v3/websocket"
)

type wireEvent struct {
	data  []byte
	close bool
}

type Client struct {
	ID        string
	Token     string
	Transport string

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
