<template>
    <section class="screen room room-screen" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
        <div class="screen-bg" aria-hidden="true">
            <i class="glow g1"></i><i class="glow g2"></i><i class="glow g3"></i>
            <div class="scan"></div>
        </div>

        <header class="topbar">
            <a class="brand" href="#" @click.prevent>
                <BrandMark />
                <span class="brand-name">ETRANSFER</span>
            </a>
            <div class="room-chip">
                <span>ROOM</span>
                <strong>{{ groupedCode }}</strong>
                <button class="mini-btn" type="button" aria-label="复制房间号" @click="copyCode">
                    <AppIcon name="copy" />
                </button>
            </div>

            <div class="topbar-actions">
                <span class="status-pill live">
                    <i class="dot"></i>
                    {{ connectedPeers.length + 1 }} ONLINE
                </span>
                <button class="icon-btn tip" type="button" data-tip="邀请 / 二维码" @click="state.ui.inviteOpen = true">
                    <AppIcon name="qr" />
                </button>
                <button class="icon-btn tip" type="button" data-tip="传输队列" @click="state.ui.queueOpen = true">
                    <AppIcon name="upload" />
                    <span v-if="activeTransfers" class="badge-count">{{ activeTransfers }}</span>
                </button>
                <button class="icon-btn tip" type="button" data-tip="房间日志" @click="state.ui.logsOpen = true">
                    <AppIcon name="terminal" />
                </button>
                <button class="btn ghost sm" type="button" @click="leaveRoom">离开</button>
            </div>
        </header>

        <main class="room-main">
            <aside class="rail">
                <div class="panel">
                    <div class="panel-head"><span>通道状态</span><span class="secure"><AppIcon name="lock" /> LIVE</span></div>
                    <div class="nodes">
                        <div class="node"><div class="node-core">{{ initials(state.self.name) }}</div><span>你</span></div>
                        <div class="beam"></div>
                        <div class="node peer">
                            <div class="node-core multi">
                                {{ state.peers.length ? `${state.peers.length}` : '··' }}
                            </div>
                            <span>{{ state.peers.length ? '对端' : '等待' }}</span>
                        </div>
                    </div>
                    <div class="meta-grid">
                        <div><span>PROTOCOL</span><strong>WebRTC Mesh</strong></div>
                        <div><span>ENCRYPTION</span><strong>DTLS 1.2</strong></div>
                    </div>
                    <div class="room-meta-chips">
                        <span v-if="state.room.hasPassword" class="meta-chip"><AppIcon name="key" /> 密码保护</span>
                        <span v-if="state.room.oneTime" class="meta-chip warn"><AppIcon name="zap" /> 一次性</span>
                        <span class="meta-chip"><AppIcon name="clock" /> {{ expiresText }}</span>
                        <span class="meta-chip"><AppIcon name="users" /> {{ state.room.maxUsers }} 人上限</span>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head">
                        <span>邀请链接</span>
                        <button class="mini-btn" type="button" aria-label="二维码" @click="state.ui.inviteOpen = true">
                            <AppIcon name="qr" />
                        </button>
                    </div>
                    <div class="link-box" @click="copyLink">
                        <span>{{ roomLink }}</span>
                        <AppIcon name="copy" style="width: 12px; height: 12px; color: var(--dim)" />
                    </div>
                    <p class="panel-note">
                        {{ state.room.oneTime ? '一次性房间，成员离开即销毁。' : `有效期剩余 ${expiresText}，关闭页面后通道结束。` }}
                    </p>
                </div>

                <div class="panel quick-panel">
                    <div class="panel-head"><span>快速发送</span><span class="mono-label">DROP / PASTE</span></div>
                    <div class="quick">
                        <button type="button" @click="openPicker('file')">
                            <span class="quick-ico"><AppIcon name="file" /></span>
                            <span><strong>文件</strong><small>多选 / 任意格式</small></span>
                        </button>
                        <button type="button" @click="openPicker('image')">
                            <span class="quick-ico"><AppIcon name="image" /></span>
                            <span><strong>图片</strong><small>粘贴 / 压缩</small></span>
                        </button>
                        <button type="button" @click="openPicker('folder')">
                            <span class="quick-ico"><AppIcon name="folder" /></span>
                            <span><strong>文件夹</strong><small>递归发送</small></span>
                        </button>
                        <button type="button" @click="toggleScreen">
                            <span class="quick-ico"><AppIcon name="monitor" /></span>
                            <span><strong>{{ state.media.sharing ? '停止共享' : '共享屏幕' }}</strong><small>含系统音频</small></span>
                        </button>
                    </div>
                </div>

                <div class="panel members-panel">
                    <div class="panel-head">
                        <span>成员 {{ state.peers.length + 1 }}</span>
                        <button
                            v-if="state.self.isHost"
                            class="mini-btn"
                            type="button"
                            aria-label="关闭房间"
                            title="关闭房间"
                            @click="actions.closeRoom()"
                        >
                            <AppIcon name="x" />
                        </button>
                    </div>
                    <MembersPanel
                        :peers="state.peers"
                        :self-name="state.self.name"
                        :self-is-host="state.self.isHost"
                        @kick="actions.kickPeer"
                    />
                </div>

                <div class="secure-note">
                    <AppIcon name="shield" />
                    <p><strong>端到端加密</strong>文件只在本房间成员之间直连，服务器只转发信令。</p>
                </div>
            </aside>

            <section class="chat">
                <div class="chat-head">
                    <div class="avatar-stack">
                        <span class="av">{{ initials(state.self.name) }}</span>
                        <span
                            v-for="peer in state.peers.slice(0, 2)"
                            :key="peer.id"
                            class="av peer"
                        >{{ initials(peer.name) }}</span>
                        <span v-if="state.peers.length > 2" class="av peer">+{{ state.peers.length - 2 }}</span>
                    </div>
                    <div class="chat-title">
                        <div class="chat-title-row">
                            <strong>{{ state.peers.length ? `${state.peers.length + 1} 人加密通道` : '等待成员加入' }}</strong>
                            <span class="meta-chip" v-if="state.room.oneTime">ONE-TIME</span>
                        </div>
                        <small><i class="dot"></i> {{ statusText }}</small>
                    </div>

                    <div class="chat-actions">
                        <button class="icon-btn tip" type="button" data-tip="搜索消息" @click="state.ui.searchOpen = !state.ui.searchOpen">
                            <AppIcon name="search" />
                        </button>
                        <button class="icon-btn tip" type="button" data-tip="成员" @click="state.ui.membersOpen = true">
                            <AppIcon name="users" />
                        </button>
                        <button class="icon-btn tip" type="button" :class="{ 'tool-active': state.media.micOn }" data-tip="麦克风" @click="actions.toggleMic()">
                            <AppIcon :name="state.media.micOn ? 'mic' : 'mic-off'" />
                        </button>
                        <button class="icon-btn tip" type="button" :class="{ 'tool-active': state.media.camOn }" data-tip="摄像头" @click="actions.toggleCam()">
                            <AppIcon :name="state.media.camOn ? 'camera' : 'camera-off'" />
                        </button>
                        <button class="icon-btn tip" type="button" :class="{ 'tool-active': state.media.sharing }" data-tip="屏幕共享" @click="toggleScreen">
                            <AppIcon name="monitor" />
                        </button>
                        <button v-if="state.media.active" class="icon-btn tip danger" type="button" data-tip="结束通话" @click="actions.hangupMedia()">
                            <AppIcon name="phone-off" />
                        </button>
                    </div>
                </div>

                <div v-if="state.ui.searchOpen" class="search-strip">
                    <AppIcon name="search" />
                    <input v-model="state.ui.search" placeholder="搜索消息、文件名或成员…" autofocus>
                    <button v-if="state.ui.search" type="button" aria-label="清空" @click="state.ui.search = ''">
                        <AppIcon name="x" />
                    </button>
                </div>

                <div ref="listRef" class="chat-body" @scroll="onScroll">
                    <div v-if="!filteredMessages.length" class="empty-chat">
                        <BrandMark class="portal-mark" />
                        <strong>{{ state.ui.search ? '没有匹配的消息' : '通道已就绪' }}</strong>
                        <small v-if="state.ui.search">换个关键词，或清空搜索。</small>
                        <small v-else>分享上方链接或二维码邀请成员，消息与文件都会加密直连。</small>
                    </div>

                    <ChatMessage
                        v-for="message in filteredMessages"
                        :key="message.id"
                        :message="message"
                        @open-image="openImage"
                        @recall="actions.recallMessage"
                    />
                </div>

                <MediaStage />
                <ScreenShareStage />

                <ComposerBox
                    :can-send="canSend"
                    @send="actions.sendText"
                    @pick="openPicker"
                    @screen="toggleScreen"
                    @paste-files="onPasteFiles"
                />

                <div v-if="dragging" class="drop-veil">
                    <AppIcon name="upload" />
                    <strong>松手即可发送</strong>
                    <small>支持多文件、文件夹、图片；会按顺序进入传输队列。</small>
                </div>
            </section>
        </main>

        <input ref="fileInput" class="hidden-input" type="file" multiple @change="onFileInput($event, 'file')">
        <input ref="imageInput" class="hidden-input" type="file" accept="image/*" multiple @change="onFileInput($event, 'image')">
        <input ref="folderInput" class="hidden-input" type="file" webkitdirectory directory multiple @change="onFileInput($event, 'folder')">

        <InvitePanel
            v-if="state.ui.inviteOpen"
            :room="state.room"
            :link="roomLink"
            @close="state.ui.inviteOpen = false"
        />

        <TransferQueue
            :open="state.ui.queueOpen"
            :items="state.transfers"
            @close="state.ui.queueOpen = false"
            @pause="actions.pauseTransfer"
            @resume="actions.resumeTransfer"
            @cancel="actions.cancelTransfer"
            @relay="actions.relayTransfer"
        />

        <LogsPanel :open="state.ui.logsOpen" @close="state.ui.logsOpen = false" />

        <Teleport to="body">
            <Transition name="modal" appear>
                <div v-if="state.ui.membersOpen" class="dialog-veil" @click.self="state.ui.membersOpen = false">
                    <div class="dialog-card" style="width: min(390px, 100%)">
                        <div class="dialog-head">
                            <span class="dialog-ic"><AppIcon name="users" /></span>
                            <span class="mono-label">MEMBERS</span>
                            <button class="drawer-close" style="margin-left: auto" type="button" aria-label="关闭" @click="state.ui.membersOpen = false">
                                <AppIcon name="x" />
                            </button>
                        </div>
                        <h3>房间成员</h3>
                        <MembersPanel
                            :peers="state.peers"
                            :self-name="state.self.name"
                            :self-is-host="state.self.isHost"
                            @kick="actions.kickPeer"
                        />
                        <div class="dialog-actions">
                            <button v-if="state.self.isHost" class="btn ghost sm" type="button" @click="actions.closeRoom()">
                                关闭房间
                            </button>
                            <button class="btn primary sm" type="button" @click="state.ui.membersOpen = false">完成</button>
                        </div>
                    </div>
                </div>
            </Transition>
        </Teleport>

        <ImageLightbox
            v-if="state.ui.lightbox !== null"
            :images="gallery"
            :index="state.ui.lightbox"
            @update:index="state.ui.lightbox = $event"
            @close="state.ui.lightbox = null"
        />
    </section>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import BrandMark from './BrandMark.vue'
