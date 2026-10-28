import { getIncomingFile } from './opfs'
import { downloadBlob } from './files'

/**
 * 保存接收端文件。
 *
 * - 有 OPFS 缓存：优先 File System Access API 直接流式写盘；
 * - 不支持时退回 <a download>，但数据仍由 OPFS 文件支撑，不进入 JS 堆。
 * - 旧的内存 Blob 消息仍然可用。
 *
 * @param {{ name: string, blob?: Blob, opfsPath?: string, size?: number }} file
 * @param {{ preferPicker?: boolean }} [options]
 * @returns {Promise<'picker' | 'download'>}
 */
export async function saveReceivedFile(file, { preferPicker = true } = {}) {
    if (file.blob) {
        downloadBlob(file.blob, file.name)
        return 'download'
    }
    if (!file.opfsPath) {
        throw new Error('文件尚未接收完成')
    }

    // 必须在用户手势的同一个任务里立刻调用 picker，
    // 不能先 await 读取 OPFS，否则可能丢失 transient activation。
    let handle = null
    if (preferPicker && typeof window.showSaveFilePicker === 'function') {
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: file.name || 'download'
            })
        } catch (error) {
            if (error.name === 'AbortError') {
                throw error
            }
            // 权限/浏览器限制时退回普通下载
        }
    }

    const source = await getIncomingFile(file.opfsPath)

    if (handle) {
        const writable = await handle.createWritable()
        await source.stream().pipeTo(writable)
        return 'picker'
    }

    downloadBlob(source, file.name)
    return 'download'
}
