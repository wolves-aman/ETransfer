import { nanoid } from 'nanoid'
import { sendJson } from './protocol.js'

/**
 * 把一条 SSE 长连接包装成与 ws 客户端相同的接口，
 * 这样 app.js 里的房间逻辑可以同时服务 WebSocket 和 POST+SSE。
 */
class SseClient {
    constructor({ res, onClose }) {
        this.res = res
        this.readyState = 1
        this.OPEN = 1
        this.transport = 'sse'
        this.isAlive = true
        this.session = null
        this.handlers = new Map()
        this.onClose = onClose
    }

    on(event, handler) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, [])
        }
        this.handlers.get(event).push(handler)
    }

    emit(event, ...args) {
        for (const handler of this.handlers.get(event) || []) {
            try {
                handler(...args)
            } catch {
                // 单个监听器失败不影响其它
            }
        }
    }

    ping() {
        // SSE 由服务端注释行保活，不需要 ws ping
    }

    send(raw, callback) {
        if (this.readyState !== 1) {
            callback?.(new Error('SSE 连接已关闭'))
            return false
        }
        try {
            this.res.write(`data: ${raw}\n\n`)
            callback?.()
            return true
        } catch (error) {
            callback?.(error)
            this.close(1011, 'write failed')
            return false
        }
    }

    close(code = 1000, reason = '') {
        if (this.readyState !== 1) {
            return
        }
        this.readyState = 3
        this.onClose?.(code, reason)
    }
}

/**
 * POST + SSE 信令传输。
 *
 * GET  /api/events  建立 SSE，第一帧返回 client_id + token
 * POST /api/signal  携带 client_id + token 发送 CREATE/JOIN/TRANSFER 等消息
 */
export class SseHub {
    constructor({ config, logger, acceptClient, getWsCount }) {
        this.config = config
        this.logger = logger
        this.acceptClient = acceptClient
        this.getWsCount = getWsCount
        this.sessions = new Map()
    }

    get size() {
        return this.sessions.size
    }

    open(req, res) {
        const origin = req.headers.origin
        if (
            this.config.allowedOrigins.length
            && (!origin || !this.config.allowedOrigins.includes(origin))
        ) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'origin not allowed', code: 'ORIGIN_NOT_ALLOWED' }))
            return
        }

        if (this.size + this.getWsCount() >= this.config.maxConnections) {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: '服务器连接数已满', code: 'SERVER_BUSY' }))
            return
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        })
        res.flushHeaders?.()

        const clientId = nanoid(16)
        const token = nanoid(32)
        let heartbeat = null
        let closed = false

        const finalize = (code, reason) => {
            if (closed) return
            closed = true
            clearInterval(heartbeat)
            this.sessions.delete(clientId)
            client.readyState = 3
            client.emit('close', code, reason)
            if (!res.writableEnded) {
                try {
                    res.end()
                } catch {
                    // ignore
                }
            }
            this.logger.info('sse_closed', {
                clientId,
                code,
                reason: String(reason).slice(0, 120),
                sessions: this.size
            })
        }

        const client = new SseClient({
            res,
            onClose: (code, reason) => finalize(code, reason)
        })

        this.sessions.set(clientId, {
            client,
            token,
            createdAt: Date.now(),
            lastSeenAt: Date.now()
        })

        this.acceptClient(client, req)
        sendJson(client, {
            action: 'CONNECTED',
            client_id: clientId,
            token,
            transport: 'sse',
            heartbeat_ms: this.config.heartbeatInterval
        })

        heartbeat = setInterval(() => {
            try {
                res.write(': ping\n\n')
            } catch {
                finalize(1006, 'heartbeat_failed')
            }
        }, this.config.heartbeatInterval)
        heartbeat.unref?.()

        req.on('close', () => finalize(1006, 'request_closed'))
        res.on('close', () => {
            if (!closed) finalize(1006, 'response_closed')
        })

        this.logger.info('sse_opened', {
            clientId,
            ip: req.socket?.remoteAddress,
            sessions: this.size
        })
    }

    /**
     * @param {{ client_id?: string, token?: string, [key: string]: unknown }} body
     */
    signal(body) {
        if (!body || typeof body !== 'object') {
            return { ok: false, status: 400, code: 'INVALID_MESSAGE', error: '消息必须是 JSON 对象' }
        }
        const clientId = typeof body.client_id === 'string' ? body.client_id : ''
        const token = typeof body.token === 'string' ? body.token : ''
        const session = this.sessions.get(clientId)

        if (!session || session.client.readyState !== 1) {
            return { ok: false, status: 404, code: 'SSE_SESSION_NOT_FOUND', error: 'SSE 会话不存在或已断开' }
        }
        if (session.token !== token) {
            return { ok: false, status: 401, code: 'INVALID_TOKEN', error: '无效的 SSE 令牌' }
        }

        session.lastSeenAt = Date.now()
        const { client_id, token: ignoredToken, ...message } = body
        void client_id
        void ignoredToken
        session.client.emit('message', Buffer.from(JSON.stringify(message)))
        return { ok: true }
    }

    close() {
        for (const { client } of this.sessions.values()) {
            client.close(1001, 'server shutdown')
        }
        this.sessions.clear()
    }
}
