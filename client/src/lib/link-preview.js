import { apiUrl } from '../config'

const cache = new Map()
const pending = new Map()

/**
 * @param {string} url
 * @returns {Promise<object | null>}
 */
export async function getLinkPreview(url) {
    if (!url) return null
    if (cache.has(url)) return cache.get(url)
    if (pending.has(url)) return pending.get(url)

    const task = (async () => {
        try {
            const response = await fetch(
                `${apiUrl('/api/link-preview')}?url=${encodeURIComponent(url)}`,
                { signal: AbortSignal.timeout(7000) }
            )
            if (!response.ok) return null
            const data = await response.json()
            if (!data?.title && !data?.description) return null
            cache.set(url, data)
            return data
        } catch {
            return null
        } finally {
            pending.delete(url)
        }
    })()

    pending.set(url, task)
    return task
}
