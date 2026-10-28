import { reactive } from 'vue'

export const feedback = reactive({
    toasts: [],
    dialog: null
})

let sequence = 0
const timers = new Map()

const ICONS = {
    success: 'check',
    error: 'alert',
    warn: 'alert',
    info: 'info'
}

function push(type, title, message = '', duration = 3600) {
    const id = ++sequence
    const item = {
        id,
        type,
        title,
        message,
        duration,
        icon: ICONS[type] || 'info'
    }
    feedback.toasts.push(item)
    if (feedback.toasts.length > 4) {
        const removed = feedback.toasts.shift()
        clearTimeout(timers.get(removed.id))
        timers.delete(removed.id)
    }
    if (duration > 0) {
        timers.set(id, setTimeout(() => dismissToast(id), duration))
    }
    return id
}

export function dismissToast(id) {
    const index = feedback.toasts.findIndex((item) => item.id === id)
    if (index !== -1) {
        feedback.toasts.splice(index, 1)
    }
    clearTimeout(timers.get(id))
    timers.delete(id)
}

export const toast = {
    success: (title, message, duration) => push('success', title, message, duration),
    error: (title, message, duration) => push('error', title, message, duration),
    warn: (title, message, duration) => push('warn', title, message, duration),
    info: (title, message, duration) => push('info', title, message, duration)
}

/**
 * Promise 版确认弹窗。
 *
 * @param {{ title?: string, message?: string, tone?: string, confirmText?: string, cancelText?: string|null }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
    title = '确认操作',
    message = '',
    tone = 'warn',
    confirmText = '确定',
    cancelText = '取消'
} = {}) {
    if (feedback.dialog) {
        feedback.dialog.resolve(false)
    }
    return new Promise((resolve) => {
        feedback.dialog = {
            title,
            message,
            tone,
            confirmText,
            cancelText,
            resolve
        }
    })
}

export function settleDialog(value) {
    const dialog = feedback.dialog
    feedback.dialog = null
    dialog?.resolve(value)
}
