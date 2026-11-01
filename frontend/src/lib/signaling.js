import { log } from './logger'

const REQUEST_TIMEOUT = 9000

export class SignalingClient {
    constructor({ url, onEvent, onStatus }) {
        this.url = url
        this.onEvent = onEvent
        this.onStatus = onStatus
        this.socket = null
        this.pending = new Map()
        this.heartbeat = null
        this.closedByUser = false
        this.connectPromise = null
    }

    isOpen() {
        return this.socket?.readyState === WebSocket.OPEN
    }

    connect() {
        if (this.socket?.readyState === WebSocket.OPEN) {
            return Promise.resolve()
        }
        if (this.connectPromise) {
            return this.connectPromise
        }

        this.closedByUser = false
        this.onStatus?.('connecting')
        log.info('signal', '连接信令服务', { url: this.url })

        this.connectPromise = new Promise((resolve, reject) => {
            let settled = false
            const socket = new WebSocket(this.url)
            this.socket = socket

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true
                    socket.close()
                    reject(new Error('连接信令服务超时'))
                }
            }, 8000)

            socket.onopen = () => {
                clearTimeout(timer)
                settled = true
                this.onStatus?.('online')
                log.info('signal', '信令服务已连接')
                this.startHeartbeat()
                resolve()
            }

            socket.onerror = () => {
                log.warn('signal', '信令服务连接错误')
            }

            socket.onclose = (event) => {
                clearTimeout(timer)
                this.stopHeartbeat()
                if (this.socket !== socket) {
                    // 旧连接在重连之后才关闭，不要覆盖新连接状态
                    return
                }
                this.socket = null
                this.onStatus?.(this.closedByUser ? 'idle' : 'offline')
                log.warn('signal', '信令连接关闭', { code: event.code, reason: event.reason })
                for (const [, request] of this.pending) {
                    clearTimeout(request.timer)
                    request.reject(new Error('信令连接已断开'))
                }
                this.pending.clear()
                if (!settled) {
                    settled = true
                    reject(new Error('无法连接信令服务'))
                }
                if (!this.closedByUser) {
                    this.onEvent?.({ action: 'SIGNAL_CLOSED', code: event.code, reason: event.reason })
                }
            }

            socket.onmessage = (event) => {
                let message
                try {
                    message = JSON.parse(event.data)
                } catch {
                    log.warn('signal', '收到无法解析的信令消息')
                    return
                }
                this.handleMessage(message)
            }
        }).finally(() => {
            this.connectPromise = null
        })

        return this.connectPromise
    }

    startHeartbeat() {
        this.stopHeartbeat()
        this.heartbeat = setInterval(() => {
            this.send({ action: 'HEART_BEAT' })
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

    request(action, payload = {}, timeout = REQUEST_TIMEOUT) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('信令服务未连接'))
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
            this.send({ action, ...payload })
        })
    }

    send(payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false
        }
        try {
            this.socket.send(JSON.stringify(payload))
            return true
        } catch (error) {
            log.warn('signal', '信令发送失败', { error: error.message })
            return false
        }
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
        for (const [, request] of this.pending) {
            clearTimeout(request.timer)
            request.reject(new Error('信令连接已断开'))
        }
        this.pending.clear()
        const socket = this.socket
        this.socket = null
        if (socket) {
            socket.close()
        }
    }
}
