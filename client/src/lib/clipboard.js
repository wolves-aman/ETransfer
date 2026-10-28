export async function copyText(text) {
    const value = String(text ?? '')
    if (!value) return false

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value)
            return true
        }
    } catch {
        // 继续尝试降级方案
    }

    try {
        const textarea = document.createElement('textarea')
        textarea.value = value
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        textarea.style.pointerEvents = 'none'
        document.body.appendChild(textarea)
        textarea.select()
        const ok = document.execCommand('copy')
        textarea.remove()
        return ok
    } catch {
        return false
    }
}
