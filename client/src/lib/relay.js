import { apiUrl } from '../config'

/**
 * 通过服务器中继上传文件。用于 P2P 打不通时的兜底。
 *
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<{ url: string, name: string, size: number }>}
 */
export function uploadRelay(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', apiUrl('/api/relay'))
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
        xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream')

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && onProgress) {
                onProgress(Math.round((event.loaded / event.total) * 100))
            }
        }
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const data = JSON.parse(xhr.responseText)
                    const base = apiUrl('/')
                    resolve({
                        ...data,
                        absoluteUrl: new URL(
                            data.url,
                            base.startsWith('http') ? base : window.location.origin
                        ).href
                    })
                } catch {
                    reject(new Error('中继返回格式错误'))
                }
            } else {
                let message = `上传失败 (${xhr.status})`
                try {
                    message = JSON.parse(xhr.responseText).error || message
                } catch {
                    // ignore
                }
                reject(new Error(message))
            }
        }
        xhr.onerror = () => reject(new Error('中继上传失败'))
        xhr.onabort = () => reject(new Error('中继上传已取消'))
        xhr.send(file)
    })
}
