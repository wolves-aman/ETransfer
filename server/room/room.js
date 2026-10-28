import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { customAlphabet, nanoid } from 'nanoid'

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export class RoomError extends Error {
    constructor(message, code = 'ROOM_ERROR') {
        super(message)
        this.name = 'RoomError'
        this.code = code
    }
}

class User {
    constructor({ id, name, isHost, client, joinedAt = Date.now() }) {
        this.id = id
        this.name = name
        this.isHost = isHost
        this.client = client
        this.joinedAt = joinedAt
    }

    toPublic() {
        return {
            id: this.id,
            name: this.name,
            is_host: this.isHost,
            joined_at: this.joinedAt
        }
    }
}

/**
 * 一个房间只保存连接引用，不保存业务数据（文件/消息不经过服务端）。
 */
export class Room {
    constructor({
        id,
        hostClient,
        hostName,
        password = '',
        expiresAt = 0,
        oneTime = false,
        maxUsers = 8
    }) {
        this.id = id
        this.maxUsers = maxUsers
        this.oneTime = oneTime
        this.expiresAt = expiresAt
        this.createdAt = Date.now()
        this.users = new Map()
        this.passwordSalt = password ? randomBytes(16).toString('hex') : ''
        this.passwordHash = password
            ? scryptSync(password, this.passwordSalt, 32)
            : null

        const host = new User({
            id: nanoid(8),
            name: hostName || '房主',
            isHost: true,
            client: hostClient
        })
        this.users.set(hostClient, host)
        this.hostId = host.id
    }

    get size() {
        return this.users.size
    }

    get isFull() {
        return this.users.size >= this.maxUsers
    }

    get hasPassword() {
        return Boolean(this.passwordHash)
    }

    isExpired(now = Date.now()) {
        return this.expiresAt > 0 && now >= this.expiresAt
    }

    verifyPassword(password) {
        if (!this.passwordHash) {
            return true
        }
        if (typeof password !== 'string' || !password) {
            return false
        }
        const candidate = scryptSync(password, this.passwordSalt, 32)
        return candidate.length === this.passwordHash.length
            && timingSafeEqual(candidate, this.passwordHash)
    }

    /**
     * @param {object} client
     * @param {{ name?: string }} [options]
     * @returns {User}
     */
    addUser(client, { name } = {}) {
        if (this.users.has(client)) {
            throw new RoomError('你已在该房间中', 'ALREADY_IN_ROOM')
        }
        if (this.isFull) {
            throw new RoomError('房间已满!', 'ROOM_FULL')
        }
        const user = new User({
            id: nanoid(8),
            name: name || `访客-${nanoid(4).toUpperCase()}`,
            isHost: false,
            client
        })
        this.users.set(client, user)
        return user
    }

    /**
     * 移除用户；如果离开的是房主，自动把房主转给最早加入的成员。
     *
     * @param {object} client
     * @returns {{ user: User | null, remaining: number, newHost: User | null }}
     */
    removeUser(client) {
        const user = this.users.get(client) || null
        if (!user) {
            return { user: null, remaining: this.users.size, newHost: null }
        }

        this.users.delete(client)
        let newHost = null
        if (user.isHost && this.users.size > 0) {
            newHost = this.users.values().next().value
            newHost.isHost = true
            this.hostId = newHost.id
        }
        return { user, remaining: this.users.size, newHost }
    }

    get clients() {
        return [...this.users.keys()]
    }

    get usersList() {
        return [...this.users.values()]
    }

    getUserById(id) {
        for (const user of this.users.values()) {
            if (user.id === id) {
                return user
            }
        }
        return null
    }

    /**
     * @param {string} [exceptId]
     * @returns {Array<{id,name,is_host,joined_at}>}
     */
    peerList(exceptId) {
        return this.usersList
            .filter((user) => user.id !== exceptId)
            .map((user) => user.toPublic())
    }

    info() {
        return {
            id: this.id,
            host_id: this.hostId,
            has_password: this.hasPassword,
            one_time: this.oneTime,
            max_users: this.maxUsers,
            expires_at: this.expiresAt,
            created_at: this.createdAt
        }
    }

