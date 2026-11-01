import { randomBytes } from 'node:crypto'
import { Room, RoomError } from '../../server/room/room.js'
import {
    ProtocolError,
    normalizeExpiry,
    normalizeMaxUsers,
    normalizeName,
    normalizePassword,
    normalizeRoomId,
    parseMessage,
    TRANSFER_TYPES
} from '../../server/protocol.js'
import {
    del,
    getJson,
    lpop,
    releaseLock,
    rpush,
    setJson,
    setNx
} from './store.js'

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const CLIENT_TTL_SECONDS = 60 * 60
const EVENT_TTL_SECONDS = 60 * 60
const LOCK_TTL_MS = 5_000
const DEFAULT_EXPIRY_MINUTES = 180
const MAX_EXPIRY_MINUTES = 1_440
const MAX_USERS = 8
const MAX_ROOM_ID_LENGTH = 12
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function randomId(length) {
    const bytes = randomBytes(length)
    let result = ''
    for (let i = 0; i < length; i += 1) {
        result += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length]
    }
    return result
}

function makeClient(clientId, pending) {
    return {
        clientId,
        readyState: 1,
        send(raw) {
            try {
                pending.push({ clientId, message: JSON.parse(raw) })
            } catch {
                // 忽略无法序列化的消息
            }
        },
        close() {
            pending.push({ clientId, message: { __close: true } })
        }
    }
}

async function enqueue(clientId, message) {
    await rpush(`events:${clientId}`, [JSON.stringify(message)], { ttl: EVENT_TTL_SECONDS })
}

async function flush(pending) {
    for (const item of pending) {
        await enqueue(item.clientId, item.message)
    }
}

async function withLock(key, fn) {
    const token = randomBytes(12).toString('hex')
    let acquired = false
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await setNx(`lock:${key}`, token, { px: LOCK_TTL_MS })
        if (result) {
            acquired = true
            break
        }
        await sleep(100)
    }
    if (!acquired) {
        throw new RoomError('操作繁忙，请稍后重试', 'SERVER_BUSY')
    }
    try {
        return await fn()
    } finally {
        await releaseLock(`lock:${key}`, token).catch(() => {})
    }
}

async function loadRoom(roomId, pending) {
    const data = await getJson(`room:${roomId}`)
    if (!data) return null
    if (data.expiresAt && Date.now() >= data.expiresAt) {
        await del(`room:${roomId}`)
        return null
    }
    return Room.fromJSON(data, (clientId) => makeClient(clientId, pending))
}

async function saveRoom(room) {
    await setJson(`room:${room.id}`, room.toJSON(), { px: ROOM_TTL_MS })
}

async function removeRoom(roomId) {
    await del(`room:${roomId}`)
}

async function getClient(clientId) {
    return getJson(`client:${clientId}`)
}

async function saveClient(session) {
    await setJson(`client:${session.id}`, session, { px: CLIENT_TTL_SECONDS })
}

async function bindClient(session, roomId, userId) {
    session.roomId = roomId
    session.userId = userId
    session.lastSeen = Date.now()
    await saveClient(session)
}

async function sendTo(clientId, message) {
    await enqueue(clientId, message)
}

function sendError(clientId, action, code, message) {
    return sendTo(clientId, {
        action: action || 'ERROR',
        status: false,
        code,
        msg: message
    })
}

function closeClient(clientId) {
    return sendTo(clientId, { __close: true })
}

async function closeRoom(room, pending, reason) {
    for (const user of room.usersList) {
        pending.push({
            clientId: user.client.clientId,
            message: {
                action: 'ROOM_CLOSED',
                status: false,
                reason,
                msg: reason === 'expired' ? '房间已过期' : '房间已关闭'
            }
        })
        pending.push({ clientId: user.client.clientId, message: { __close: true } })
        const session = await getClient(user.client.clientId)
        if (session) {
            session.roomId = null
            session.userId = null
            await saveClient(session)
        }
    }
}

