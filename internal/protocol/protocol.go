package protocol

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func NewError(code, msg string) *Error {
	return &Error{Code: code, Msg: msg}
}

func RandomHex(bytes int) string {
	raw := make([]byte, bytes)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}

func RandomCode(length int) string {
	buf := make([]byte, length)
	for i := range buf {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(roomAlphabet))))
		buf[i] = roomAlphabet[n.Int64()]
	}
	return string(buf)
}

func NormalizeRoomID(value string, max int) (string, error) {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "" {
		return "", nil
	}
	if len(value) < 4 || len(value) > max {
		return "", NewError("INVALID_ROOM_ID", "房间号长度无效")
	}
	for _, char := range value {
		if !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') && char != '_' && char != '-' {
			return "", NewError("INVALID_ROOM_ID", "房间号只能包含字母、数字、_、-")
		}
	}
	return value, nil
}

func NormalizePassword(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len(value) < 4 || len(value) > 64 {
		return "", NewError("INVALID_PASSWORD", "密码长度需为 4~64 位")
	}
	return value, nil
}

func NormalizeName(value string) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > 24 {
		runes = runes[:24]
	}
	return string(runes)
}

func NormalizeExpiry(value, fallback, max int) int {
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

func ExpiryTime(minutes int) int64 {
	if minutes <= 0 {
		return 0
	}
	return time.Now().Add(time.Duration(minutes) * time.Minute).UnixMilli()
}

func IntField(message map[string]any, key string) int {
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

func StringField(message map[string]any, key string) string {
	value, _ := message[key].(string)
	return value
}
