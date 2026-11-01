package main

import (
	"fmt"
	"log"

	"etransfer/internal/app"
	"etransfer/internal/config"
	"etransfer/internal/signaling"
)

func main() {
	cfg := config.Load()
	static, err := staticFS(cfg)
	if err != nil {
		log.Fatal(err)
	}

	server := signaling.New(cfg)
	go server.SweepLoop()

	fiberApp := app.New(cfg, server, static)
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("etransfer listening on %s transport=%s", addr, cfg.Transport)
	if err := fiberApp.Listen(addr); err != nil {
		log.Fatal(err)
	}
}