export async function createClientSession() {
    const id = randomBytes(8).toString('hex')
    const token = randomBytes(24).toString('hex')
    const session = {
        id,
        token,
        roomId: null,
        userId: null,
        createdAt: Date.now(),
        lastSeen: Date.now()
    }
    await saveClient(session)
    return session
}

export async function getClientSession(clientId, token) {
    const session = await getClient(clientId)
    if (!session || session.token !== token) return null
    session.lastSeen = Date.now()
    await saveClient(session)
    return session
}

export async function pollEvents(clientId, limit = 50) {
    const raw = await lpop(`events:${clientId}`, limit)
    const events = []
    for (const item of raw) {
        try {
            events.push(JSON.parse(item))
        } catch {
            // ignore
        }
    }
    return events
}

export async function handleSignal({ clientId, token, message }) {
    const session = await getClient(clientId)
    if (!session || session.token !== token) {
        return { ok: false, status: 401, code: 'INVALID_TOKEN', error: '无效的 SSE 令牌' }
    }

    let parsed
    try {
        parsed = parseMessage(Buffer.from(JSON.stringify(message)))
    } catch (error) {
        await sendError(clientId, message?.action, error.code || 'BAD_REQUEST', error.message)
        return { ok: true }
    }

    const pending = []
    try {
        switch (parsed.action) {
            case 'CREATE_ROOM':
                await createRoom(session, parsed, pending)
                break
            case 'JOIN_ROOM':
                await joinRoom(session, parsed, pending)
                break
            case 'LEAVE_ROOM':
                await leaveRoom(session, pending, 'left')
                break
            case 'KICK':
                await kickUser(session, parsed, pending)
                break
            case 'CLOSE_ROOM':
                await closeRoomByHost(session, pending)
                break
            case 'TRANSFER':
                await transfer(session, parsed, pending)
                break
            case 'HEART_BEAT':
                pending.push({
                    clientId,
                    message: { action: 'HEART_BEAT', status: true, timestamp: Date.now() }
                })
                break
            default:
                break
        }
    } catch (error) {
        if (error instanceof RoomError || error instanceof ProtocolError) {
            pending.push({
                clientId,
                message: {
                    action: parsed.action,
                    status: false,
                    code: error.code || 'ROOM_ERROR',
                    msg: error.message
                }
            })
        } else {
            console.error('vercel_signal_failed', error)
            pending.push({
                clientId,
                message: {
                    action: parsed.action,
                    status: false,
                    code: 'INTERNAL',
                    msg: '服务器处理消息失败'
                }
            })
        }
    }

    await flush(pending)
    return { ok: true }
}

async function createRoom(session, message, pending) {
    if (session.roomId) {
        throw new RoomError('你已在房间中，请先离开', 'ALREADY_IN_ROOM')
    }

    const requestedId = normalizeRoomId(message.room_id, MAX_ROOM_ID_LENGTH)
    const password = normalizePassword(message.password, { min: 4, max: 64 })
    const expiryMinutes = normalizeExpiry(message.expires_in, DEFAULT_EXPIRY_MINUTES, MAX_EXPIRY_MINUTES)
    const oneTime = Boolean(message.one_time)
    const maxUsers = oneTime ? 2 : normalizeMaxUsers(message.max_users, MAX_USERS, MAX_USERS)
    const hostName = normalizeName(message.name) || '房主'

    const roomId = requestedId || randomId(6)
    const room = await withLock(`room:${roomId}`, async () => {
        if (await getJson(`room:${roomId}`)) {
            throw new RoomError('房间已存在!', 'ROOM_EXISTS')
        }
        const hostClient = makeClient(session.id, pending)
        const created = new Room({
            id: roomId,
            hostClient,
            hostName,
            password,
            expiresAt: expiryMinutes > 0 ? Date.now() + expiryMinutes * 60_000 : 0,
            oneTime,
            maxUsers
        })
        await saveRoom(created)
        return created
    })

    const user = room.usersList[0]
    await bindClient(session, room.id, user.id)

    pending.push({
        clientId: session.id,
        message: {
            action: 'CREATE_ROOM',
            status: true,
            room_id: room.id,
            self_id: user.id,
            self_name: user.name,
            host: true,
            peers: [],
            ...room.info()
        }
    })
}

