/**
 * 服务端配置。
 *
 * 所有配置都可以通过环境变量覆盖，默认值适合本地开发。
 * 生产环境至少应设置 PORT、ALLOWED_ORIGINS，并在反向代理上启用 TLS（wss）。
 */

import { fileURLToPath } from 'node:url'

const toInteger = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

const toNumber = (value, fallback) => {
    const parsed = Number(value ?? '')
    return Number.isFinite(parsed) ? parsed : fallback
}

const toList = (value) => String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const toBoolean = (value, fallback) => {
    if (value === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

const baseConfig = {
    // 监听地址与端口。HOST=0.0.0.0 才能被容器外/局域网访问。
    host: process.env.HOST || '0.0.0.0',
    port: toInteger(process.env.PORT, 9090),

    // 单条 WebSocket 消息最大字节数，防止超大 SDP 或恶意载荷打满内存。
    maxPayload: toInteger(process.env.MAX_PAYLOAD, 64 * 1024),

    // 连接数 / 房间数上限，避免单机被刷爆。
    maxConnections: toInteger(process.env.MAX_CONNECTIONS, 10_000),
    maxRooms: toInteger(process.env.MAX_ROOMS, 5_000),

    // 每个房间最多人数（mesh）。前端会按 2/4/6/8 提供选项，服务端最终兜底。
    maxUsers: toInteger(process.env.MAX_USERS, 8),
    minUsers: 2,

    // 房间号：自动生成 6 位短码，也允许用户自定义。
    roomIdLength: toInteger(process.env.ROOM_ID_LENGTH, 6),
    maxRoomIdLength: toInteger(process.env.MAX_ROOM_ID_LENGTH, 12),

    // 房间有效期（分钟）与清理频率。
    defaultExpiryMinutes: toNumber(process.env.DEFAULT_EXPIRY_MINUTES, 180),
    maxExpiryMinutes: toNumber(process.env.MAX_EXPIRY_MINUTES, 1440),
    sweepInterval: toInteger(process.env.SWEEP_INTERVAL, 30_000),

    // 房间密码。
    passwordMinLength: 4,
    passwordMaxLength: 64,

    // 心跳：服务端每 heartbeatInterval 毫秒 ping 一次，未 pong 的连接会被断开。
    heartbeatInterval: toInteger(process.env.HEARTBEAT_INTERVAL, 30_000),

    // 单连接限流（固定窗口）。
    rateLimit: {
        windowMs: toInteger(process.env.RATE_LIMIT_WINDOW, 10_000),
        maxMessages: toInteger(process.env.RATE_LIMIT_MAX, 200)
    },

    // 允许的浏览器 Origin，逗号分隔；为空表示不校验（仅建议开发环境）。
    allowedOrigins: toList(process.env.ALLOWED_ORIGINS),

    // 日志级别：debug | info | warn | error | silent
    logLevel: process.env.LOG_LEVEL || 'info',

    // 优雅关闭的最长等待时间。
    shutdownTimeout: toInteger(process.env.SHUTDOWN_TIMEOUT, 5_000),

    // 链接预览（服务端代为抓取，避免浏览器 CORS）。
    preview: {
        timeoutMs: toInteger(process.env.PREVIEW_TIMEOUT, 5_000),
        maxBytes: toInteger(process.env.PREVIEW_MAX_BYTES, 512 * 1024),
        cacheTtlMs: toInteger(process.env.PREVIEW_CACHE_TTL, 10 * 60 * 1000)
    },

    // P2P 失败时的中继兜底。默认为本机磁盘；S3/OSS 适配器可替换 relay-store 实现。
    relay: {
        enabled: toBoolean(process.env.RELAY_ENABLED, true),
        dir: process.env.RELAY_DIR || fileURLToPath(new URL('./data/relay/', import.meta.url)),
        maxBytes: toInteger(process.env.RELAY_MAX_BYTES, 200 * 1024 * 1024),
        ttlMs: toInteger(process.env.RELAY_TTL, 24 * 60 * 60 * 1000)
    }
}

/**
 * 生成配置对象。
 * 传入的 overrides 会覆盖默认值，嵌套对象做浅合并（方便测试）。
 *
 * @param {Partial<typeof baseConfig>} [overrides]
 * @returns {typeof baseConfig}
 */
export function createConfig(overrides = {}) {
    return {
        ...baseConfig,
        ...overrides,
        rateLimit: {
            ...baseConfig.rateLimit,
            ...(overrides.rateLimit || {})
        },
        preview: {
            ...baseConfig.preview,
            ...(overrides.preview || {})
        },
        relay: {
            ...baseConfig.relay,
            ...(overrides.relay || {})
        }
    }
}

export const config = createConfig()
