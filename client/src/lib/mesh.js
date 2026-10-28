import { log } from './logger'

/**
 * WebRTC mesh：每个成员与其他成员建立一条 RTCPeerConnection。
 * 使用 perfect negotiation 处理双方同时 renegotiate 的冲突。
 */
export class Mesh {
    constructor({ iceServers, onSignal, onChat, onFileChannel, onPeer, onStream, onScreenStream }) {
        this.iceServers = iceServers || []
        this.onSignal = onSignal
        this.onChat = onChat
        this.onFileChannel = onFileChannel
        this.onPeer = onPeer
        this.onStream = onStream
        this.onScreenStream = onScreenStream
        this.peers = new Map()
        this.localTracks = new Map()
    }

    get localStream() {
        const stream = new MediaStream()
        for (const track of this.localTracks.keys()) {
            stream.addTrack(track)
        }
        return stream
    }

    getPeer(id) {
        return this.peers.get(id) || null
    }

    getPeers() {
        return [...this.peers.values()]
    }

    connectedPeers() {
        return [...this.peers.values()].filter((peer) => peer.chat?.readyState === 'open')
    }

    snapshot(peer) {
        return {
            id: peer.id,
            name: peer.name || '成员',
            isHost: Boolean(peer.isHost),
            connected: Boolean(peer.connected),
            state: peer.pc?.connectionState || 'new',
            stream: peer.stream,
            chatReady: peer.chat?.readyState === 'open'
        }
    }

    emitPeer(peer) {
        this.onPeer?.(this.snapshot(peer))
    }

