import { reactive } from 'vue'
import { nanoid } from 'nanoid'
import { runtime } from '../config'
import { log } from './logger'
import { createIncomingWriter, supportsOpfs } from './opfs'

/**
 * 多对多文件传输管理器。
 *
 * 发送端：流式读取 64KB 分片，受 DataChannel bufferedAmount 和接收端确认窗口双重背压。
 * 接收端：优先把分片直接写入 OPFS；不支持 OPFS 时才退回内存聚合，并限制文件大小。
 */
export class TransferManager {
    constructor({
        mesh,
        onOutgoing,
        onIncoming,
        onIncomingUpdate,
        onIncomingComplete,
        onIncomingRejected,
        onIncomingError,
        onItemUpdate
    }) {
        this.mesh = mesh
        this.onOutgoing = onOutgoing
        this.onIncoming = onIncoming
        this.onIncomingUpdate = onIncomingUpdate
        this.onIncomingComplete = onIncomingComplete
        this.onIncomingRejected = onIncomingRejected
        this.onIncomingError = onIncomingError
        this.onItemUpdate = onItemUpdate
        this.items = reactive([])
        this.incoming = new Map()
        this.pendingChannels = new Map()
        this.sampleAt = Date.now()
        this.sampleBytes = 0
        this.speedTimer = setInterval(() => this.tick(), 500)
    }

    enqueue(files) {
        const created = []
        for (const wrapper of files) {
            const item = reactive({
                id: nanoid(12),
                file: wrapper.file,
                name: wrapper.file.name,
                path: wrapper.path || wrapper.file.name,
                size: wrapper.file.size,
                mime: wrapper.file.type || 'application/octet-stream',
                status: 'queued',
                progress: 0,
                sentBytes: 0,
                speed: 0,
                eta: null,
                error: '',
                parts: [],
                relay: null,
                _resume: null,
                _resumeWaiters: [],
                _closed: false
            })
            this.items.push(item)
            created.push(item)
        }
        if (created.length) {
            log.info('transfer', '加入传输队列', { count: created.length })
            this.pump()
        }
        return created
    }

    activeItem() {
        return this.items.find((item) => ['active', 'paused'].includes(item.status)) || null
    }

    async pump() {
        if (this.activeItem()) return
        const next = this.items.find((item) => item.status === 'queued')
        if (next) {
            await this.start(next)
        }
    }

    async start(item) {
        const peers = this.mesh.connectedPeers()
        if (!peers.length) {
            item.status = 'error'
            item.error = '没有已连接的对端'
            this.onItemUpdate?.(item)
            setTimeout(() => this.pump(), 80)
            return
        }

        item.status = 'active'
        item.startedAt = Date.now()
        item.parts = peers.map((peer) => ({
            peerId: peer.id,
            name: peer.name,
            sent: 0,
            acked: 0,
            status: 'connecting',
            channel: null
        }))
        this.onOutgoing?.(item)
        log.info('transfer', '开始发送文件', {
            file: item.name,
            size: item.size,
            peers: peers.length
        })

        for (const part of item.parts) {
            this.mesh.sendChat(part.peerId, {
                kind: 'file-offer',
                fileId: item.id,
                name: item.name,
                path: item.path,
                size: item.size,
                mime: item.mime
            })

            const channel = this.mesh.createFileChannel(part.peerId, item.id)
            if (!channel) {
                part.status = 'error'
                continue
            }
            part.channel = channel
            channel.bufferedAmountLowThreshold = runtime.lowWaterMark
            channel.onopen = () => {
                part.status = 'sending'
                this.sendPart(item, part).catch((error) => {
                    this.failPart(item, part, error)
                })
            }
            channel.onerror = () => this.failPart(item, part, new Error('数据通道错误'))
            channel.onclose = () => {
                if (part.status === 'sending' || part.status === 'connecting') {
                    this.failPart(item, part, new Error('数据通道已关闭'))
                }
            }
        }

        setTimeout(() => {
            for (const part of item.parts) {
                if (part.status === 'connecting') {
                    this.failPart(item, part, new Error('建立文件通道超时'))
                }
            }
        }, 15_000)
    }