async function joinRoom(session, message, pending) {
    if (session.roomId) {
        throw new RoomError('你已在房间中，请先离开', 'ALREADY_IN_ROOM')
    }
    const roomId = normalizeRoomId(message.room_id, MAX_ROOM_ID_LENGTH)
    if (!roomId) {
        throw new RoomError('房间号不能为空', 'ROOM_ID_REQUIRED')
    }
    const password = normalizePassword(message.password, { min: 4, max: 64 })
    const name = normalizeName(message.name)

    const { room, user } = await withLock(`room:${roomId}`, async () => {
        const current = await loadRoom(roomId, pending)
        if (!current) {
            throw new RoomError('房间不存在或已失效!', 'ROOM_NOT_FOUND')
        }
        if (current.isExpired()) {
            await removeRoom(roomId)
            throw new RoomError('房间已过期!', 'ROOM_EXPIRED')
        }
        if (current.oneTime && current.size >= 2) {
            throw new RoomError('一次性房间已被使用!', 'ROOM_USED')
        }
        if (current.isFull) {
            throw new RoomError('房间已满!', 'ROOM_FULL')
        }
        if (current.hasPassword && !current.verifyPassword(password)) {
            throw new RoomError(
                password ? '房间密码错误!' : '该房间需要密码',
                password ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED'
            )
        }
        const joined = current.addUser(makeClient(session.id, pending), { name })
        await saveRoom(current)
        return { room: current, user: joined }
    })

    await bindClient(session, room.id, user.id)
    pending.push({
        clientId: session.id,
        message: {
            action: 'JOIN_ROOM',
            status: true,
            room_id: room.id,
            self_id: user.id,
            self_name: user.name,
            host: false,
            peers: room.peerList(user.id),
            ...room.info()
        }
    })
    room.broadcast({ action: 'PEER_JOINED', peer: user.toPublic() }, user.client)
}

async function leaveRoom(session, pending, reason = 'left') {
    if (!session.roomId) {
        throw new RoomError('尚未加入房间', 'NOT_IN_ROOM')
    }
    const roomId = session.roomId
    await withLock(`room:${roomId}`, async () => {
        const room = await loadRoom(roomId, pending)
        if (!room) {
            await bindClient(session, null, null)
            return
        }
        const user = room.getUserById(session.userId)
        if (!user) {
            await bindClient(session, null, null)
            return
        }
        const result = room.removeUser(user.client)
        const remaining = result.remaining
        if (remaining === 0 || room.oneTime) {
            await removeRoom(roomId)
            await closeRoom(room, pending, room.oneTime ? 'one_time_closed' : 'room_closed')
        } else {
            await saveRoom(room)
            room.broadcast({
                action: 'PEER_LEFT',
                peer_id: user.id,
                reason
            }, user.client)
            if (result.newHost) {
                room.broadcast({
                    action: 'HOST_CHANGED',
                    peer_id: result.newHost.id
                }, user.client)
            }
        }
        await bindClient(session, null, null)
    })
}