    ensurePeer(info, { polite = true, initiator = false } = {}) {
        const existing = this.peers.get(info.id)
        if (existing) {
            if (info.name) existing.name = info.name
            if (info.is_host !== undefined) existing.isHost = Boolean(info.is_host)
            this.emitPeer(existing)
            return existing
        }

        const pc = new RTCPeerConnection({ iceServers: this.iceServers })
        const peer = {
            id: info.id,
            name: info.name || '成员',
            isHost: Boolean(info.is_host),
            pc,
            polite,
            initiator,
            makingOffer: false,
            ignoreOffer: false,
            tracksAdded: false,
            suppressNegotiation: false,
            chat: null,
            channels: new Map(),
            candidates: [],
            stream: new MediaStream(),
            remoteStreams: new Map(),
            screenStreamId: '',
            screenStream: null,
            connected: false
        }
        this.peers.set(peer.id, peer)

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.onSignal?.(peer.id, 'candidate', { candidate: event.candidate })
            }
        }

        pc.onnegotiationneeded = () => {
            this.negotiate(peer)
        }

        pc.ontrack = (event) => {
            const stream = event.streams?.[0] || new MediaStream([event.track])
            peer.remoteStreams.set(stream.id, stream)

            if (peer.screenStreamId && stream.id === peer.screenStreamId) {
                peer.screenStream = stream
                this.onScreenStream?.(peer.id, stream)
                this.emitPeer(peer)
                log.info('rtc', '收到屏幕共享轨道', { peer: peer.name })
                return
            }

            for (const track of stream.getTracks()) {
                if (!peer.stream.getTracks().includes(track)) {
                    peer.stream.addTrack(track)
                }
            }
            event.track.addEventListener('ended', () => {
                if (peer.stream.getTracks().includes(event.track)) {
                    peer.stream.removeTrack(event.track)
                    this.onStream?.(peer.id, peer.stream)
                    this.emitPeer(peer)
                }
            })
            this.onStream?.(peer.id, peer.stream)
            this.emitPeer(peer)
            log.info('rtc', '收到远端媒体轨道', { peer: peer.name, kind: event.track.kind })
        }

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState
            peer.connected = state === 'connected'
            this.emitPeer(peer)
            log.info('rtc', '连接状态变化', { peer: peer.name, state })
        }

        pc.ondatachannel = (event) => {
            this.attachChannel(peer, event.channel)
        }

        this.emitPeer(peer)
        log.info('rtc', '创建 PeerConnection', { peer: peer.name, polite, initiator })
        return peer
    }

    connectTo(info) {
        if (this.peers.has(info.id)) {
            return this.peers.get(info.id)
        }
        const peer = this.ensurePeer(info, { polite: false, initiator: true })
        this.addLocalTracks(peer)
        const channel = peer.pc.createDataChannel('chat', { ordered: true })
        this.attachChannel(peer, channel)
        return peer
    }

    /**
     * @param {string} id
     * @param {{ name?: string, is_host?: boolean }} info
     */
    updatePeerInfo(id, info) {
        const peer = this.peers.get(id)
        if (!peer) return
        if (info.name) peer.name = info.name
        if (info.is_host !== undefined) peer.isHost = Boolean(info.is_host)
        this.emitPeer(peer)
    }

    /**
     * 对端通过聊天通道告知屏幕共享流 ID 后，把对应远端流标记为屏幕流。
     *
     * @param {string} peerId
     * @param {string} streamId
     */
    setScreenStreamId(peerId, streamId) {
        const peer = this.peers.get(peerId)
        if (!peer) return
        peer.screenStreamId = streamId
        const stream = peer.remoteStreams.get(streamId)
        if (!stream) return
        peer.screenStream = stream
        for (const track of stream.getTracks()) {
            if (peer.stream.getTracks().includes(track)) {
                peer.stream.removeTrack(track)
            }
        }
        this.onScreenStream?.(peerId, stream)
        this.emitPeer(peer)
        log.info('rtc', '绑定屏幕共享流', { peer: peer.name })
    }

    clearScreenStream(peerId) {
        const peer = this.peers.get(peerId)
        if (!peer) return
        peer.screenStreamId = ''
        peer.screenStream = null
        this.onScreenStream?.(peerId, null)
        this.emitPeer(peer)
    }

    attachChannel(peer, channel) {
        const label = channel.label || 'chat'
        peer.channels.set(label, channel)

        if (label === 'chat') {
            peer.chat = channel
            channel.onopen = () => {
                peer.connected = true
                this.emitPeer(peer)
                log.info('rtc', '数据通道已建立', { peer: peer.name })
            }
            channel.onclose = () => {
                peer.connected = false
                this.emitPeer(peer)
                log.warn('rtc', '数据通道已关闭', { peer: peer.name })
            }
            channel.onerror = () => {
                log.warn('rtc', '数据通道错误', { peer: peer.name })
            }
            channel.onmessage = (event) => {
                let message
                try {
                    message = JSON.parse(event.data)
                } catch {
                    return
                }
                this.onChat?.(peer.id, message)
            }
            return
        }

        if (label.startsWith('file:')) {
            channel.binaryType = 'arraybuffer'
            const fileId = label.slice(5)
            this.onFileChannel?.(peer.id, channel, fileId)
        }
    }

    async negotiate(peer) {
        if (peer.suppressNegotiation) {
            return
        }
        if (peer.makingOffer || peer.pc.signalingState !== 'stable') {
            return
        }
        try {
            peer.makingOffer = true
            await peer.pc.setLocalDescription()
            this.onSignal?.(peer.id, 'offer', { offer: peer.pc.localDescription })
            log.debug('rtc', '发送 offer', { peer: peer.name })
        } catch (error) {
            log.warn('rtc', '创建 offer 失败', { peer: peer.name, error: error.message })
        } finally {
            peer.makingOffer = false
        }
    }

    async handleSignal(from, data) {
        let peer = this.peers.get(from)
        if (!peer) {
            if (data.type === 'answer') return
            peer = this.ensurePeer({ id: from }, { polite: true })
        }

        try {
            if (data.type === 'candidate') {
                if (!data.candidate) return
                if (!peer.pc.remoteDescription) {
                    peer.candidates.push(data.candidate)
                } else {
                    await peer.pc.addIceCandidate(data.candidate).catch(() => {})
                }
                return
            }

            const description = data[data.type]
            if (!description) return

            const collision = data.type === 'offer'
                && (peer.makingOffer || peer.pc.signalingState !== 'stable')
            peer.ignoreOffer = !peer.polite && collision
            if (peer.ignoreOffer) {
                log.debug('rtc', '忽略冲突 offer', { peer: peer.name })
                return
            }

            if (collision) {
                await peer.pc.setLocalDescription({ type: 'rollback' })
            }

            if (data.type === 'offer' && !peer.tracksAdded) {
                peer.suppressNegotiation = true
                this.addLocalTracks(peer)
            }

            await peer.pc.setRemoteDescription(description)

            while (peer.candidates.length) {
                await peer.pc.addIceCandidate(peer.candidates.shift()).catch(() => {})
            }

            if (data.type === 'offer') {
                await peer.pc.setLocalDescription()
                this.onSignal?.(peer.id, 'answer', { answer: peer.pc.localDescription })
                peer.suppressNegotiation = false
                log.debug('rtc', '发送 answer', { peer: peer.name })
            }
            this.emitPeer(peer)
        } catch (error) {
            peer.suppressNegotiation = false
            log.warn('rtc', '处理信令失败', { peer: peer.name, type: data.type, error: error.message })
        }
    }

    addLocalTracks(peer) {
        if (peer.tracksAdded) return
        for (const [track, stream] of this.localTracks) {
            try {
                peer.pc.addTrack(track, stream)
            } catch {
                // 重复添加时忽略
            }
        }
        peer.tracksAdded = true
    }

    addTrack(track, stream) {
        if (this.localTracks.has(track)) return
        this.localTracks.set(track, stream || new MediaStream([track]))
        for (const peer of this.peers.values()) {
            if (peer.tracksAdded) {
                try {
                    peer.pc.addTrack(track, stream)
                } catch {
                    // ignore
                }
            }
        }
    }

    removeTrack(track) {
        this.localTracks.delete(track)
        for (const peer of this.peers.values()) {
            for (const sender of peer.pc.getSenders()) {
                if (sender.track === track) {
                    try {
                        peer.pc.removeTrack(sender)
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }

    sendChat(peerId, payload) {
        const peer = this.peers.get(peerId)
        if (!peer?.chat || peer.chat.readyState !== 'open') return false
        try {
            peer.chat.send(JSON.stringify(payload))
            return true
        } catch (error) {
            log.warn('rtc', '聊天消息发送失败', { peer: peer.name, error: error.message })
            return false
        }
    }

    broadcast(payload) {
        let delivered = 0
        for (const peer of this.peers.values()) {
            if (this.sendChat(peer.id, payload)) delivered += 1
        }
        return delivered
    }

    createFileChannel(peerId, fileId) {
        const peer = this.peers.get(peerId)
        if (!peer) return null
        const label = `file:${fileId}`
        const channel = peer.pc.createDataChannel(label, { ordered: true })
        channel.binaryType = 'arraybuffer'
        peer.channels.set(label, channel)
        return channel
    }

    closePeer(peerId) {
        const peer = this.peers.get(peerId)
        if (!peer) return
        if (peer.screenStream) {
            this.onScreenStream?.(peer.id, null)
        }
        for (const channel of peer.channels.values()) {
            try {
                channel.close()
            } catch {
                // ignore
            }
        }
        try {
            peer.pc.close()
        } catch {
            // ignore
        }
        this.peers.delete(peerId)
        this.onPeer?.({
            id: peer.id,
            removed: true
        })
        log.info('rtc', '关闭 PeerConnection', { peer: peer.name })
    }

    closeAll() {
        for (const id of [...this.peers.keys()]) {
            this.closePeer(id)
        }
        this.localTracks.clear()
    }
}
