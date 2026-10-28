const isDev = process.env.NODE_ENV === 'development'
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const host = window.location.hostname || '127.0.0.1'
const devPort = window.location.port === '8080'

function trimBase(value) {
    return String(value || '').replace(/\/+$/, '')
}

const apiBase = window.API_URL !== undefined
    ? trimBase(window.API_URL)
    : isDev || devPort
        ? `${window.location.protocol}//${host}:9090`
        : ''

export const runtime = {
    wsUrl: window.WSURL || `${protocol}//${host}:9090`,
    apiBase,
    iceServers: window.WEBRTC_CONFIG?.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ],
    chunkSize: 64 * 1024,
    highWaterMark: 1024 * 1024,
    lowWaterMark: 256 * 1024,
    // 接收端写入 OPFS 的确认窗口：发送端未确认字节超过该值时等待
    receiveWindow: 8 * 1024 * 1024,
    // 没有 OPFS 时退回内存聚合，超过该大小的文件直接拒绝
    maxMemoryReceiveBytes: 128 * 1024 * 1024,
    opfsCleanupMaxAge: 7 * 24 * 60 * 60 * 1000,
    maxMeshPeers: 8,
    version: '0.2.0'
}

export function apiUrl(path) {
    return `${apiBase}${path}`
}
