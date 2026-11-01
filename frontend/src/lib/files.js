export function isImage(file) {
    return Boolean(file?.type && file.type.startsWith('image/'))
}

export function wrapFile(file, path = '') {
    return {
        file,
        path: path || file.webkitRelativePath || file.name
    }
}

export function filesFromInput(input) {
    return [...(input?.files || [])].map((file) => wrapFile(file))
}

async function walkEntry(entry, prefix, output, depth = 0) {
    if (!entry || depth > 8 || output.length > 500) return
    if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
        output.push(wrapFile(file, prefix ? `${prefix}/${file.name}` : file.name))
        return
    }
    if (entry.isDirectory) {
        const reader = entry.createReader()
        const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject))
        let entries = await readBatch()
        while (entries.length) {
            for (const child of entries) {
                await walkEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name, output, depth + 1)
            }
            entries = await readBatch()
        }
    }
}

/**
 * 把拖拽内容（含文件夹）递归展开为 File 列表。
 *
 * @param {DataTransfer} dataTransfer
 */
export async function collectFiles(dataTransfer) {
    const items = dataTransfer?.items ? [...dataTransfer.items] : []
    const entries = items
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean)

    if (!entries.length) {
        return [...(dataTransfer?.files || [])].map((file) => wrapFile(file))
    }

    const output = []
    for (const entry of entries) {
        await walkEntry(entry, '', output)
    }
    return output
}

export function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}

/**
 * 压缩图片到适合 DataChannel/IndexedDB 的大小。
 *
 * @param {File} file
 * @param {{ maxSize?: number, quality?: number }} [options]
 */
export async function compressImage(file, { maxSize = 1600, quality = 0.82 } = {}) {
    let bitmap
    try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
        bitmap = await createImageBitmap(file)
    }

    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    let currentQuality = quality
    let dataUrl = canvas.toDataURL('image/jpeg', currentQuality)
    while (dataUrl.length > 900_000 && currentQuality > 0.4) {
        currentQuality -= 0.12
        dataUrl = canvas.toDataURL('image/jpeg', currentQuality)
    }
    return { dataUrl, width, height }
}

export function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name || 'download'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // 大文件下载可能持续很久，不能立即回收 object URL
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function extensionOf(name = '') {
    const match = String(name).match(/\.([a-z0-9]+)$/i)
    return (match?.[1] || '').toLowerCase()
}

export function fileKind(file) {
    const ext = extensionOf(file.name)
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
    if (['mp4', 'mov', 'mkv', 'webm'].includes(ext)) return 'video'
    if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return 'audio'
    if (['pdf'].includes(ext)) return 'pdf'
    if (['js', 'ts', 'json', 'css', 'html', 'md', 'py', 'go', 'rs'].includes(ext)) return 'code'
    return 'file'
}
