import { reactive } from 'vue'

const MAX_ENTRIES = 800

export const logState = reactive({
    entries: []
})

let sequence = 0

function normalizeData(data) {
    if (data === undefined || data === null) return ''
    if (typeof data === 'string') return data.slice(0, 600)
    try {
        return JSON.stringify(data).slice(0, 600)
    } catch {
        return String(data).slice(0, 600)
    }
}

function push(level, scope, message, data) {
    sequence += 1
    logState.entries.push({
        id: sequence,
        ts: Date.now(),
        level,
        scope,
        message: String(message),
        data: normalizeData(data)
    })
    if (logState.entries.length > MAX_ENTRIES) {
        logState.entries.splice(0, logState.entries.length - MAX_ENTRIES)
    }
}

export const log = {
    debug: (scope, message, data) => push('debug', scope, message, data),
    info: (scope, message, data) => push('info', scope, message, data),
    warn: (scope, message, data) => push('warn', scope, message, data),
    error: (scope, message, data) => push('error', scope, message, data),
    clear: () => {
        logState.entries.splice(0, logState.entries.length)
    },
    exportText: () => logState.entries
        .map((entry) => `${new Date(entry.ts).toISOString()} [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}${entry.data ? ` ${entry.data}` : ''}`)
        .join('\n')
}
