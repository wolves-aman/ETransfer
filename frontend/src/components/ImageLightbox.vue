<template>
    <Teleport to="body">
        <Transition name="modal" appear>
            <div v-if="current" class="lightbox" @click.self="$emit('close')">
                <img :src="current.src" :alt="`图片 ${index + 1}`">
                <button class="lightbox-close" type="button" aria-label="关闭" @click="$emit('close')">
                    <AppIcon name="x" />
                </button>
                <button
                    v-if="images.length > 1"
                    class="lightbox-prev"
                    type="button"
                    aria-label="上一张"
                    @click="$emit('update:index', (index - 1 + images.length) % images.length)"
                >
                    <AppIcon name="chevron-left" />
                </button>
                <button
                    v-if="images.length > 1"
                    class="lightbox-next"
                    type="button"
                    aria-label="下一张"
                    @click="$emit('update:index', (index + 1) % images.length)"
                >
                    <AppIcon name="chevron-right" />
                </button>
                <span class="lightbox-counter">{{ index + 1 }} / {{ images.length }} · {{ current.fromName }}</span>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
    images: { type: Array, default: () => [] },
    index: { type: Number, default: 0 }
})

const emit = defineEmits(['close', 'update:index'])

const current = computed(() => props.images[props.index] || null)

function onKey(event) {
    if (!current.value) return
    if (event.key === 'Escape') emit('close')
    if (event.key === 'ArrowLeft' && props.images.length > 1) {
        emit('update:index', (props.index - 1 + props.images.length) % props.images.length)
    }
    if (event.key === 'ArrowRight' && props.images.length > 1) {
        emit('update:index', (props.index + 1) % props.images.length)
    }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>
