package main

import (
	"strings"
	"testing"
)

func TestNormalizeRoomID(t *testing.T) {
	id, err := normalizeRoomID(" ab12 ", 12)
	if err != nil || id != "AB12" {
		t.Fatalf("unexpected %q %v", id, err)
	}
	if _, err := normalizeRoomID("ab", 12); err == nil {
		t.Fatal("short room id should fail")
	}
	if _, err := normalizeRoomID("a b c", 12); err == nil {
		t.Fatal("space room id should fail")
	}
}

func TestNormalizePassword(t *testing.T) {
	if password, err := normalizePassword(""); err != nil || password != "" {
		t.Fatal("empty password should be allowed")
	}
	if _, err := normalizePassword("123"); err == nil {
		t.Fatal("short password should fail")
	}
	if password, err := normalizePassword("1234"); err != nil || password != "1234" {
		t.Fatal("valid password rejected")
	}
}

func TestNormalizeExpiry(t *testing.T) {
	if got := normalizeExpiry(0, 180, 1440); got != 0 {
		t.Fatalf("expected permanent, got %d", got)
	}
	if got := normalizeExpiry(9999, 180, 1440); got != 1440 {
		t.Fatalf("expected cap, got %d", got)
	}
}

func TestRandomCode(t *testing.T) {
	code := randomCode(6)
	if len(code) != 6 {
		t.Fatalf("unexpected length %d", len(code))
	}
	for _, char := range code {
		if !strings.ContainsRune(roomAlphabet, char) {
			t.Fatalf("invalid char %q", char)
		}
	}
}