    async sendPart(item, part) {
        const channel = part.channel
        if (!channel) return
        const file = item.file
        let offset = part.sent

        while (offset < file.size) {
            if (item.status === 'canceled' || part.status === 'error') return
            await this.waitWhilePaused(item)
            if (item.status === 'canceled' || part.status === 'error') return

            if (channel.readyState !== 'open') {
                throw new Error('数据通道已关闭')
            }
            if (channel.bufferedAmount > runtime.highWaterMark) {
                await new Promise((resolve) => {
                    const done = () => {
                        channel.removeEventListener('bufferedamountlow', done)
                        channel.removeEventListener('close', done)
                        resolve()
                    }
                    channel.addEventListener('bufferedamountlow', done)
                    channel.addEventListener('close', done)
                })
                continue
            }

            if (part.sent - part.acked > runtime.receiveWindow) {
                await this.waitForWindow(item, part)
            }

            const chunk = await file.slice(offset, offset + runtime.chunkSize).arrayBuffer()
            channel.send(chunk)
            offset += chunk.byteLength
            part.sent = offset
            this.recompute(item)
        }

        part.status = 'waiting-ack'
        this.mesh.sendChat(part.peerId, { kind: 'file-complete', fileId: item.id })
        log.info('transfer', '分片发送完毕，等待对端确认', { file: item.name, peer: part.name })
        clearTimeout(part._ackTimer)
        part._ackTimer = setTimeout(() => {
            if (part.status === 'waiting-ack') {
                log.warn('transfer', '等待确认超时，按完成处理', { file: item.name, peer: part.name })
                this.completePart(item, part)
            }
        }, 5000)
    }

    /**
     * 接收端把分片写入 OPFS 的进度确认；超过窗口就暂停读取发送端文件。
     *
     * @param {object} item
     * @param {object} part
     */
    async waitForWindow(item, part) {
        const deadline = Date.now() + 30_000
        while (part.sent - part.acked > runtime.receiveWindow) {
            if (item.status === 'canceled' || part.status === 'error') {
                throw new Error('传输已取消')
            }
            if (Date.now() > deadline) {
                throw new Error('接收端确认超时')
            }
            await new Promise((resolve) => setTimeout(resolve, 80))
        }
    }

    completePart(item, part) {
        if (!part || part.status === 'done' || part.status === 'error') return
        clearTimeout(part._ackTimer)
        try {
            part.channel?.close()
        } catch {
            // ignore
        }
        part.status = 'done'
        log.info('transfer', '对端已确认接收', { file: item.name, peer: part.name })
        this.settle(item)
    }

    async waitWhilePaused(item) {
        if (item.status !== 'paused') return
        await new Promise((resolve) => {
            item._resumeWaiters.push(resolve)
        })
    }

    pause(item) {
        if (item.status !== 'active') return
        item.status = 'paused'
        log.info('transfer', '暂停传输', { file: item.name })
        this.onItemUpdate?.(item)
    }

    resume(item) {
        if (item.status !== 'paused') return
        item.status = 'active'
        const waiters = item._resumeWaiters.splice(0)
        waiters.forEach((resolve) => resolve())
        item._resume = null
        log.info('transfer', '继续传输', { file: item.name })
        this.onItemUpdate?.(item)
    }

    cancel(item) {
        if (['done', 'canceled', 'error', 'relayed'].includes(item.status)) return
        item.status = 'canceled'
        const waiters = item._resumeWaiters.splice(0)
        waiters.forEach((resolve) => resolve())
        item._resume = null
        for (const part of item.parts) {
            clearTimeout(part._ackTimer)
            try {
                part.channel?.close()
            } catch {
                // ignore
            }
            this.mesh.sendChat(part.peerId, { kind: 'file-cancel', fileId: item.id, name: item.name })
        }
        log.warn('transfer', '取消传输', { file: item.name })
        this.onItemUpdate?.(item)
        setTimeout(() => this.pump(), 50)
    }

