package signaling

import (
	"time"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"

	"etransfer/internal/protocol"
	"etransfer/internal/room"
)

func (s *Server) createRoom(client *Client, session *Session, message map[string]any) error {
	if session.Room != nil {
		return protocol.NewError("ALREADY_IN_ROOM", "你已在房间中，请先离开")
	}
	roomID, err := protocol.NormalizeRoomID(protocol.StringField(message, "room_id"), s.cfg.MaxRoomIDLength)
	if err != nil {
		return err
	}
	if roomID == "" {
		roomID = protocol.RandomCode(6)
	}
	password, err := protocol.NormalizePassword(protocol.StringField(message, "password"))
	if err != nil {
		return err
	}
	expiry := protocol.NormalizeExpiry(protocol.IntField(message, "expires_in"), s.cfg.DefaultExpiry, s.cfg.MaxExpiry)
	oneTime, _ := message["one_time"].(bool)
	maxUsers := s.cfg.MaxUsers
	if oneTime {
		maxUsers = 2
	} else if value := protocol.IntField(message, "max_users"); value > 0 {
		maxUsers = min(value, s.cfg.MaxUsers)
	}
	name := protocol.NormalizeName(protocol.StringField(message, "name"))
	if name == "" {
		name = "房主"
	}

	hash, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	now := time.Now().UnixMilli()
	user := room.NewUser(name, true)
	created := &room.Room{
		ID:           roomID,
		MaxUsers:     maxUsers,
		OneTime:      oneTime,
		ExpiresAt:    protocol.ExpiryTime(expiry),
		CreatedAt:    now,
		PasswordHash: hash,
		Users:        map[room.Conn]*room.User{client: user},
		HostID:       user.ID,
	}
	if password == "" {
		created.PasswordHash = nil
	}

	s.mu.Lock()
	if s.registry.Get(roomID) != nil {
		s.mu.Unlock()
		return protocol.NewError("ROOM_EXISTS", "房间已存在")
	}
	s.registry.Set(created)
	session.Room = created
	session.User = user
	s.mu.Unlock()

	client.SendJSON(fiber.Map{
		"action": "CREATE_ROOM", "status": true,
		"room_id": created.ID, "self_id": user.ID, "self_name": user.Name,
		"host": true, "peers": []any{},
		"host_id": created.HostID, "has_password": created.HasPassword(),
		"one_time": created.OneTime, "max_users": created.MaxUsers,
		"expires_at": created.ExpiresAt, "created_at": created.CreatedAt,
	})
	s.logger.Info("room_created",
		zap.String("room_id", created.ID),
		zap.String("user_id", user.ID),
		zap.Bool("one_time", created.OneTime),
		zap.Int("max_users", created.MaxUsers),
	)
	return nil
}

func (s *Server) joinRoom(client *Client, session *Session, message map[string]any) error {
	if session.Room != nil {
		return protocol.NewError("ALREADY_IN_ROOM", "你已在房间中，请先离开")
	}
	roomID, err := protocol.NormalizeRoomID(protocol.StringField(message, "room_id"), s.cfg.MaxRoomIDLength)
	if err != nil || roomID == "" {
		return protocol.NewError("ROOM_ID_REQUIRED", "房间号不能为空")
	}
	password, err := protocol.NormalizePassword(protocol.StringField(message, "password"))
	if err != nil {
		return err
	}
	name := protocol.NormalizeName(protocol.StringField(message, "name"))

	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.registry.Get(roomID)
	if current == nil {
		return protocol.NewError("ROOM_NOT_FOUND", "房间不存在或已失效")
	}
	if current.IsExpired(time.Now().UnixMilli()) {
		s.registry.Delete(roomID)
		return protocol.NewError("ROOM_EXPIRED", "房间已过期")
	}
	if current.OneTime && len(current.Users) >= 2 {
		return protocol.NewError("ROOM_USED", "一次性房间已被使用")
	}
	if len(current.Users) >= current.MaxUsers {
		return protocol.NewError("ROOM_FULL", "房间已满")
	}
	if current.HasPassword() && bcrypt.CompareHashAndPassword(current.PasswordHash, []byte(password)) != nil {
		if password == "" {
			return protocol.NewError("PASSWORD_REQUIRED", "该房间需要密码")
		}
		return protocol.NewError("WRONG_PASSWORD", "房间密码错误")
	}
	if name == "" {
		name = "访客-" + protocol.RandomHex(2)
	}
	user := room.NewUser(name, false)
	current.Users[client] = user
	session.Room = current
	session.User = user

	client.SendJSON(fiber.Map{
		"action": "JOIN_ROOM", "status": true,
		"room_id": current.ID, "self_id": user.ID, "self_name": user.Name,
		"host": false, "peers": current.PeerList(user.ID),
		"host_id": current.HostID, "has_password": current.HasPassword(),
		"one_time": current.OneTime, "max_users": current.MaxUsers,
		"expires_at": current.ExpiresAt, "created_at": current.CreatedAt,
	})
	for other := range current.Users {
		if other != client {
			other.SendJSON(fiber.Map{"action": "PEER_JOINED", "peer": room.PublicUser(user)})
		}
	}
	s.logger.Info("room_joined",
		zap.String("room_id", current.ID),
		zap.String("user_id", user.ID),
		zap.Int("users", len(current.Users)),
	)
	return nil
}

