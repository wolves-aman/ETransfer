/**
 * 客户端 <-> 信令服务 的协议层：解析、校验、发送。
 *
 * 服务端收到的一切都视为不可信输入：
 *  - JSON 解析失败 / 非对象 / 未知 action 一律抛 ProtocolError；
 *  - 房间号统一转为大写，只允许字母、数字、下划线或中划线；
 *  - TRANSFER 只转发白名单字段，避免把任意客户端数据透传给对端。
 */

export const ACTIONS = new Set([
    'CREATE_ROOM',
    'JOIN_ROOM',
    'LEAVE_ROOM',
    'KICK',
    'CLOSE_ROOM',
    'TRANSFER',
    'HEART_BEAT'
])

export const TRANSFER_TYPES = new Set(['offer', 'answer', 'candidate'])

const ROOM_ID_PATTERN = /^[A-Z0-9_-]+$/

export class ProtocolError extends Error {
    constructor(message, code = 'BAD_REQUEST') {
        super(message)
        this.name = 'ProtocolError'
        this.code = code
    }
}

/**
 * ws 的 readyState 常量：0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED。
 */
export function isOpen(client) {
    return client?.readyState === 1
}

/**
 * 解析客户端消息。
 *
 * @param {string | Buffer | Uint8Array} raw
 * @returns {Record<string, unknown>}
 * @throws {ProtocolError}
 */
export function parseMessage(raw) {
    const text = typeof raw === 'string'
        ? raw
        : raw instanceof Uint8Array
            ? Buffer.from(raw).toString('utf8')
            : ''

    if (!text) {
        throw new ProtocolError('消息不能为空', 'EMPTY_MESSAGE')
    }

    let message
    try {
        message = JSON.parse(text)
    } catch {
        throw new ProtocolError('消息格式错误', 'INVALID_JSON')
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new ProtocolError('消息必须是 JSON 对象', 'INVALID_MESSAGE')
    }

    if (typeof message.action !== 'string' || !ACTIONS.has(message.action)) {
        throw new ProtocolError('未知的消息类型', 'UNKNOWN_ACTION')
    }

    return message
}

/**
 * 校验并规范化房间号（短码）。
 * 空值返回 ''（表示让服务端自动生成）。
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function normalizeRoomId(value, maxLength = 12) {
    if (value === undefined || value === null) {
        return ''
    }
    if (typeof value !== 'string') {
        throw new ProtocolError('房间号必须是字符串', 'INVALID_ROOM_ID')
    }

    const roomId = value.trim().toUpperCase()
    if (!roomId) {
        return ''
    }
    if (roomId.length < 4) {
        throw new ProtocolError('房间号至少 4 个字符', 'INVALID_ROOM_ID')
    }
    if (roomId.length > maxLength) {
        throw new ProtocolError(`房间号不能超过 ${maxLength} 个字符`, 'INVALID_ROOM_ID')
    }
    if (!ROOM_ID_PATTERN.test(roomId)) {
        throw new ProtocolError('房间号只能包含字母、数字、下划线和中划线', 'INVALID_ROOM_ID')
    }
    return roomId
}

/**
 * 校验房间密码。空值表示不设置/不校验。
 *
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [limits]
 * @returns {string}
 */
export function normalizePassword(value, { min = 4, max = 64 } = {}) {
    if (value === undefined || value === null || value === '') {
        return ''
    }
    if (typeof value !== 'string') {
        throw new ProtocolError('密码必须是字符串', 'INVALID_PASSWORD')
    }
    if (value.length < min) {
        throw new ProtocolError(`密码至少 ${min} 个字符`, 'INVALID_PASSWORD')
    }
    if (value.length > max) {
        throw new ProtocolError(`密码不能超过 ${max} 个字符`, 'INVALID_PASSWORD')
    }
    return value
}

/**
 * 校验显示名称。
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function normalizeName(value, maxLength = 24) {
    if (typeof value !== 'string') {
        return ''
    }
    return value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, maxLength)
}

/**
 * 房间有效期（分钟）。0 表示永久；非法值回退到默认值。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function normalizeExpiry(value, fallback, max) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback
    }
    if (parsed === 0) {
        return 0
    }
    return Math.min(Math.max(parsed, 1), max)
}

/**
 * 房间人数上限。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function normalizeMaxUsers(value, fallback, max) {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed)) {
        return fallback
    }
    return Math.min(Math.max(parsed, 2), max)
}

/**
 * 安全发送：socket 未 OPEN 时直接放弃。
 *
 * @param {{ readyState: number, send: Function }} client
 * @param {Record<string, unknown>} message
 * @param {(error: Error) => void} [onError]
 * @returns {boolean}
 */
export function sendJson(client, message, onError) {
    if (!isOpen(client)) {
        return false
    }
    try {
        client.send(JSON.stringify(message), (error) => {
            if (error && onError) {
                onError(error)
            }
        })
        return true
    } catch (error) {
        if (onError) {
            onError(error)
        }
        return false
    }
}

/**
 * 构造统一的错误响应。
 *
 * @param {string} action
 * @param {string} code
 * @param {string} message
 */
export function errorMessage(action, code, message) {
    return {
        action: action || 'ERROR',
        status: false,
        code,
        msg: message
    }
}