    failPart(item, part, error) {
        if (part.status === 'error' || part.status === 'done') return
        part.status = 'error'
        log.warn('transfer', '发送分片失败', {
            file: item.name,
            peer: part.name,
            error: error.message
        })
        this.mesh.sendChat(part.peerId, {
            kind: 'file-cancel',
            fileId: item.id,
            reason: error.message
        })
        try {
            part.channel?.close()
        } catch {
            // ignore
        }
        this.settle(item)
    }

    settle(item) {
        const active = item.parts.filter((part) => ['connecting', 'sending'].includes(part.status))
        if (active.length) return
        const failed = item.parts.filter((part) => part.status === 'error')
        item.status = failed.length ? 'error' : 'done'
        item.error = failed.length ? '部分对端传输失败' : ''
        item.eta = 0
        item.speed = 0
        item.progress = failed.length ? item.progress : 100
        log.info('transfer', failed.length ? '传输结束（有失败）' : '文件传输完成', {
            file: item.name
        })
        this.onItemUpdate?.(item)
        setTimeout(() => this.pump(), 120)
    }

    recompute(item) {
        const total = item.size * Math.max(item.parts.length, 1)
        const sent = item.parts.reduce((sum, part) => sum + part.sent, 0)
        item.sentBytes = sent
        item.progress = total ? Math.min(99, Math.round((sent / total) * 100)) : 0
        item.eta = item.speed > 0 ? Math.max(0, (total - sent) / item.speed) : null
        this.onItemUpdate?.(item)
    }

    tick() {
        const now = Date.now()
        const delta = now - this.sampleAt
        if (delta < 300) return
        let changed = false
        for (const item of this.items) {
            if (item.status !== 'active') continue
            const sent = item.parts.reduce((sum, part) => sum + part.sent, 0)
            const bytes = sent - (item._lastSent || 0)
            item.speed = Math.max(0, (bytes * 1000) / delta)
            item._lastSent = sent
            const total = item.size * Math.max(item.parts.length, 1)
            item.eta = item.speed > 0 ? Math.max(0, (total - sent) / item.speed) : null
            changed = true
        }
        this.sampleAt = now
        if (changed) this.onItemUpdate?.(this.activeItem())
    }

    /* -------------------- 接收端 -------------------- */

    handleControl(peerId, payload) {
        if (!payload?.fileId) return
        if (payload.kind === 'file-offer') {
            this.receiveOffer(peerId, payload)
        } else if (payload.kind === 'file-complete') {
            this.finishIncoming(peerId, payload.fileId)
        } else if (payload.kind === 'file-progress') {
            const item = this.items.find((entry) => entry.id === payload.fileId)
            const part = item?.parts.find((entry) => entry.peerId === peerId)
            if (part && Number.isFinite(payload.received)) {
                part.acked = Math.max(part.acked, payload.received)
            }
        } else if (payload.kind === 'file-reject') {
            const item = this.items.find((entry) => entry.id === payload.fileId)
            const part = item?.parts.find((entry) => entry.peerId === peerId)
            if (item && part) {
                this.failPart(item, part, new Error(
                    payload.reason === 'too-large'
                        ? '对端无法接收超大文件'
                        : (payload.reason || '对端拒绝接收')
                ))
            }
        } else if (payload.kind === 'file-ack') {
            const item = this.items.find((entry) => entry.id === payload.fileId)
            const part = item?.parts.find((entry) => entry.peerId === peerId)
            if (item && part) {
                this.completePart(item, part)
            }
        } else if (payload.kind === 'file-cancel') {
            const item = this.items.find((entry) => entry.id === payload.fileId)
            const part = item?.parts.find((entry) => entry.peerId === peerId)
            if (item && part && !['done', 'error'].includes(part.status)) {
                this.failPart(item, part, new Error('对端取消接收'))
            } else {
                this.cancelIncoming(peerId, payload.fileId)
            }
        }
    }

