import { apiUrl } from '../config'
import { log } from './logger'

const REQUEST_TIMEOUT = 9000

/**
 * POST + SSE 信令客户端。
 *
 * - SSE：接收服务端事件
 * - POST /api/signal：发送创建/加入/TRANSFER/心跳
 *
 * 与 SignalingClient 暴露相同的方法，便于在 store 里切换。
 */
export class SseSignalingClient {
    constructor({ onEvent, onStatus }) {
        this.onEvent = onEvent
        this.onStatus = onStatus
        this.eventsUrl = apiUrl('/api/events')
        this.signalUrl = apiUrl('/api/signal')
        this.source = null
        this.clientId = ''
        this.token = ''
        this.connected = false
        this.pending = new Map()
        this.heartbeat = null
        this.closedByUser = false
        this.connectPromise = null
    }

    isOpen() {
        return this.connected
    }

    connect() {
        if (this.connected) {
            return Promise.resolve()
        }
        if (this.connectPromise) {
            return this.connectPromise
        }
        if (typeof EventSource === 'undefined') {
            return Promise.reject(new Error('当前浏览器不支持 EventSource'))
        }

        this.closedByUser = false
        this.onStatus?.('connecting')
        log.info('signal', '连接 SSE 信令', { url: this.eventsUrl })

        this.connectPromise = new Promise((resolve, reject) => {
            let settled = false
            const source = new EventSource(this.eventsUrl)
            this.source = source

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true
                    source.close()
                    reject(new Error('连接 SSE 信令超时'))
                }
            }, 10_000)

            source.onmessage = (event) => {
                let message
                try {
                    message = JSON.parse(event.data)
                } catch {
                    log.warn('signal', '收到无法解析的 SSE 消息')
                    return
                }

                if (message.action === 'CONNECTED') {
                    clearTimeout(timer)
                    settled = true
                    this.clientId = message.client_id
                    this.token = message.token
                    this.connected = true
                    this.onStatus?.('online')
                    this.startHeartbeat()
                    log.info('signal', 'SSE 信令已连接', {
                        clientId: this.clientId,
                        transport: 'sse'
                    })
                    resolve()
                    return
                }

                this.handleMessage(message)
            }

            source.onerror = () => {
                clearTimeout(timer)
                if (!settled) {
                    settled = true
                    source.close()
                    reject(new Error('无法连接 SSE 信令'))
                    return
                }
                if (!this.closedByUser) {
                    log.warn('signal', 'SSE 信令连接断开')
                    this.handleDisconnect()
                }
            }
        }).finally(() => {
            this.connectPromise = null
        })

        return this.connectPromise
    }

    startHeartbeat() {
        this.stopHeartbeat()
        this.heartbeat = setInterval(() => {
            this.post({ action: 'HEART_BEAT' }).catch((error) => {
                log.warn('signal', 'SSE 心跳失败', { error: error.message })
            })
        }, 12_000)
    }

    stopHeartbeat() {
        if (this.heartbeat) {
            clearInterval(this.heartbeat)
            this.heartbeat = null
        }
    }

    handleMessage(message) {
        const action = message?.action
        const request = action ? this.pending.get(action) : null
        if (request) {
            clearTimeout(request.timer)
            this.pending.delete(action)
            if (message.status === false) {
                const error = new Error(message.msg || '请求失败')
                error.code = message.code
                request.reject(error)
            } else {
                request.resolve(message)
            }
            return
        }
        this.onEvent?.(message)
    }

    handleDisconnect() {
        this.stopHeartbeat()
        this.connected = false
        this.clientId = ''
        this.token = ''
        if (this.source) {
            this.source.close()
            this.source = null
        }
        this.onStatus?.('offline')
        for (const [, request] of this.pending) {
            clearTimeout(request.timer)
            request.reject(new Error('SSE 信令连接已断开'))
        }
        this.pending.clear()
        this.onEvent?.({
            action: 'SIGNAL_CLOSED',
            code: 1006,
            reason: 'sse_disconnected'
        })
    }

    /**
     * @param {Record<string, unknown>} payload
     */
    async post(payload) {
        if (!this.clientId || !this.token) {
            throw new Error('SSE 信令未连接')
        }
        const response = await fetch(this.signalUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: this.clientId,
                token: this.token,
                ...payload
            })
        })
        if (!response.ok) {
            let message = `SSE 信令请求失败 (${response.status})`
            let code = 'SSE_SIGNAL_FAILED'
            try {
                const data = await response.json()
                message = data.error || message
                code = data.code || code
            } catch {
                // ignore
            }
            const error = new Error(message)
            error.code = code
            throw error
        }
    }

    request(action, payload = {}, timeout = REQUEST_TIMEOUT) {
        if (!this.connected) {
            return Promise.reject(new Error('SSE 信令未连接'))
        }
        if (this.pending.has(action)) {
            return Promise.reject(new Error('请求正在处理中'))
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(action)
                reject(new Error('请求超时，请稍后重试'))
            }, timeout)
            this.pending.set(action, { resolve, reject, timer })
            this.post({ action, ...payload }).catch((error) => {
                clearTimeout(timer)
                this.pending.delete(action)
                reject(error)
            })
        })
    }

    send(payload) {
        if (!this.connected) {
            return false
        }
        this.post(payload).catch((error) => {
            log.warn('signal', 'SSE 信令发送失败', { error: error.message })
        })
        return true
    }

    createRoom(options) {
        return this.request('CREATE_ROOM', options)
    }

    joinRoom(options) {
        return this.request('JOIN_ROOM', options)
    }

    leaveRoom() {
        this.send({ action: 'LEAVE_ROOM' })
    }

    kick(peerId) {
        return this.request('KICK', { peer_id: peerId })
    }

    closeRoom() {
        return this.request('CLOSE_ROOM')
    }

    signal(target, type, payload) {
        return this.send({ action: 'TRANSFER', target, type, ...payload })
    }

    close() {
        this.closedByUser = true
        this.stopHeartbeat()
        this.onStatus?.('idle')
        this.connected = false
        this.clientId = ''
        this.token = ''
        if (this.source) {
            this.source.close()
            this.source = null
        }
        for (const [, request] of this.pending) {
            clearTimeout(request.timer)
            request.reject(new Error('SSE 信令连接已断开'))
        }
        this.pending.clear()
    }
}