async function kickUser(session, message, pending) {
    if (!session.roomId) {
        throw new RoomError('尚未加入房间', 'NOT_IN_ROOM')
    }
    const targetId = typeof message.peer_id === 'string' ? message.peer_id : ''
    if (!targetId) {
        throw new ProtocolError('缺少被踢成员 ID', 'TARGET_REQUIRED')
    }

    await withLock(`room:${session.roomId}`, async () => {
        const room = await loadRoom(session.roomId, pending)
        if (!room) {
            throw new RoomError('房间不存在或已失效!', 'ROOM_NOT_FOUND')
        }
        const self = room.getUserById(session.userId)
        if (!self || !self.isHost) {
            throw new RoomError('只有房主可以踢人', 'FORBIDDEN')
        }
        const target = room.getUserById(targetId)
        if (!target) {
            throw new RoomError('成员不存在', 'TARGET_NOT_FOUND')
        }

        pending.push({
            clientId: target.client.clientId,
            message: {
                action: 'KICKED',
                status: false,
                reason: 'host_kicked',
                msg: '你已被房主移出房间'
            }
        })
        pending.push({ clientId: target.client.clientId, message: { __close: true } })

        const result = room.removeUser(target.client)
        const targetSession = await getClient(target.client.clientId)
        if (targetSession) {
            targetSession.roomId = null
            targetSession.userId = null
            await saveClient(targetSession)
        }

        if (result.remaining === 0 || room.oneTime) {
            await removeRoom(room.id)
            await closeRoom(room, pending, 'one_time_closed')
        } else {
            await saveRoom(room)
            room.broadcast({ action: 'PEER_LEFT', peer_id: target.id, reason: 'kicked' })
        }
    })
}

async function closeRoomByHost(session, pending) {
    if (!session.roomId) {
        throw new RoomError('尚未加入房间', 'NOT_IN_ROOM')
    }
    await withLock(`room:${session.roomId}`, async () => {
        const room = await loadRoom(session.roomId, pending)
        if (!room) {
            throw new RoomError('房间不存在或已失效!', 'ROOM_NOT_FOUND')
        }
        const self = room.getUserById(session.userId)
        if (!self || !self.isHost) {
            throw new RoomError('只有房主可以关闭房间', 'FORBIDDEN')
        }
        await removeRoom(room.id)
        await closeRoom(room, pending, 'host_closed')
    })
}

async function transfer(session, message, pending) {
    if (!session.roomId) {
        throw new ProtocolError('尚未加入房间', 'NOT_IN_ROOM')
    }
    const room = await loadRoom(session.roomId, pending)
    if (!room) {
        throw new ProtocolError('房间不存在或已失效!', 'ROOM_NOT_FOUND')
    }
    const self = room.getUserById(session.userId)
    if (!self) {
        throw new ProtocolError('尚未加入房间', 'NOT_IN_ROOM')
    }

    const type = message.type
    if (typeof type !== 'string' || !TRANSFER_TYPES.has(type)) {
        throw new ProtocolError('不支持的传输类型', 'INVALID_TRANSFER_TYPE')
    }

    let targetId = typeof message.target === 'string' ? message.target : ''
    if (!targetId) {
        const peers = room.peerList(self.id)
        if (peers.length === 1) {
            targetId = peers[0].id
        } else {
            throw new ProtocolError('多人房间必须指定传输目标', 'TARGET_REQUIRED')
        }
    }
    if (targetId === self.id) {
        throw new ProtocolError('不能向自己发送信令', 'INVALID_TARGET')
    }
    const target = room.getUserById(targetId)
    if (!target) {
        throw new ProtocolError('目标成员不存在', 'TARGET_NOT_FOUND')
    }

    const payload = {
        action: 'TRANSFER',
        from: self.id,
        type
    }
    if (type === 'candidate') {
        const candidate = message.candidate
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new ProtocolError('无效的 ICE candidate', 'INVALID_CANDIDATE')
        }
        payload.candidate = candidate
    } else {
        const description = message[type]
        if (
            !description
            || typeof description !== 'object'
            || description.type !== type
            || typeof description.sdp !== 'string'
        ) {
            throw new ProtocolError('无效的会话描述', 'INVALID_DESCRIPTION')
        }
        payload[type] = { type: description.type, sdp: description.sdp }
    }
    pending.push({ clientId: target.client.clientId, message: payload })
}

export async function disconnectClient(clientId) {
    const session = await getClient(clientId)
    if (!session) return
    if (session.roomId) {
        const pending = []
        try {
            await leaveRoom(session, pending, 'connection_closed')
            await flush(pending)
        } catch {
            // 房间可能已经关闭
        }
    }
    await del(`client:${clientId}`)
}

export async function markClientClosed(clientId) {
    await closeClient(clientId)
}
