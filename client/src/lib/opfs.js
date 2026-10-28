/**
 * OPFS（Origin Private File System）接收缓存。
 *
 * 接收到的分片直接写入浏览器私有文件系统，JS 堆里不再保留整份文件。
 * 下载/另存为时再从 OPFS 以流的方式读出。
 */

const ROOT_DIR = 'etransfer-incoming'

let rootPromise = null
let supportCache

function safeSegment(value) {
    return String(value || 'unknown')
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .slice(0, 96)
}

export function supportsOpfs() {
    if (supportCache !== undefined) return supportCache
    supportCache = Boolean(
        window.isSecureContext
        && navigator.storage?.getDirectory
        && typeof window.FileSystemFileHandle !== 'undefined'
        && typeof window.FileSystemFileHandle.prototype.createWritable === 'function'
    )
    return supportCache
}

async function getRoot() {
    if (!rootPromise) {
        rootPromise = navigator.storage.getDirectory()
    }
    return rootPromise
}

async function getIncomingRoot({ create = true } = {}) {
    const root = await getRoot()
    return root.getDirectoryHandle(ROOT_DIR, { create })
}

async function getRoomDir(roomId, { create = true } = {}) {
    const incoming = await getIncomingRoot({ create })
    return incoming.getDirectoryHandle(safeSegment(roomId), { create })
}

/**
 * @param {string} roomId
 * @param {string} fileId
 * @returns {Promise<{ path: string, write: Function, close: Function, abort: Function, getFile: Function }>}
 */
export async function createIncomingWriter(roomId, fileId) {
    const roomDir = await getRoomDir(roomId, { create: true })
    const name = `${safeSegment(fileId)}.bin`
    const handle = await roomDir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    let settled = false

    return {
        path: `${safeSegment(roomId)}/${name}`,
        async write(chunk) {
            if (settled) throw new Error('接收文件已结束')
            await writable.write(chunk)
        },
        async close() {
            if (settled) return
            settled = true
            await writable.close()
        },
        async abort() {
            if (settled) return
            settled = true
            try {
                await writable.abort()
            } catch {
                // ignore
            }
            await removeIncomingFile(`${safeSegment(roomId)}/${name}`).catch(() => {})
        },
        async getFile() {
            return handle.getFile()
        }
    }
}

/**
 * @param {string} path `${roomId}/${fileId}.bin`
 * @returns {Promise<File>}
 */
export async function getIncomingFile(path) {
    const segments = String(path || '').split('/').filter(Boolean)
    if (!segments.length) throw new Error('接收文件路径为空')
    let dir = await getIncomingRoot({ create: false })
    for (let index = 0; index < segments.length - 1; index += 1) {
        dir = await dir.getDirectoryHandle(segments[index])
    }
    const handle = await dir.getFileHandle(segments[segments.length - 1])
    return handle.getFile()
}

export async function removeIncomingFile(path) {
    const segments = String(path || '').split('/').filter(Boolean)
    if (!segments.length) return
    let dir = await getIncomingRoot({ create: false })
    for (let index = 0; index < segments.length - 1; index += 1) {
        dir = await dir.getDirectoryHandle(segments[index])
    }
    await dir.removeEntry(segments[segments.length - 1])
}

/**
 * 清理长时间未访问的接收缓存，避免占满配额。
 *
 * @param {{ maxAgeMs?: number }} [options]
 */
export async function cleanupIncoming({ maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    if (!supportsOpfs()) return 0
    const now = Date.now()
    let removed = 0
    try {
        const incoming = await getIncomingRoot({ create: false })
        for await (const [roomName, roomHandle] of incoming.entries()) {
            if (roomHandle.kind !== 'directory') continue
            let hasFiles = false
            for await (const [fileName, fileHandle] of roomHandle.entries()) {
                if (fileHandle.kind !== 'file') continue
                hasFiles = true
                try {
                    const file = await fileHandle.getFile()
                    if (now - file.lastModified > maxAgeMs) {
                        await roomHandle.removeEntry(fileName)
                        removed += 1
                    }
                } catch {
                    // 单个文件失败不影响其它
                }
            }
            if (!hasFiles) {
                await incoming.removeEntry(roomName).catch(() => {})
            }
        }
    } catch {
        // 没有缓存目录时忽略
    }
    return removed
}
