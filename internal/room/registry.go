package room

// Registry 只负责房间表的存取，并发控制由 signaling.Server 统一持有。
type Registry struct {
	rooms map[string]*Room
}

func NewRegistry() *Registry {
	return &Registry{rooms: make(map[string]*Room)}
}

func (r *Registry) Get(id string) *Room {
	return r.rooms[id]
}

func (r *Registry) Set(room *Room) {
	r.rooms[room.ID] = room
}

func (r *Registry) Delete(id string) {
	delete(r.rooms, id)
}

func (r *Registry) All() map[string]*Room {
	return r.rooms
}