import ChatMessage from './ChatMessage.vue'
import ComposerBox from './ComposerBox.vue'
import MembersPanel from './MembersPanel.vue'
import InvitePanel from './InvitePanel.vue'
import TransferQueue from './TransferQueue.vue'
import LogsPanel from './LogsPanel.vue'
import MediaStage from './MediaStage.vue'
import ScreenShareStage from './ScreenShareStage.vue'
import ImageLightbox from './ImageLightbox.vue'
import { state, actions } from '../store'
import { formatCountdown, groupCode, initials } from '../lib/format'
import { copyText } from '../lib/clipboard'
import { toast, confirmDialog } from '../lib/feedback'
import { collectFiles, filesFromInput, isImage } from '../lib/files'
import { log } from '../lib/logger'

const fileInput = ref(null)
const imageInput = ref(null)
const folderInput = ref(null)
const listRef = ref(null)
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)
let stickToBottom = true

const groupedCode = computed(() => groupCode(state.room?.id || ''))
const roomLink = computed(() => `${window.location.origin}${window.location.pathname}#/${state.room?.id || ''}`)
const connectedPeers = computed(() => state.peers.filter((peer) => peer.chatReady))
const canSend = computed(() => connectedPeers.value.length > 0)
const activeTransfers = computed(() => state.transfers.filter((item) => (
    ['queued', 'active', 'paused'].includes(item.status)
)).length)
const expiresText = computed(() => {
    if (!state.room?.expiresAt) return '永久'
    if (state.room.expiresAt <= state.now) return '已过期'
    return formatCountdown(state.room.expiresAt - state.now)
})
const statusText = computed(() => {
    if (!state.peers.length) return '等待成员加入 · 分享邀请链接'
    if (connectedPeers.value.length) return `${connectedPeers.value.length} 个对端已连接 · 加密直连`
    return '正在建立 P2P 通道…'
})
const gallery = computed(() => actions.gallery())
const filteredMessages = computed(() => {
    const keyword = state.ui.search.trim().toLowerCase()
    if (!keyword) return state.messages
    return state.messages.filter((message) => {
        const haystack = [
            message.text,
            message.fromName,
            message.file?.name
        ].filter(Boolean).join(' ').toLowerCase()
        return haystack.includes(keyword)
    })
})