    receiveOffer(peerId, meta) {
        const key = `${peerId}:${meta.fileId}`
        if (this.incoming.has(key)) return

        const useOpfs = supportsOpfs()
        if (!useOpfs && meta.size > runtime.maxMemoryReceiveBytes) {
            this.mesh.sendChat(peerId, {
                kind: 'file-reject',
                fileId: meta.fileId,
                reason: 'too-large'
            })
            log.warn('transfer', '本机不支持 OPFS，拒绝超大文件', {
                file: meta.name,
                size: meta.size
            })
            this.onIncomingRejected?.(peerId, meta, 'too-large')
            return
        }

        const message = this.onIncoming?.(peerId, meta)
        if (!message) return
        const entry = {
            key,
            peerId,
            fileId: meta.fileId,
            message,
            useOpfs,
            chunks: [],
            writerPromise: null,
            writeQueue: Promise.resolve(),
            written: 0,
            received: 0,
            lastProgressAt: 0,
            lastProgressSent: 0,
            pendingComplete: false,
            finalizing: false,
            failed: false,
            complete: false,
            channel: null
        }
        if (useOpfs) {
            entry.writerPromise = createIncomingWriter(message.roomId || 'room', meta.fileId)
            entry.writerPromise.catch((error) => this.failIncoming(entry, error))
        }
        this.incoming.set(key, entry)
        const pending = this.pendingChannels.get(key)
        if (pending) {
            this.pendingChannels.delete(key)
            this.attachIncomingChannel(entry, pending)
        }
        log.info('transfer', '收到文件传输请求', {
            file: meta.name,
            size: meta.size,
            storage: useOpfs ? 'opfs' : 'memory'
        })
    }

    handleFileChannel(peerId, channel, fileId) {
        const key = `${peerId}:${fileId}`
        const entry = this.incoming.get(key)
        if (entry) {
            this.attachIncomingChannel(entry, channel)
            return
        }
        this.pendingChannels.set(key, channel)
    }

    attachIncomingChannel(entry, channel) {
        entry.channel = channel
        channel.binaryType = 'arraybuffer'
        log.info('transfer', '文件通道已连接', {
            file: entry.message.file.name,
            label: channel.label
        })
        channel.onmessage = (event) => {
            if (entry.complete || entry.failed) return
            if (!(event.data instanceof ArrayBuffer)) {
                log.warn('transfer', '收到非二进制分片', {
                    type: Object.prototype.toString.call(event.data)
                })
                return
            }
            const chunk = event.data
            entry.received += chunk.byteLength
            entry.message.file.received = entry.received

            if (entry.useOpfs) {
                entry.writeQueue = entry.writeQueue
                    .then(async () => {
                        if (entry.failed || entry.complete) return
                        const writer = await entry.writerPromise
                        if (entry.failed || entry.complete) return
                        await writer.write(chunk)
                        entry.written += chunk.byteLength
                        this.maybeSendProgress(entry)
                    })
                    .catch((error) => this.failIncoming(entry, error))
            } else {
                entry.chunks.push(chunk)
                entry.written = entry.received
                this.maybeSendProgress(entry)
            }

            this.onIncomingUpdate?.(entry.message, false)
            if (entry.pendingComplete && entry.received >= entry.message.file.size) {
                this.finalizeIncoming(entry)
            }
        }
        channel.onopen = () => {
            log.info('transfer', '文件通道打开', { file: entry.message.file.name })
        }
        channel.onclose = () => {
            log.warn('transfer', '文件通道关闭', {
                file: entry.message.file.name,
                received: entry.received
            })
            if (entry.pendingComplete && entry.received >= entry.message.file.size) {
                this.finalizeIncoming(entry)
            } else if (!entry.complete && !entry.failed && entry.received > 0) {
                this.failIncoming(entry, new Error('接收通道提前关闭'))
            }
        }
    }

