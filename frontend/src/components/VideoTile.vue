<template>
    <div class="media-tile" :class="{ local, screen }">
        <video ref="video" autoplay playsinline :muted="muted"></video>
        <span v-if="!hasVideo" class="video-fallback">{{ fallback }}</span>
        <span class="media-label">{{ label }}</span>
    </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps({
    stream: { type: Object, default: null },
    label: { type: String, default: '' },
    muted: { type: Boolean, default: false },
    local: { type: Boolean, default: false },
    screen: { type: Boolean, default: false },
    fallback: { type: String, default: 'ET' }
})

const video = ref(null)

const hasVideo = computed(() => Boolean(props.stream?.getVideoTracks?.().length))

function attach() {
    if (video.value && props.stream) {
        video.value.srcObject = props.stream
        video.value.play?.().catch(() => {})
    }
}

onMounted(attach)
watch(() => props.stream, attach)
</script>

<style scoped>
.video-fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-family: var(--mono);
    font-size: 20px;
    color: rgba(84, 255, 168, .6);
    background:
        radial-gradient(circle at 50% 40%, rgba(84, 255, 168, .12), transparent 55%),
        #04110b;
}
</style>
