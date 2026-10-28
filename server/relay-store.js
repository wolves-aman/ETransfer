import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { nanoid } from 'nanoid'

export class RelayError extends Error {
    constructor(message, code = 'RELAY_ERROR') {
        super(message)
        this.name = 'RelayError'
        this.code = code
    }
}

/**
 * 本机磁盘中继存储。
 *
 * 接口刻意做成“put/get/sweep”三个方法，后续要换成 S3 / OSS / R2，
 * 只需要替换这个类，不需要改 HTTP 层或前端。
 */
export class RelayStore {
    constructor({ dir, maxBytes, ttlMs }) {
        this.dir = dir
        this.maxBytes = maxBytes
        this.ttlMs = ttlMs
        this.ready = this.init()
    }

    async init() {
        await mkdir(this.dir, { recursive: true })
    }

    filePath(id) {
        return path.join(this.dir, id)
    }

    metaPath(id) {
        return path.join(this.dir, `${id}.json`)
    }

    /**
     * @param {import('node:stream').Readable} stream
     * @param {{ name: string, type?: string }} meta
     */
    async put(stream, { name, type }) {
        await this.ready
        const id = nanoid(21)
        const tempPath = path.join(this.dir, `${id}.part`)
        let written = 0
        const maxBytes = this.maxBytes

        const limiter = new Transform({
            transform(chunk, encoding, callback) {
                written += chunk.length
                if (written > maxBytes) {
                    callback(new RelayError('文件超过中继大小限制', 'RELAY_TOO_LARGE'))
                    return
                }
                callback(null, chunk)
            }
        })

        try {
            await pipeline(stream, limiter, createWriteStream(tempPath))
            await rename(tempPath, this.filePath(id))
            const meta = {
                id,
                name: String(name || 'file').slice(0, 200),
                type: String(type || 'application/octet-stream').slice(0, 120),
                size: written,
                created_at: Date.now(),
                expires_at: Date.now() + this.ttlMs
            }
            await writeFile(this.metaPath(id), JSON.stringify(meta), 'utf8')
            return meta
        } catch (error) {
            await unlink(tempPath).catch(() => {})
            throw error
        }
    }

    async get(id) {
        if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) {
            return null
        }
        try {
            const meta = JSON.parse(await readFile(this.metaPath(id), 'utf8'))
            if (meta.expires_at <= Date.now()) {
                await this.remove(id)
                return null
            }
            const info = await stat(this.filePath(id))
            return { meta, size: info.size, path: this.filePath(id) }
        } catch {
            return null
        }
    }

    async remove(id) {
        await unlink(this.filePath(id)).catch(() => {})
        await unlink(this.metaPath(id)).catch(() => {})
    }

    async sweep(now = Date.now()) {
        await this.ready
        const entries = await readdir(this.dir).catch(() => [])
        let removed = 0
        for (const entry of entries) {
            if (!entry.endsWith('.json')) {
                continue
            }
            try {
                const meta = JSON.parse(await readFile(path.join(this.dir, entry), 'utf8'))
                if (meta.expires_at <= now) {
                    await this.remove(meta.id)
                    removed += 1
                }
            } catch {
                // 坏掉 sidecar 直接忽略
            }
        }
        return removed
    }
}
