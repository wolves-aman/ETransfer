import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createConfig } from './config.js'
import { createLogger } from './logger.js'
import { createHttpHandler } from './http-api.js'
import { RelayStore } from './relay-store.js'
import {
    ProtocolError,
    TRANSFER_TYPES,
    errorMessage,
    normalizeExpiry,
    normalizeMaxUsers,
    normalizeName,
    normalizePassword,
    normalizeRoomId,
    parseMessage,
    sendJson
} from './protocol.js'
import { RoomError, RoomRegistry } from './room/room.js'

class FixedWindowRateLimiter {
    constructor({ maxMessages, windowMs }) {
        this.maxMessages = maxMessages
        this.windowMs = windowMs
        this.windowStart = 0
        this.count = 0
    }

    consume(now = Date.now()) {
        if (now - this.windowStart >= this.windowMs) {
            this.windowStart = now
            this.count = 0
        }
        this.count += 1
        return this.count <= this.maxMessages
    }
}

/**
 * 创建信令 + HTTP 服务。
 *
 * @param {{ config?: object, logger?: ReturnType<typeof createLogger> }} [options]
 */
export function createSignalingServer({ config: overrides = {}, logger } = {}) {
    const config = createConfig(overrides)
    const log = logger ?? createLogger({ level: config.logLevel })
    const registry = new RoomRegistry({
        maxRooms: config.maxRooms,
        maxUsers: config.maxUsers,
        roomIdLength: config.roomIdLength
    })
    const relay = new RelayStore(config.relay)

    const httpServer = http.createServer(
        createHttpHandler({ config, logger: log, relay })
    )
    const wss = new WebSocketServer({
        server: httpServer,
        maxPayload: config.maxPayload,
        clientTracking: true
    })

    // 服务端主动 ping；客户端 pong 后标记存活。半开连接会被 terminate。
    const heartbeatTimer = setInterval(() => {
        for (const client of wss.clients) {
            if (client.isAlive === false) {
                log.warn('client_heartbeat_timeout')
                client.terminate()
                continue
            }
            client.isAlive = false
            try {
                client.ping()
            } catch (error) {
                log.warn('client_ping_failed', { error: error.message })
            }
        }
    }, config.heartbeatInterval)
    heartbeatTimer.unref?.()

    // 过期房间、过期中继文件清理。
    const sweepTimer = setInterval(() => {
        for (const room of registry.sweep()) {
            log.info('room_expired', { roomId: room.id })
            closeRoom(room, 'expired')
        }
        relay.sweep().catch((error) => log.warn('relay_sweep_failed', { error: error.message }))
    }, config.sweepInterval)
    sweepTimer.unref?.()

    wss.on('error', (error) => {
        log.error('server_error', { code: error.code, error: error.message })
    })

    wss.on('connection', (client, request) => {
        if (!isOriginAllowed(request)) {
            log.warn('connection_rejected_origin', {
                origin: request.headers.origin,
                ip: request.socket.remoteAddress
            })
            client.close(1008, 'origin not allowed')
            return
        }

        if (wss.clients.size > config.maxConnections) {
            log.warn('connection_rejected_busy', { connections: wss.clients.size })
            client.close(1013, 'server busy')
            return
        }

        const session = {
            room: null,
            user: null,
            limiter: new FixedWindowRateLimiter(config.rateLimit)
        }
        client.session = session

        client.isAlive = true
        client.on('pong', () => {
            client.isAlive = true
        })
        client.on('error', (error) => {
            log.warn('client_socket_error', { error: error.message })
        })
        client.on('message', (raw) => {
            handleMessage(client, session, raw)
        })
        client.on('close', (code, reason) => {
            const roomId = session.room?.id
            leaveRoom(client, session, 'connection_closed')
            log.info('connection_closed', {
                roomId,
                code,
                reason: reason.toString().slice(0, 120),
                connections: wss.clients.size
            })
        })

        log.info('connection_open', {
            origin: request.headers.origin,
            ip: request.socket.remoteAddress,
            connections: wss.clients.size
        })
    })

    function handleMessage(client, session, raw) {
        if (!session.limiter.consume()) {
            log.warn('client_rate_limited')
            sendJson(client, errorMessage('ERROR', 'RATE_LIMITED', '消息发送过于频繁'))
            client.close(1008, 'rate limited')
            return
        }

        let message
        try {
            message = parseMessage(raw)
        } catch (error) {
            if (error instanceof ProtocolError) {
                log.debug('message_invalid', { code: error.code, error: error.message })
                sendJson(client, errorMessage('ERROR', error.code, error.message))
                return
            }
            log.error('message_parse_failed', { error: error.stack })
            client.close(1011, 'internal error')
            return
        }

        try {
            switch (message.action) {
                case 'CREATE_ROOM':
                    createRoom(client, session, message)
                    break
                case 'JOIN_ROOM':
                    joinRoom(client, session, message)
                    break
                case 'LEAVE_ROOM':
                    leaveRoomByRequest(client, session)
                    break
                case 'KICK':
                    kickUser(client, session, message)
                    break
                case 'CLOSE_ROOM':
                    closeRoomByRequest(client, session)
                    break
                case 'TRANSFER':
                    transfer(client, session, message)
                    break
                case 'HEART_BEAT':
                    sendJson(client, {
                        action: 'HEART_BEAT',
                        status: true,
                        timestamp: Date.now()
                    })
                    break
                default:
                    break
            }
        } catch (error) {
            if (error instanceof ProtocolError || error instanceof RoomError) {
                log.debug('message_rejected', {
                    action: message.action,
                    code: error.code,
                    error: error.message
                })
                sendJson(client, errorMessage(message.action, error.code, error.message))
                return
            }
            log.error('message_handler_failed', {
                action: message.action,
                error: error.stack
            })
            sendJson(client, errorMessage(message.action, 'INTERNAL', '服务器处理消息失败'))
        }
    }

    function createRoom(client, session, message) {
        if (session.room) {
            throw new RoomError('你已在房间中，请先离开', 'ALREADY_IN_ROOM')
        }

        const roomId = normalizeRoomId(message.room_id, config.maxRoomIdLength)
        const password = normalizePassword(message.password, {
            min: config.passwordMinLength,
            max: config.passwordMaxLength
        })
        const expiryMinutes = normalizeExpiry(
            message.expires_in,
            config.defaultExpiryMinutes,
            config.maxExpiryMinutes
        )
        const oneTime = Boolean(message.one_time)
        const maxUsers = oneTime
            ? 2
            : normalizeMaxUsers(message.max_users, config.maxUsers, config.maxUsers)
        const hostName = normalizeName(message.name) || '房主'

        const room = registry.create({
            roomId,
            password,
            expiresAt: expiryMinutes > 0 ? Date.now() + expiryMinutes * 60_000 : 0,
            oneTime,
            maxUsers,
            hostName
        }, client)
        const user = room.users.get(client)
        session.room = room
        session.user = user

        sendJson(client, {
            action: 'CREATE_ROOM',
            status: true,
            room_id: room.id,
            self_id: user.id,
            self_name: user.name,
            host: true,
            peers: [],
            ...room.info()
        })
        log.info('room_created', {
            roomId: room.id,
            users: room.size,
            maxUsers: room.maxUsers,
            oneTime,
            hasPassword: room.hasPassword,
            expiresAt: room.expiresAt
        })
    }

    function joinRoom(client, session, message) {
        if (session.room) {
            throw new RoomError('你已在房间中，请先离开', 'ALREADY_IN_ROOM')
        }
        const roomId = normalizeRoomId(message.room_id, config.maxRoomIdLength)
        if (!roomId) {
            throw new ProtocolError('房间号不能为空!', 'INVALID_ROOM_ID')
        }

        const password = typeof message.password === 'string' ? message.password : ''
        const name = normalizeName(message.name)
        const { room, user } = registry.join(roomId, client, { password, name })
        session.room = room
        session.user = user

        sendJson(client, {
            action: 'JOIN_ROOM',
            status: true,
            room_id: room.id,
            self_id: user.id,
            self_name: user.name,
            host: user.isHost,
            peers: room.peerList(user.id),
            ...room.info()
        })
        room.broadcast({
            action: 'PEER_JOINED',
            peer: user.toPublic()
        }, client)
        log.info('room_joined', { roomId: room.id, users: room.size })
    }

    function leaveRoomByRequest(client, session) {
        if (!session.room) {
            sendJson(client, {
                action: 'LEAVE_ROOM',
                status: true,
                msg: '当前不在房间中'
            })
            return
        }
        leaveRoom(client, session, 'client_request')
        sendJson(client, {
            action: 'LEAVE_ROOM',
            status: true,
            msg: '已离开房间'
        })
    }

    /**
     * 统一离开逻辑：广播、房主迁移、一次性房间关闭。
     *
     * @param {object} client
     * @param {object} session
     * @param {string} reason
     */
    function leaveRoom(client, session, reason) {
        const room = session.room
        const user = session.user
        if (!room || !user) {
            session.room = null
            session.user = null
            return
        }

        session.room = null
        session.user = null
        const { remaining, newHost, closed } = registry.leave(room, client)

        if (remaining > 0) {
            room.broadcast({
                action: 'PEER_LEFT',
                peer_id: user.id,
                reason
            }, client)
            if (newHost) {
                room.broadcast({
                    action: 'HOST_CHANGED',
                    peer_id: newHost.id
                }, client)
            }
        }

        log.info('room_left', {
            roomId: room.id,
            peerId: user.id,
            remaining,
            reason
        })

        if (closed) {
            closeRoom(room, room.oneTime ? 'one_time_closed' : 'room_closed')
        }
    }

    function kickUser(client, session, message) {
        const room = session.room
        if (!room || !session.user) {
            throw new RoomError('尚未加入房间', 'NOT_IN_ROOM')
        }
        if (!session.user.isHost) {
            throw new RoomError('只有房主可以移除成员', 'NOT_HOST')
        }

        const peerId = typeof message.peer_id === 'string' ? message.peer_id : ''
        const target = room.getUserById(peerId)
        if (!target) {
            throw new RoomError('成员不存在或已离开', 'PEER_NOT_FOUND')
        }
        if (target.isHost) {
            throw new RoomError('不能移除房主', 'CANNOT_KICK_HOST')
        }

        const targetSession = target.client.session
        if (targetSession) {
            targetSession.room = null
            targetSession.user = null
        }
        const { closed } = registry.leave(room, target.client)

        sendJson(target.client, {
            action: 'KICKED',
            status: false,
            reason: 'host_kicked',
            msg: '你已被房主移出房间'
        })
        setTimeout(() => {
            if (target.client.readyState === 1) {
                target.client.close(4003, 'kicked')
            }
        }, 40).unref?.()

        if (!closed) {
            room.broadcast({
                action: 'PEER_LEFT',
                peer_id: target.id,
                reason: 'kicked'
            })
        }
        log.info('peer_kicked', {
            roomId: room.id,
            peerId: target.id,
            by: session.user.id
        })

        if (closed) {
            closeRoom(room, 'one_time_closed')
        }
    }

    function closeRoomByRequest(client, session) {
        if (!session.room || !session.user) {
            throw new RoomError('尚未加入房间', 'NOT_IN_ROOM')
        }
        if (!session.user.isHost) {
            throw new RoomError('只有房主可以关闭房间', 'NOT_HOST')
        }
        const room = session.room
        registry.delete(room.id)
        closeRoom(room, 'host_closed')
        log.info('room_closed_by_host', { roomId: room.id })
    }

    /**
     * 关闭房间并通知所有成员。调用前应确保房间已从 registry 删除。
     *
     * @param {import('./room/room.js').Room} room
     * @param {string} reason
     */
    function closeRoom(room, reason) {
        if (room.closed) {
            return
        }
        room.closed = true
        for (const member of room.usersList) {
            if (member.client.session) {
                member.client.session.room = null
                member.client.session.user = null
            }
            sendJson(member.client, {
                action: 'ROOM_CLOSED',
                status: false,
                reason,
                msg: reason === 'expired' ? '房间已过期' : '房间已关闭'
            })
            const memberClient = member.client
            setTimeout(() => {
                if (memberClient.readyState === 1) {
                    memberClient.close(4001, reason)
                }
            }, 40).unref?.()
        }
        log.info('room_closed', { roomId: room.id, reason, users: room.size })
    }

    function transfer(client, session, message) {
        const room = session.room
        if (!room || !session.user) {
            throw new ProtocolError('尚未加入房间', 'NOT_IN_ROOM')
        }

        const type = message.type
        if (typeof type !== 'string' || !TRANSFER_TYPES.has(type)) {
            throw new ProtocolError('不支持的传输类型', 'INVALID_TRANSFER_TYPE')
        }

        let targetId = typeof message.target === 'string' ? message.target : ''
        if (!targetId) {
            const peers = room.peerList(session.user.id)
            if (peers.length === 1) {
                targetId = peers[0].id
            } else {
                throw new ProtocolError('多人房间必须指定传输目标', 'TARGET_REQUIRED')
            }
        }
        if (targetId === session.user.id) {
            throw new ProtocolError('不能向自己发送信令', 'INVALID_TARGET')
        }

        const target = room.getUserById(targetId)
        if (!target) {
            throw new ProtocolError('目标成员不存在', 'TARGET_NOT_FOUND')
        }

        const payload = {
            action: 'TRANSFER',
            from: session.user.id,
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
                !description ||
                typeof description !== 'object' ||
                description.type !== type ||
                typeof description.sdp !== 'string'
            ) {
                throw new ProtocolError('无效的会话描述', 'INVALID_DESCRIPTION')
            }
            payload[type] = {
                type: description.type,
                sdp: description.sdp
            }
        }

        sendJson(target.client, payload)
    }

    function isOriginAllowed(request) {
        if (config.allowedOrigins.length === 0) {
            return true
        }
        const origin = request.headers.origin
        return typeof origin === 'string' && config.allowedOrigins.includes(origin)
    }

    /**
     * 启动监听。
     *
     * @param {number} [port]
     * @param {string} [host]
     */
    function listen(port = config.port, host = config.host) {
        return new Promise((resolve, reject) => {
            const onError = (error) => {
                httpServer.off('listening', onListening)
                reject(error)
            }
            const onListening = () => {
                httpServer.off('error', onError)
                const address = httpServer.address()
                log.info('server_listening', {
                    host: address.address,
                    port: address.port,
                    maxPayload: config.maxPayload,
                    relay: config.relay.enabled
                })
                resolve(address)
            }
            httpServer.once('error', onError)
            httpServer.once('listening', onListening)
            httpServer.listen(port, host)
        })
    }

    function close() {
        clearInterval(heartbeatTimer)
        clearInterval(sweepTimer)
        return new Promise((resolve) => {
            for (const client of wss.clients) {
                client.close(1001, 'server shutdown')
            }

            const timeout = setTimeout(resolve, config.shutdownTimeout)
            timeout.unref?.()

            wss.close(() => {
                httpServer.close(() => {
                    clearTimeout(timeout)
                    resolve()
                })
            })
        })
    }

    return {
        httpServer,
        wss,
        registry,
        relay,
        config,
        logger: log,
        listen,
        close
    }
}