    /**
     * 向房间内除 except 外的所有连接发送消息。
     *
     * @param {Record<string, unknown>} message
     * @param {object} [exceptClient]
     * @returns {number}
     */
    broadcast(message, exceptClient) {
        let delivered = 0
        for (const [client] of this.users) {
            if (client === exceptClient) {
                continue
            }
            if (client.readyState === 1) {
                try {
                    client.send(JSON.stringify(message))
                    delivered += 1
                } catch {
                    // 单个连接失败不影响其它人
                }
            }
        }
        return delivered
    }
}

/**
 * 房间注册表。与 Room 分离，便于单元测试时创建独立实例。
 */
export class RoomRegistry {
    /**
     * @param {{ maxRooms?: number, maxUsers?: number, roomIdLength?: number, idFactory?: () => string }} [options]
     */
    constructor({
        maxRooms = Number.POSITIVE_INFINITY,
        maxUsers = 8,
        roomIdLength = 6,
        idFactory
    } = {}) {
        this.maxRooms = maxRooms
        this.maxUsers = maxUsers
        this.roomIdLength = roomIdLength
        this.idFactory = idFactory ?? customAlphabet(CODE_ALPHABET, roomIdLength)
        this.rooms = new Map()
    }

    get size() {
        return this.rooms.size
    }

    get(roomId) {
        return this.rooms.get(roomId)
    }

    /**
     * @param {{ roomId?: string, password?: string, expiresAt?: number, oneTime?: boolean, maxUsers?: number, hostName?: string }} options
     * @param {object} client
     */
    create(options, client) {
        if (this.rooms.size >= this.maxRooms) {
            throw new RoomError('服务器房间数已达上限，请稍后再试', 'SERVER_BUSY')
        }

        const id = options.roomId || this.generateId()
        if (this.rooms.has(id)) {
            throw new RoomError('房间已存在!', 'ROOM_EXISTS')
        }

        const room = new Room({
            id,
            hostClient: client,
            hostName: options.hostName,
            password: options.password || '',
            expiresAt: options.expiresAt || 0,
            oneTime: Boolean(options.oneTime),
            maxUsers: Math.min(options.maxUsers || this.maxUsers, this.maxUsers)
        })
        this.rooms.set(id, room)
        return room
    }

    /**
     * @param {string} roomId
     * @param {object} client
     * @param {{ password?: string, name?: string }} [options]
     */
    join(roomId, client, { password = '', name = '' } = {}) {
        const room = this.rooms.get(roomId)
        if (!room) {
            throw new RoomError('房间不存在或已失效!', 'ROOM_NOT_FOUND')
        }
        if (room.isExpired()) {
            this.rooms.delete(roomId)
            throw new RoomError('房间已过期!', 'ROOM_EXPIRED')
        }
        if (room.oneTime && room.size >= 2) {
            throw new RoomError('一次性房间已被使用!', 'ROOM_USED')
        }
        if (room.isFull) {
            throw new RoomError('房间已满!', 'ROOM_FULL')
        }
        if (room.hasPassword && !room.verifyPassword(password)) {
            throw new RoomError(
                password ? '房间密码错误!' : '该房间需要密码',
                password ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED'
            )
        }

        const user = room.addUser(client, { name })
        return { room, user }
    }

    /**
     * @param {Room} room
     * @param {object} client
     */
    leave(room, client) {
        const { user, remaining, newHost } = room.removeUser(client)
        let closed = false
        if (remaining === 0 || room.oneTime) {
            closed = true
            this.rooms.delete(room.id)
        }
        return { user, remaining, newHost, closed }
    }

    delete(roomId) {
        return this.rooms.delete(roomId)
    }

    /**
     * 清理过期房间，返回被移除的房间（调用方负责通知和关闭连接）。
     *
     * @param {number} [now]
     * @returns {Room[]}
     */
    sweep(now = Date.now()) {
        const expired = []
        for (const room of this.rooms.values()) {
            if (room.isExpired(now)) {
                this.rooms.delete(room.id)
                expired.push(room)
            }
        }
        return expired
    }

    clear() {
        this.rooms.clear()
    }

    generateId() {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const id = this.idFactory()
            if (!this.rooms.has(id)) {
                return id
            }
        }
        throw new RoomError('生成房间号失败，请稍后重试', 'ROOM_ID_GENERATION_FAILED')
    }
}

export default new RoomRegistry()
