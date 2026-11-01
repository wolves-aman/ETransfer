export function formatBytes(value, digits = 1) {
    const size = Number(value) || 0
    if (size <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
    const scaled = size / (1024 ** index)
    return `${parseFloat(scaled.toFixed(index === 0 ? 0 : digits))} ${units[index]}`
}

export function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond) return '0 B/s'
    return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--'
    if (seconds < 1) return '<1s'
    if (seconds < 60) return `${Math.ceil(seconds)}s`
    const minutes = Math.floor(seconds / 60)
    const rest = Math.floor(seconds % 60)
    if (minutes < 60) return `${minutes}m ${rest}s`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now())
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
    })
}

export function formatDateTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now())
    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    })
}

export function formatCountdown(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return '永久'
    const total = Math.floor(milliseconds / 1000)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m`
    return `${total}s`
}

export function groupCode(code = '') {
    return String(code).toUpperCase().replace(/[^A-Z0-9_-]/g, '')
}

export function initials(name = '') {
    const value = String(name).trim()
    if (!value) return 'ET'
    if (/[\u4e00-\u9fa5]/.test(value)) {
        return value.slice(0, 1)
    }
    const parts = value.split(/\s+/).filter(Boolean)
    return (parts[0]?.[0] || 'E') + (parts[1]?.[0] || '').toUpperCase()
}

export function percent(done, total) {
    if (!total) return 0
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

export function truncate(value, max = 42) {
    const text = String(value || '')
    return text.length > max ? `${text.slice(0, max)}…` : text
}