function onScroll() {
    const element = listRef.value
    if (!element) return
    stickToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120
}

async function scrollToBottom(force = false) {
    await nextTick()
    const element = listRef.value
    if (!element) return
    if (force || stickToBottom) {
        element.scrollTop = element.scrollHeight
    }
}

watch(() => state.messages.length, () => scrollToBottom())
watch(() => state.ui.search, () => scrollToBottom(true))

onMounted(() => scrollToBottom(true))

function openPicker(type) {
    if (type === 'image') imageInput.value?.click()
    else if (type === 'folder') folderInput.value?.click()
    else fileInput.value?.click()
}

async function onFileInput(event, type) {
    const wrappers = filesFromInput(event.target)
    event.target.value = ''
    await handleWrappers(wrappers, type === 'image')
}

async function handleWrappers(wrappers, preferImages = false) {
    if (!wrappers.length) return
    const folderLike = wrappers.some((item) => String(item.path || '').includes('/'))
    if (!folderLike && (preferImages || wrappers.every((item) => isImage(item.file)))) {
        for (const item of wrappers) {
            await actions.sendImage(item.file)
        }
        return
    }
    actions.sendFiles(wrappers)
}

function onDragEnter(event) {
    if (!event.dataTransfer?.types?.includes('Files')) return
    dragDepth.value += 1
}

function onDragLeave() {
    dragDepth.value = Math.max(0, dragDepth.value - 1)
}

async function onDrop(event) {
    dragDepth.value = 0
    const wrappers = await collectFiles(event.dataTransfer)
    await handleWrappers(wrappers)
}

async function onPasteFiles(files) {
    await handleWrappers(files.map((file) => ({ file, path: file.name })))
}

function toggleScreen() {
    if (state.media.sharing) {
        actions.stopScreenShare()
    } else {
        actions.shareScreen()
    }
}

async function copyCode() {
    if (await copyText(state.room?.id || '')) toast.success('房间号已复制')
}

async function copyLink() {
    if (await copyText(roomLink.value)) toast.success('邀请链接已复制')
}

function openImage(message) {
    const index = gallery.value.findIndex((item) => item.id === message.id)
    state.ui.lightbox = index === -1 ? 0 : index
}

async function leaveRoom() {
    if (state.self.isHost && state.peers.length) {
        const ok = await confirmDialog({
            title: '离开房间',
            message: '你是房主，离开后房主会自动转移给下一位成员。确定离开？',
            confirmText: '离开',
            tone: 'warn'
        })
        if (!ok) return
    }
    actions.leaveRoom()
    log.info('room', '用户主动离开')
}
</script>
