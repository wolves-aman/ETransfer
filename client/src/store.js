import { reactive } from 'vue'
import { nanoid } from 'nanoid'
import { runtime } from './config'
import { SignalingClient } from './lib/signaling'
import { Mesh } from './lib/mesh'
import { TransferManager } from './lib/transfers'
import { MediaController } from './lib/media'
import { toast, confirmDialog } from './lib/feedback'
import { log } from './lib/logger'
import { loadRoomMessages, saveMessage, updateMessage } from './lib/chat-db'
import { idbTakeShares } from './lib/idb'
import { compressImage, wrapFile } from './lib/files'
import { cleanupIncoming } from './lib/opfs'
import { uploadRelay } from './lib/relay'
import { groupCode, formatBytes } from './lib/format'

const NAME_KEY = 'etransfer-name'

function codeFromHash() {
    const match = window.location.hash.match(/^#\/([A-Za-z0-9_-]{4,12})/)
    return match ? match[1].toUpperCase() : ''
}

export const state = reactive({
    view: 'landing',
    connection: 'idle',
    connectionError: '',
    name: localStorage.getItem(NAME_KEY) || '',
    initialCode: codeFromHash(),
    room: null,
    self: { id: '', name: '', isHost: false },
    peers: [],
    messages: [],
    transfers: [],
    media: {
        active: false,
        micOn: false,
        camOn: false,
        sharing: false,
        cameraStream: null,
        screenStream: null,
        error: ''
    },
    ui: {
        inviteOpen: false,
        queueOpen: false,
        logsOpen: false,
        membersOpen: false,
        searchOpen: false,
        search: '',
        lightbox: null,
        pendingShares: 0
    },
    now: Date.now(),
    roomLoading: false
})

let signaling = null
let mesh = null
let transfers = null
let media = null
let initialized = false
let pendingShareFiles = []

function persistName(name) {
    const value = String(name || '').trim().slice(0, 24)
    state.name = value
    if (value) {
        localStorage.setItem(NAME_KEY, value)
    }
}

function peerName(peerId) {
    if (peerId === state.self.id) return state.self.name
    return state.peers.find((peer) => peer.id === peerId)?.name || '成员'
}

function upsertPeer(info) {
    if (!info?.id) return
    let peer = state.peers.find((item) => item.id === info.id)
    if (!peer) {
        peer = reactive({
            id: info.id,
            name: info.name && info.name !== '成员' ? info.name : '成员',
            isHost: Boolean(info.isHost),
            connected: Boolean(info.connected),
            state: info.state || 'new',
            stream: info.stream || null,
            screenSharing: false,
            screenStream: null,
            screenStreamId: '',
            chatReady: Boolean(info.chatReady)
        })
        state.peers.push(peer)
    } else {
        if (info.name && info.name !== '成员') peer.name = info.name
        if (info.isHost !== undefined) peer.isHost = Boolean(info.isHost)
        if (info.connected !== undefined) peer.connected = Boolean(info.connected)
        if (info.state) peer.state = info.state
        if (info.chatReady !== undefined) peer.chatReady = Boolean(info.chatReady)
        if (info.stream) peer.stream = info.stream
    }
    if (info.id === state.self.id) {
        state.self.isHost = peer.isHost
        if (peer.name !== '成员') state.self.name = peer.name
    }
}

function removePeer(peerId) {
    const index = state.peers.findIndex((peer) => peer.id === peerId)
    if (index !== -1) {
        state.peers.splice(index, 1)
    }
}

function normalizeStored(message) {
    return {
        ...message,
        revoked: Boolean(message.revoked),
        file: message.file
            ? { ...message.file, complete: Boolean(message.file.complete) }
            : null
    }
}

function addMessage(message, { persist = true } = {}) {
    state.messages.push(message)
    const stored = state.messages[state.messages.length - 1]
    if (persist) {
        saveMessage(stored).catch(() => {})
    }
    return stored
}

function addSystem(text) {
    if (!state.room) return
    const message = {
        id: nanoid(12),
        roomId: state.room.id,
        from: 'system',
        fromName: '系统',
        mine: false,
        type: 'system',
        text,
        ts: Date.now(),
        revoked: false
    }
    addMessage(message)
}

async function loadHistory(roomId) {
    try {
        const rows = await loadRoomMessages(roomId)
        state.messages = rows.map(normalizeStored)
        log.info('room', '加载历史消息', { count: rows.length })
    } catch (error) {
        log.warn('room', '加载历史消息失败', { error: error.message })
    }
}

async function consumeShares() {
    try {
        const rows = await idbTakeShares()
        if (!rows.length) return
        pendingShareFiles = rows.map((row) => wrapFile(row.blob, row.name))
        state.ui.pendingShares = pendingShareFiles.length
        toast.info('收到系统分享', `${pendingShareFiles.length} 个文件待发送`)
        if (state.room) {
            flushShares()
        }
    } catch (error) {
        log.warn('pwa', '读取系统分享文件失败', { error: error.message })
    }
}

function flushShares() {
    if (!pendingShareFiles.length || !state.room) return
    const files = pendingShareFiles.slice()
    pendingShareFiles = []
    state.ui.pendingShares = 0
    transfers.enqueue(files)
}

function handleSignalingEvent(message) {
    switch (message.action) {
        case 'PEER_JOINED': {
            const peer = message.peer
            if (!peer) return
            upsertPeer({
                id: peer.id,
                name: peer.name,
                isHost: peer.is_host,
                connected: false,
                state: 'connecting'
            })
            mesh.connectTo(peer)
            addSystem(`${peer.name} 加入了通道`)
            toast.info('成员加入', `${peer.name} 已进入通道`)
            log.info('room', '成员加入', { peer: peer.name })
            break
        }
        case 'PEER_LEFT': {
            const name = peerName(message.peer_id)
            mesh.closePeer(message.peer_id)
            removePeer(message.peer_id)
            addSystem(`${name} 离开了通道`)
            toast.warn('成员离开', `${name} 已断开连接`)
            log.warn('room', '成员离开', { peer: name, reason: message.reason })
            break
        }
        case 'HOST_CHANGED': {
            if (message.peer_id === state.self.id) {
                state.self.isHost = true
                toast.info('房主已转移', '你现在是房主')
            }
            for (const peer of state.peers) {
                peer.isHost = peer.id === message.peer_id
            }
            log.info('room', '房主变更', { peer_id: message.peer_id })
            break
        }
        case 'TRANSFER':
            mesh.handleSignal(message.from, message)
            break
        case 'KICKED':
            toast.error('已被移出房间', message.msg || '房主结束了你的会话')
            resetRoom()
            break
        case 'ROOM_CLOSED':
            toast.warn('房间已关闭', message.msg || '通道已结束')
            resetRoom()
            break
        case 'SIGNAL_CLOSED':
            if (state.room) {
                toast.error('信令连接断开', '房间通道已不可用，请重新加入')
            }
            break
        case 'ERROR':
            toast.error('操作失败', message.msg || '服务器返回错误')
            break
        case 'LEAVE_ROOM':
        case 'HEART_BEAT':
            break
        default:
            log.debug('signal', '未处理信令事件', message)
    }
}

function handleChat(peerId, payload) {
    if (!payload) return
    switch (payload.kind) {
        case 'text':
        case 'image': {
            if (state.messages.some((message) => message.id === payload.id)) return
            if (payload.kind === 'image') {
                if (
                    typeof payload.image !== 'string'
                    || payload.image.length > 400_000
                    || !/^data:image\/(jpeg|png|webp|gif);base64,/i.test(payload.image)
                ) {
                    log.warn('chat', '拒绝非法的图片消息')
                    return
                }
            }
            const message = {
                id: payload.id,
                roomId: state.room?.id,
                from: peerId,
                fromName: peerName(peerId),
                mine: false,
                type: payload.kind,
                text: payload.text || '',
                image: payload.image || '',
                ts: payload.ts || Date.now(),
                revoked: false
            }
            addMessage(message)
            break
        }
        case 'recall': {
            const message = state.messages.find((item) => item.id === payload.id)
            if (message) {
                message.revoked = true
                message.text = ''
                message.image = ''
                updateMessage(message).catch(() => {})
            }
            break
        }
        case 'screen-start': {
            const peer = state.peers.find((item) => item.id === peerId)
            if (!peer) return
            peer.screenSharing = true
            peer.screenStreamId = payload.streamId || ''
            mesh.setScreenStreamId(peerId, payload.streamId)
            log.info('media', '对端开始屏幕共享', { peer: peer.name })
            break
        }
        case 'screen-stop': {
            const peer = state.peers.find((item) => item.id === peerId)
            if (peer) {
                peer.screenSharing = false
                peer.screenStream = null
                peer.screenStreamId = ''
            }
            mesh.clearScreenStream(peerId)
            log.info('media', '对端结束屏幕共享')
            break
        }
        case 'profile': {
            const peer = state.peers.find((item) => item.id === peerId)
            if (peer && payload.name) {
                peer.name = payload.name
            }
            break
        }
        case 'file-offer':
        case 'file-complete':
        case 'file-ack':
        case 'file-progress':
        case 'file-reject':
        case 'file-cancel':
            transfers.handleControl(peerId, payload)
            break
        default:
            log.debug('chat', '未处理的聊天消息', payload)
    }
}

function createOutgoingMessage(message) {
    addMessage(message)
    const delivered = mesh.broadcast({
        kind: message.type === 'image' ? 'image' : 'text',
        id: message.id,
        text: message.text,
        image: message.image,
        ts: message.ts
    })
    if (!delivered) {
        toast.warn('暂无接收者', '当前没有已连接成员，消息仅保存在本地')
    }
    return delivered
}

export const actions = {
    async init() {
        if (initialized) return
        initialized = true
        state.name = localStorage.getItem(NAME_KEY) || ''

        media = new MediaController({
            mesh: {
                addTrack: (...args) => mesh.addTrack(...args),
                removeTrack: (...args) => mesh.removeTrack(...args),
                broadcast: (payload) => mesh.broadcast(payload),
                sendChat: (peerId, payload) => mesh.sendChat(peerId, payload)
            }
        })
        state.media = media.state

        signaling = new SignalingClient({
            url: runtime.wsUrl,
            onEvent: handleSignalingEvent,
            onStatus: (status) => {
                state.connection = status
                if (status === 'offline') {
                    state.connectionError = '无法连接信令服务'
                }
                if (status === 'online') {
                    state.connectionError = ''
                }
            }
        })

        mesh = new Mesh({
            iceServers: runtime.iceServers,
            onSignal: (target, type, payload) => signaling.signal(target, type, payload),
            onChat: handleChat,
            onFileChannel: (peerId, channel, fileId) => transfers.handleFileChannel(peerId, channel, fileId),
            onPeer: (peer) => {
                if (peer.removed) {
                    removePeer(peer.id)
                } else {
                    const existing = state.peers.find((item) => item.id === peer.id)
                    const wasConnected = Boolean(existing?.chatReady)
                    upsertPeer(peer)
                    if (!wasConnected && peer.chatReady && media?.state.sharing) {
                        media.announceScreen(peer.id)
                    }
                }
            },
            onStream: (peerId, stream) => {
                const peer = state.peers.find((item) => item.id === peerId)
                if (peer) {
                    // 新建一个 MediaStream 引用，确保 Vue 能感知轨道变化
                    peer.stream = new MediaStream(stream.getTracks())
                }
            },
            onScreenStream: (peerId, stream) => {
                const peer = state.peers.find((item) => item.id === peerId)
                if (!peer) return
                peer.screenStream = stream
                peer.screenSharing = Boolean(stream)
            }
        })

        transfers = new TransferManager({
            mesh,
            onOutgoing: (item) => {
                const message = {
                    id: item.id,
                    roomId: state.room?.id,
                    from: state.self.id,
                    fromName: state.self.name,
                    mine: true,
                    type: 'file',
                    text: '',
                    ts: Date.now(),
                    revoked: false,
                    file: {
                        name: item.name,
                        size: item.size,
                        mime: item.mime,
                        received: 0,
                        complete: false,
                        blob: null,
                        opfsPath: '',
                        error: '',
                        transferId: item.id,
                        fromPeer: ''
                    }
                }
                addMessage(message)
                item.messageId = item.id
            },
            onIncoming: (peerId, meta) => {
                if (!state.room) return null
                const message = {
                    id: meta.fileId,
                    roomId: state.room.id,
                    from: peerId,
                    fromName: peerName(peerId),
                    mine: false,
                    type: 'file',
                    text: '',
                    ts: Date.now(),
                    revoked: false,
                    file: {
                        name: meta.name,
                        size: meta.size,
                        mime: meta.mime,
                        received: 0,
                        complete: false,
                        blob: null,
                        opfsPath: '',
                        error: '',
                        transferId: meta.fileId,
                        fromPeer: peerId,
                        path: meta.path
                    }
                }
                addMessage(message, { persist: false })
                return state.messages[state.messages.length - 1]
            },
            onIncomingUpdate: (message, persist) => {
                if (persist) {
                    updateMessage(message).catch(() => {})
                }
            },
            onIncomingComplete: (message) => {
                saveMessage(message).catch(() => {})
                toast.success('文件接收完成', `${message.file.name} · ${formatBytes(message.file.size)}`)
            },
            onIncomingRejected: (peerId, meta, reason) => {
                toast.warn(
                    '已拒绝接收',
                    reason === 'too-large'
                        ? `${meta.name} 超过本机内存接收上限，请让对方改用服务器中转`
                        : `${meta.name} 无法接收`
                )
            },
            onIncomingError: (message, error) => {
                toast.error('文件接收失败', `${message.file.name}：${error.message}`)
            },
            onItemUpdate: (item) => {
                if (!item?.messageId) return
                const message = state.messages.find((entry) => entry.id === item.messageId)
                if (!message?.file) return
                message.file.received = item.parts.length
                    ? Math.min(item.size, Math.round(item.sentBytes / item.parts.length))
                    : item.sentBytes
                message.file.complete = item.status === 'done'
                if (['done', 'error', 'canceled'].includes(item.status) && item._persisted !== item.status) {
                    item._persisted = item.status
                    updateMessage(message).catch(() => {})
                }
            }
        })
        state.transfers = transfers.items

        cleanupIncoming({ maxAgeMs: runtime.opfsCleanupMaxAge }).catch(() => {})

        setInterval(() => {
            state.now = Date.now()
        }, 1000)

        window.addEventListener('beforeunload', (event) => {
            if (transfers?.activeItem()) {
                event.preventDefault()
                event.returnValue = ''
            }
        })

        await consumeShares()
    },

    async retryConnection() {
        try {
            await signaling.connect()
        } catch (error) {
            toast.error('无法连接服务', error.message)
        }
    },

    setName(name) {
        persistName(name)
    },

    async createRoom({ code, password, expiresIn, oneTime, maxUsers, name }) {
        persistName(name || state.name)
        state.roomLoading = true
        try {
            await ensureConnection()
            const response = await signaling.createRoom({
                room_id: code || '',
                password: password || '',
                name: state.name || '房主',
                expires_in: expiresIn,
                one_time: Boolean(oneTime),
                max_users: maxUsers
            })
            await this.enterRoom(response, { password })
            toast.success('通道已创建', `短码 ${groupCode(response.room_id)}`)
        } catch (error) {
            toast.error('创建房间失败', error.message)
            throw error
        } finally {
            state.roomLoading = false
        }
    },

    async joinRoom({ code, password, name }) {
        persistName(name || state.name)
        state.roomLoading = true
        try {
            await ensureConnection()
            const response = await signaling.joinRoom({
                room_id: code,
                password: password || '',
                name: state.name || '访客'
            })
            await this.enterRoom(response)
            toast.success('已进入通道', `短码 ${groupCode(response.room_id)}`)
        } catch (error) {
            toast.error('加入房间失败', error.message)
            throw error
        } finally {
            state.roomLoading = false
        }
    },

    async enterRoom(response, options = {}) {
        mesh.closeAll()
        transfers.clear()
        transfers.items.splice(0, transfers.items.length)

        state.room = {
            id: response.room_id,
            hostId: response.host_id,
            hasPassword: Boolean(response.has_password),
            password: options.password || '',
            oneTime: Boolean(response.one_time),
            maxUsers: response.max_users,
            expiresAt: response.expires_at,
            createdAt: response.created_at
        }
        state.self = {
            id: response.self_id,
            name: response.self_name,
            isHost: response.host_id === response.self_id
        }
        state.peers = (response.peers || []).map((peer) => reactive({
            id: peer.id,
            name: peer.name,
            isHost: Boolean(peer.is_host),
            connected: false,
            state: 'connecting',
            stream: null,
            screenSharing: false,
            screenStream: null,
            screenStreamId: '',
            chatReady: false
        }))
        state.messages = []
        state.view = 'room'
        state.ui.inviteOpen = false
        state.ui.queueOpen = false
        state.ui.logsOpen = false
        state.ui.membersOpen = false
        state.ui.searchOpen = false
        state.ui.search = ''
        state.ui.lightbox = null

        log.info('room', '进入房间', {
            roomId: response.room_id,
            self: response.self_id,
            peers: (response.peers || []).length
        })
        window.history.pushState({}, '', `${window.location.pathname}${window.location.search}#/${response.room_id}`)
        await loadHistory(response.room_id)
        flushShares()
    },

    leaveRoom() {
        signaling.leaveRoom()
        resetRoom()
        toast.info('已离开通道', '本地历史消息已保留')
    },

    async closeRoom() {
        const ok = await confirmDialog({
            title: '关闭房间',
            message: '所有成员都会被移出，通道立即失效。确认关闭？',
            confirmText: '关闭房间',
            tone: 'error'
        })
        if (!ok) return
        try {
            await signaling.closeRoom()
        } catch {
            // 服务端会关闭连接，本地仍然清理
        }
        resetRoom()
    },

    async kickPeer(peerId) {
        const peer = state.peers.find((item) => item.id === peerId)
        if (!peer) return
        const ok = await confirmDialog({
            title: '移除成员',
            message: `确定将「${peer.name}」移出通道？`,
            confirmText: '移除',
            tone: 'error'
        })
        if (!ok) return
        try {
            await signaling.kick(peerId)
        } catch (error) {
            toast.error('移除失败', error.message)
        }
    },

    sendText(text) {
        const value = String(text || '').trim()
        if (!value || !state.room) return
        const message = {
            id: nanoid(12),
            roomId: state.room.id,
            from: state.self.id,
            fromName: state.self.name,
            mine: true,
            type: 'text',
            text: value,
            ts: Date.now(),
            revoked: false
        }
        createOutgoingMessage(message)
    },

    async sendImage(file) {
        if (!state.room) return
        try {
            const compressed = await compressImage(file)
            if (compressed.dataUrl.length > 180_000) {
                toast.info('图片较大', '已转为文件传输，避免 DataChannel 单条消息超限')
                transfers.enqueue([wrapFile(file)])
                return
            }
            const message = {
                id: nanoid(12),
                roomId: state.room.id,
                from: state.self.id,
                fromName: state.self.name,
                mine: true,
                type: 'image',
                image: compressed.dataUrl,
                text: '',
                ts: Date.now(),
                revoked: false
            }
            createOutgoingMessage(message)
        } catch (error) {
            toast.error('图片处理失败', error.message)
        }
    },

    sendFiles(wrappers) {
        if (!state.room || !wrappers?.length) return
        transfers.enqueue(wrappers)
        state.ui.queueOpen = true
    },

    pauseTransfer(item) {
        transfers.pause(item)
    },

    resumeTransfer(item) {
        transfers.resume(item)
    },

    cancelTransfer(item) {
        transfers.cancel(item)
    },

    recallMessage(messageId) {
        const message = state.messages.find((item) => item.id === messageId)
        if (!message || !message.mine || message.revoked) return
        message.revoked = true
        message.text = ''
        message.image = ''
        updateMessage(message).catch(() => {})
        mesh.broadcast({ kind: 'recall', id: messageId })
        toast.success('消息已撤回')
    },

    async relayTransfer(item) {
        const ok = await confirmDialog({
            title: '服务器中转',
            message: 'P2P 失败时可把文件传到服务器临时存储，再把下载链接发给对方。文件会在服务端保留一段时间，确认继续？',
            confirmText: '上传中转',
            tone: 'warn'
        })
        if (!ok) return

        item.relay = { status: 'uploading', progress: 0, url: '' }
        log.warn('transfer', '开始服务器中继', { file: item.name, size: item.size })
        try {
            const result = await uploadRelay(item.file, (progress) => {
                if (item.relay) item.relay.progress = progress
            })
            item.relay = { status: 'done', progress: 100, url: result.absoluteUrl }
            item.status = 'relayed'
            this.sendText(`文件「${item.name}」已通过服务器中转：${result.absoluteUrl}`)
            toast.success('中转完成', '下载链接已发送到聊天')
        } catch (error) {
            item.relay = { status: 'error', progress: 0, url: '', error: error.message }
            toast.error('中转失败', error.message)
        }
    },

    async shareScreen() {
        try {
            await media.shareScreen()
            if (!mesh.connectedPeers().length) {
                toast.warn('暂无接收者', '屏幕共享已开始，等待成员加入')
            }
        } catch (error) {
            toast.error('屏幕共享失败', error.name === 'NotAllowedError' ? '你取消了共享' : error.message)
        }
    },

    stopScreenShare() {
        media.stopShare()
    },

    async toggleMic() {
        try {
            await media.toggleMic()
        } catch (error) {
            toast.error('麦克风不可用', error.message)
        }
    },

    async toggleCam() {
        try {
            await media.toggleCam()
        } catch (error) {
            toast.error('摄像头不可用', error.message)
        }
    },

    hangupMedia() {
        media.hangup()
    },

    setSearch(value) {
        state.ui.search = value
    },

    setLightbox(index) {
        state.ui.lightbox = index
    },

    closeLightbox() {
        state.ui.lightbox = null
    },

    togglePanel(panel) {
        state.ui[panel] = !state.ui[panel]
    },

    gallery() {
        return state.messages
            .filter((message) => message.type === 'image' && message.image && !message.revoked)
            .map((message) => ({
                id: message.id,
                src: message.image,
                fromName: message.fromName,
                ts: message.ts
            }))
    },

    openGallery(index) {
        state.ui.lightbox = index
    },

    logText() {
        return state.messages
    }
}

function resetRoom() {
    if (transfers) {
        transfers.clear()
    }
    if (mesh) {
        mesh.closeAll()
    }
    if (media) {
        media.hangup()
    }
    if (signaling) {
        signaling.close()
    }
    state.connection = 'idle'
    state.room = null
    state.self = { id: '', name: state.name, isHost: false }
    state.peers = []
    state.messages = []
    state.view = 'landing'
    state.ui.inviteOpen = false
    state.ui.queueOpen = false
    state.ui.logsOpen = false
    state.ui.membersOpen = false
    state.ui.searchOpen = false
    state.ui.search = ''
    state.ui.lightbox = null
    state.initialCode = codeFromHash()
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
    if (transfers) {
        transfers.items.splice(0, transfers.items.length)
    }
    log.info('room', '离开房间，状态已重置')
}

export function getPeerName(peerId) {
    return peerName(peerId)
}

async function ensureConnection() {
    if (state.connection === 'online' && signaling?.isOpen()) {
        return
    }
    await signaling.connect()
}