    maybeSendProgress(entry) {
        const now = Date.now()
        if (entry.written - entry.lastProgressSent < 1024 * 1024 && now - entry.lastProgressAt < 500) {
            return
        }
        entry.lastProgressAt = now
        entry.lastProgressSent = entry.written
        this.mesh.sendChat(entry.peerId, {
            kind: 'file-progress',
            fileId: entry.fileId,
            received: entry.written
        })
    }

    finishIncoming(peerId, fileId) {
        const key = `${peerId}:${fileId}`
        const entry = this.incoming.get(key)
        if (!entry || entry.complete) return
        entry.pendingComplete = true
        if (entry.received >= entry.message.file.size) {
            this.finalizeIncoming(entry)
        }
    }

    async finalizeIncoming(entry) {
        if (!entry || entry.complete || entry.finalizing || entry.failed) return
        entry.finalizing = true
        const file = entry.message.file
        try {
            await entry.writeQueue
            if (entry.failed) return
            if (entry.received < file.size) return

            if (entry.useOpfs) {
                const writer = await entry.writerPromise
                await writer.close()
                file.opfsPath = writer.path
                file.blob = null
            } else {
                file.blob = new Blob(entry.chunks, {
                    type: file.mime || 'application/octet-stream'
                })
                entry.chunks = []
            }

            entry.complete = true
            file.received = entry.received
            file.complete = true
            file.error = ''
            this.mesh.sendChat(entry.peerId, { kind: 'file-ack', fileId: entry.fileId })
            this.onIncomingComplete?.(entry.message)
            this.incoming.delete(entry.key)
            try {
                entry.channel?.close()
            } catch {
                // ignore
            }
            log.info('transfer', '文件接收完成', {
                file: file.name,
                size: file.size,
                storage: entry.useOpfs ? 'opfs' : 'memory'
            })
        } catch (error) {
            this.failIncoming(entry, error)
        } finally {
            entry.finalizing = false
        }
    }

    failIncoming(entry, error) {
        if (!entry || entry.complete || entry.failed) return
        entry.failed = true
        const file = entry.message.file
        file.error = error.message
        file.complete = false
        this.onIncomingUpdate?.(entry.message, false)
        this.onIncomingError?.(entry.message, error)
        this.mesh.sendChat(entry.peerId, {
            kind: 'file-cancel',
            fileId: entry.fileId,
            reason: 'receive-failed'
        })
        if (entry.writerPromise) {
            entry.writerPromise
                .then((writer) => writer.abort())
                .catch(() => {})
        }
        this.incoming.delete(entry.key)
        try {
            entry.channel?.close()
        } catch {
            // ignore
        }
        log.warn('transfer', '接收文件失败', {
            file: file.name,
            error: error.message
        })
    }

    cancelIncoming(peerId, fileId) {
        const key = `${peerId}:${fileId}`
        const entry = this.incoming.get(key)
        if (!entry) return
        entry.failed = true
        entry.message.file.canceled = true
        this.onIncomingUpdate?.(entry.message, true)
        this.incoming.delete(key)
        if (entry.writerPromise) {
            entry.writerPromise
                .then((writer) => writer.abort())
                .catch(() => {})
        }
        try {
            entry.channel?.close()
        } catch {
            // ignore
        }
        log.warn('transfer', '对端取消传输', { file: entry.message.file.name })
    }

    clear() {
        for (const item of this.items) {
            if (['active', 'paused'].includes(item.status)) {
                this.cancel(item)
            }
        }
        for (const entry of this.incoming.values()) {
            entry.failed = true
            if (entry.writerPromise) {
                entry.writerPromise
                    .then((writer) => writer.abort())
                    .catch(() => {})
            }
            try {
                entry.channel?.close()
            } catch {
                // ignore
            }
        }
        this.incoming.clear()
        this.pendingChannels.clear()
    }

    destroy() {
        clearInterval(this.speedTimer)
        this.clear()
    }
}
