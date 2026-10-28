<template>
    <Teleport to="body">
        <div
            v-if="source"
            class="screen-stage"
            :class="{ maximized, immersive }"
            :style="maximized || immersive ? null : stageStyle"
        >
            <header class="screen-head" @pointerdown="startDrag">
                <div class="screen-head-left">
                    <i class="dot"></i>
                    <strong>{{ source.local ? '你正在共享屏幕' : `${source.name} 正在共享屏幕` }}</strong>
                    <span class="mono-label">{{ source.local ? 'LOCAL PREVIEW' : 'REMOTE SCREEN' }}</span>
                </div>
                <div class="screen-actions" @pointerdown.stop>
                    <button type="button" :title="maximized ? '还原' : '最大化'" @click="toggleMax">
                        <AppIcon :name="maximized ? 'shrink' : 'expand'" />
                    </button>
                    <button type="button" :title="immersive ? '退出沉浸' : '沉浸全屏'" @click="toggleImmersive">
                        <AppIcon name="monitor" />
                    </button>
                    <button
                        type="button"
                        :title="source.local ? '停止共享' : '隐藏画面'"
                        @click="closeStage"
                    >
                        <AppIcon :name="source.local ? 'x' : 'eye'" />
                    </button>
                </div>
            </header>

            <div class="screen-body">
                <video
                    v-if="source.stream"
                    ref="video"
                    autoplay
                    playsinline
                    :muted="source.local"
                ></video>
                <div v-else class="screen-wait">
                    <span class="loader-ring"></span>
                    正在建立共享画面…
                </div>
            </div>

            <span
                v-if="!maximized && !immersive"
                class="screen-resize"
                title="拖动调整大小"
                @pointerdown.stop.prevent="startResize"
            ></span>
        </div>

        <button
            v-else-if="hiddenSource"
            class="screen-mini"
            type="button"
            :title="`${hiddenSource.name} 正在共享屏幕，点击展开`"
            @click="restoreStage"
        >
            <i class="dot"></i>
            <span><strong>{{ hiddenSource.name }}</strong> 正在共享屏幕</span>
            <em>展开</em>
            <AppIcon name="monitor" />
        </button>
    </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { state, actions } from '../store'

const video = ref(null)
const maximized = ref(false)
const immersive = ref(false)
const hiddenKey = ref('')
const focusIndex = ref(0)

const rect = reactive({ x: 0, y: 0, w: 640, h: 360 })
let initialized = false

const localSource = computed(() => (
    state.media.sharing && state.media.screenStream
        ? {
            key: 'local',
            name: '你',
            stream: state.media.screenStream,
            local: true
        }
        : null
))

const remoteSources = computed(() => state.peers
    .filter((peer) => peer.screenSharing)
    .map((peer) => ({
        key: `peer:${peer.id}:${peer.screenStreamId || ''}`,
        name: peer.name,
        stream: peer.screenStream,
        local: false
    })))

const candidates = computed(() => {
    const list = []
    if (localSource.value) list.push(localSource.value)
    list.push(...remoteSources.value)
    return list
})

const visibleSources = computed(() => candidates.value.filter((item) => item.key !== hiddenKey.value))

const source = computed(() => {
    const list = visibleSources.value
    if (!list.length) return null
    return list[focusIndex.value % list.length]
})

const hiddenSource = computed(() => (
    candidates.value.find((item) => item.key === hiddenKey.value) || null
))

const stageStyle = computed(() => ({
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.w}px`,
    height: `${rect.h}px`
}))

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max))
}

function initRect() {
    if (initialized) return
    initialized = true
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const width = Math.round(Math.min(760, Math.max(360, viewportWidth * 0.46)))
    const height = Math.round(width * 9 / 16)
    rect.w = Math.min(width, viewportWidth - 24)
    rect.h = Math.min(height, viewportHeight - 150)
    rect.x = Math.max(12, viewportWidth - rect.w - 28)
    rect.y = Math.max(76, viewportHeight - rect.h - 112)
}

function attachVideo() {
    if (video.value) {
        video.value.srcObject = source.value?.stream || null
        video.value.play?.().catch(() => {})
    }
}

async function refreshVideo() {
    await nextTick()
    attachVideo()
}

watch(() => source.value?.stream, refreshVideo)
watch(() => source.value?.key, () => {
    maximized.value = false
    immersive.value = false
    focusIndex.value = 0
    refreshVideo()
})
watch(() => candidates.value.map((item) => item.key).join('|'), () => {
    if (!candidates.value.some((item) => item.key === hiddenKey.value)) {
        hiddenKey.value = ''
    }
})

function startDrag(event) {
    if (maximized.value || immersive.value) return
    event.preventDefault()
    const start = {
        x: event.clientX,
        y: event.clientY,
        left: rect.x,
        top: rect.y
    }
    const move = (moveEvent) => {
        rect.x = clamp(start.left + moveEvent.clientX - start.x, 0, window.innerWidth - rect.w)
        rect.y = clamp(start.top + moveEvent.clientY - start.y, 68, window.innerHeight - rect.h - 8)
    }
    const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
}

function startResize(event) {
    if (maximized.value) return
    event.preventDefault()
    const start = {
        x: event.clientX,
        y: event.clientY,
        width: rect.w,
        height: rect.h
    }
    const move = (moveEvent) => {
        rect.w = clamp(
            start.width + moveEvent.clientX - start.x,
            320,
            window.innerWidth - rect.x - 8
        )
        rect.h = clamp(
            start.height + moveEvent.clientY - start.y,
            200,
            window.innerHeight - rect.y - 8
        )
    }
    const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
}

function toggleMax() {
    maximized.value = !maximized.value
    if (maximized.value) {
        immersive.value = false
    }
}

function toggleImmersive() {
    immersive.value = !immersive.value
    if (immersive.value) {
        maximized.value = false
    }
}

function closeStage() {
    if (source.value?.local) {
        actions.stopScreenShare()
    } else {
        hiddenKey.value = source.value?.key || ''
        maximized.value = false
        immersive.value = false
    }
}

function restoreStage() {
    hiddenKey.value = ''
    maximized.value = false
    immersive.value = false
    refreshVideo()
}

function onKeydown(event) {
    if (event.key === 'Escape' && immersive.value) {
        immersive.value = false
    }
}

function onResize() {
    rect.w = Math.min(rect.w, window.innerWidth - rect.x - 8)
    rect.h = Math.min(rect.h, window.innerHeight - rect.y - 8)
    rect.x = clamp(rect.x, 0, window.innerWidth - rect.w)
    rect.y = clamp(rect.y, 68, window.innerHeight - rect.h - 8)
}

onMounted(() => {
    initRect()
    refreshVideo()
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('resize', onResize)
})
</script>