func (s *Server) leaveLocked(client *Client, session *Session, reason string) {
	current := session.Room
	if current == nil || session.User == nil {
		return
	}
	user, newHost, remaining := current.RemoveUser(client)
	if user == nil {
		return
	}
	if remaining == 0 || current.OneTime {
		s.closeRoomLocked(current, "room_closed")
		s.registry.Delete(current.ID)
	} else {
		if newHost != nil {
			s.broadcastLocked(current, fiber.Map{"action": "HOST_CHANGED", "peer_id": newHost.ID}, nil)
		}
		s.broadcastLocked(current, fiber.Map{"action": "PEER_LEFT", "peer_id": user.ID, "reason": reason}, client)
	}
	session.Room = nil
	session.User = nil
	client.Close()
	s.logger.Info("room_left",
		zap.String("room_id", current.ID),
		zap.String("user_id", user.ID),
		zap.String("reason", reason),
	)
}

func (s *Server) kick(client *Client, session *Session, message map[string]any) error {
	if session.Room == nil || session.User == nil {
		return protocol.NewError("NOT_IN_ROOM", "尚未加入房间")
	}
	if !session.User.IsHost {
		return protocol.NewError("FORBIDDEN", "只有房主可以踢人")
	}
	targetID := protocol.StringField(message, "peer_id")
	if targetID == "" {
		return protocol.NewError("TARGET_REQUIRED", "缺少被踢成员 ID")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := session.Room
	var targetClient room.Conn
	var targetUser *room.User
	for other, member := range current.Users {
		if member.ID == targetID {
			targetClient = other
			targetUser = member
			break
		}
	}
	if targetUser == nil {
		return protocol.NewError("TARGET_NOT_FOUND", "成员不存在")
	}
	delete(current.Users, targetClient)
	targetClient.SendJSON(fiber.Map{"action": "KICKED", "status": false, "reason": "host_kicked", "msg": "你已被房主移出房间"})
	targetClient.Close()
	if targetSession := s.sessions[targetClient]; targetSession != nil {
		targetSession.Room = nil
		targetSession.User = nil
	}
	if len(current.Users) == 0 || current.OneTime {
		s.closeRoomLocked(current, "one_time_closed")
		s.registry.Delete(current.ID)
	} else {
		s.broadcastLocked(current, fiber.Map{"action": "PEER_LEFT", "peer_id": targetID, "reason": "kicked"}, nil)
	}
	s.logger.Info("peer_kicked",
		zap.String("room_id", current.ID),
		zap.String("peer_id", targetID),
		zap.String("by", session.User.ID),
	)
	return nil
}

func (s *Server) closeRoom(client *Client, session *Session) error {
	if session.Room == nil || session.User == nil {
		return protocol.NewError("NOT_IN_ROOM", "尚未加入房间")
	}
	if !session.User.IsHost {
		return protocol.NewError("FORBIDDEN", "只有房主可以关闭房间")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := session.Room
	s.closeRoomLocked(current, "host_closed")
	s.registry.Delete(current.ID)
	return nil
}

func (s *Server) closeRoomLocked(current *room.Room, reason string) {
	for memberClient := range current.Users {
		memberClient.SendJSON(fiber.Map{
			"action": "ROOM_CLOSED", "status": false,
			"reason": reason, "msg": "房间已关闭",
		})
		memberClient.Close()
		if session := s.sessions[memberClient]; session != nil {
			session.Room = nil
			session.User = nil
		}
	}
	s.logger.Info("room_closed",
		zap.String("room_id", current.ID),
		zap.String("reason", reason),
		zap.Int("users", len(current.Users)),
	)
}

func (s *Server) transfer(client *Client, session *Session, message map[string]any) error {
	if session.Room == nil || session.User == nil {
		return protocol.NewError("NOT_IN_ROOM", "尚未加入房间")
	}
	transferType := protocol.StringField(message, "type")
	if transferType != "offer" && transferType != "answer" && transferType != "candidate" {
		return protocol.NewError("INVALID_TRANSFER_TYPE", "不支持的传输类型")
	}
	targetID := protocol.StringField(message, "target")
	s.mu.Lock()
	defer s.mu.Unlock()
	current := session.Room
	var target room.Conn
	if targetID == "" {
		for other, member := range current.Users {
			if other != client {
				target = other
				targetID = member.ID
				break
			}
		}
		if target == nil {
			return protocol.NewError("TARGET_REQUIRED", "多人房间必须指定传输目标")
		}
	} else {
		for other, member := range current.Users {
			if member.ID == targetID {
				target = other
				break
			}
		}
	}
	if target == nil {
		return protocol.NewError("TARGET_NOT_FOUND", "目标成员不存在")
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

func (s *Server) broadcastLocked(current *room.Room, message fiber.Map, except room.Conn) {
	for member := range current.Users {
		if member == except {
			continue
		}
		member.SendJSON(message)
	}
}
