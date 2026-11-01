package protocol

import (
	"strings"
	"testing"
)

func TestNormalizeRoomID(t *testing.T) {
	id, err := NormalizeRoomID(" ab12 ", 12)
	if err != nil || id != "AB12" {
		t.Fatalf("unexpected %q %v", id, err)
	}
	if _, err := NormalizeRoomID("ab", 12); err == nil {
		t.Fatal("short room id should fail")
	}
	if _, err := NormalizeRoomID("a b c", 12); err == nil {
		t.Fatal("space room id should fail")
	}
}

func TestNormalizePassword(t *testing.T) {
	if password, err := NormalizePassword(""); err != nil || password != "" {
		t.Fatal("empty password should be allowed")
	}
	if _, err := NormalizePassword("123"); err == nil {
		t.Fatal("short password should fail")
	}
	if password, err := NormalizePassword("1234"); err != nil || password != "1234" {
		t.Fatal("valid password rejected")
	}
}

func TestNormalizeExpiry(t *testing.T) {
	if got := NormalizeExpiry(0, 180, 1440); got != 0 {
		t.Fatalf("expected permanent, got %d", got)
	}
	if got := NormalizeExpiry(9999, 180, 1440); got != 1440 {
		t.Fatalf("expected cap, got %d", got)
	}
}

func TestRandomCode(t *testing.T) {
	code := RandomCode(6)
	if len(code) != 6 {
		t.Fatalf("unexpected length %d", len(code))
	}
	for _, char := range code {
		if !strings.ContainsRune(roomAlphabet, char) {
			t.Fatalf("invalid char %q", char)
		}
	}
}
