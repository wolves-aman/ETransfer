import { toRaw } from 'vue'
import { idbGetAll, idbPut } from './idb'

function plainMessage(message) {
    const raw = toRaw(message)
    const value = {
        id: raw.id,
        roomId: raw.roomId,
        from: raw.from,
        fromName: raw.fromName,
        type: raw.type,
        text: raw.text || '',
        ts: raw.ts,
        revoked: Boolean(raw.revoked),
        image: raw.image || '',
        preview: raw.preview ? { ...toRaw(raw.preview) } : null
    }
    if (raw.file) {
        const file = toRaw(raw.file)
        value.file = {
            name: file.name,
            size: file.size,
            mime: file.mime,
            received: file.received,
            complete: Boolean(file.complete),
            canceled: Boolean(file.canceled),
            blob: file.blob || null,
            opfsPath: file.opfsPath || '',
            error: file.error || '',
            transferId: file.transferId || '',
            fromPeer: file.fromPeer || '',
            path: file.path || ''
        }
    }
    return value
}

export async function loadRoomMessages(roomId) {
    const rows = await idbGetAll('messages')
    return rows
        .filter((row) => row.roomId === roomId)
        .sort((a, b) => a.ts - b.ts)
}

export function saveMessage(message) {
    return idbPut('messages', plainMessage(message))
}

export function updateMessage(message) {
    return saveMessage(message)
}

export async function clearRoomMessages(roomId) {
    const rows = await idbGetAll('messages')
    await Promise.all(
        rows
            .filter((row) => row.roomId === roomId)
            .map((row) => idbPut('messages', { ...row, revoked: true, text: '', file: null, image: '' }))
    )
}
