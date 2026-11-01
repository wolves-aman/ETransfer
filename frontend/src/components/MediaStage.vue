<template>
    <div v-if="visible" class="media-dock">
        <div class="media-grid">
            <VideoTile
                v-for="peer in streamPeers"
                :key="peer.id"
                :stream="peer.stream"
                :label="peer.name"
                :fallback="initials(peer.name)"
            />
            <VideoTile
                v-if="state.media.cameraStream && state.media.camOn"
                :stream="state.media.cameraStream"
                label="你 · 摄像头"
                local
                muted
                fallback="ET"
            />
        </div>
        <div class="media-controls">
            <button
                type="button"
                :class="{ on: state.media.micOn }"
                :title="state.media.micOn ? '关闭麦克风' : '开启麦克风'"
                @click="actions.toggleMic()"
            >
                <AppIcon :name="state.media.micOn ? 'mic' : 'mic-off'" />
            </button>
            <button
                type="button"
                :class="{ on: state.media.camOn }"
                :title="state.media.camOn ? '关闭摄像头' : '开启摄像头'"
                @click="actions.toggleCam()"
            >
                <AppIcon :name="state.media.camOn ? 'camera' : 'camera-off'" />
            </button>
            <button
                type="button"
                :class="{ on: state.media.sharing }"
                title="屏幕共享"
                @click="state.media.sharing ? actions.stopScreenShare() : actions.shareScreen()"
            >
                <AppIcon name="monitor" />
            </button>
            <button class="danger" type="button" title="结束通话" @click="actions.hangupMedia()">
                <AppIcon name="phone-off" />
            </button>
        </div>
    </div>
</template>

<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import VideoTile from './VideoTile.vue'
import { initials } from '../lib/format'
import { state, actions } from '../store'

const streamPeers = computed(() => state.peers.filter((peer) => {
    const stream = peer.stream
    if (!stream) return false
    return stream.getTracks?.().some((track) => track.readyState === 'live')
}))

const visible = computed(() => (
    state.media.camOn
    || streamPeers.value.length > 0
))
</script>
