package room

import (
	"time"

	"etransfer/internal/protocol"
)

type Conn interface {
	SendJSON(v any)
	Close()
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
	Users        map[Conn]*User
	HostID       string
}

func (r *Room) HasPassword() bool {
	return len(r.PasswordHash) > 0
}

func (r *Room) IsExpired(now int64) bool {
	return r.ExpiresAt > 0 && now >= r.ExpiresAt
}

func (r *Room) PeerList(exceptID string) []map[string]any {
	peers := make([]map[string]any, 0, len(r.Users))
	for _, user := range r.Users {
		if user.ID != exceptID {
			peers = append(peers, PublicUser(user))
		}
	}
	return peers
}

func (r *Room) Info() map[string]any {
	return map[string]any{
		"host_id":      r.HostID,
		"has_password": r.HasPassword(),
		"one_time":     r.OneTime,
		"max_users":    r.MaxUsers,
		"expires_at":   r.ExpiresAt,
		"created_at":   r.CreatedAt,
	}
}

// RemoveUser removes a connection and migrates host if needed.
func (r *Room) RemoveUser(conn Conn) (*User, *User, int) {
	user := r.Users[conn]
	if user == nil {
		return nil, nil, len(r.Users)
	}
	delete(r.Users, conn)
	var newHost *User
	if user.IsHost && len(r.Users) > 0 {
		for _, member := range r.Users {
			if newHost == nil || member.JoinedAt < newHost.JoinedAt {
				newHost = member
			}
		}
		if newHost != nil {
			newHost.IsHost = true
			r.HostID = newHost.ID
		}
	}
	return user, newHost, len(r.Users)
}

func PublicUser(user *User) map[string]any {
	return map[string]any{
		"id": user.ID, "name": user.Name, "is_host": user.IsHost, "joined_at": user.JoinedAt,
	}
}

func NewUser(name string, host bool) *User {
	return &User{
		ID:       protocol.RandomHex(4),
		Name:     name,
		IsHost:   host,
		JoinedAt: time.Now().UnixMilli(),
	}
}
