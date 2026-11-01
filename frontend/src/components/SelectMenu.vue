<template>
    <div ref="root" class="select-menu" :class="{ disabled, open }">
        <button
            ref="trigger"
            type="button"
            class="select-trigger"
            :disabled="disabled"
            :aria-expanded="open"
            aria-haspopup="listbox"
            @click="toggle"
        >
            <span>{{ selectedLabel }}</span>
            <i class="select-caret" aria-hidden="true"></i>
        </button>

        <Teleport to="body">
            <Transition name="select-pop">
                <div
                    v-if="open"
                    class="select-pop"
                    :class="{ mobile: mobile }"
                    :style="popStyle"
                >
                    <div class="select-pop-head" v-if="mobile">
                        <span>{{ label }}</span>
                        <button type="button" @click="close">✕</button>
                    </div>
                    <ul role="listbox">
                        <li
                            v-for="option in options"
                            :key="option.value"
                            role="option"
                            :aria-selected="option.value === modelValue"
                            :class="{ active: option.value === modelValue }"
                            @click="choose(option)"
                        >
                            <span>{{ option.label }}</span>
                            <AppIcon v-if="option.value === modelValue" name="check" />
                        </li>
                    </ul>
                </div>
            </Transition>
        </Teleport>
    </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
    modelValue: { type: [Number, String], default: '' },
    options: { type: Array, default: () => [] },
    label: { type: String, default: '' },
    disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const root = ref(null)
const trigger = ref(null)
const open = ref(false)
const mobile = ref(false)
const popStyle = ref({})

const selectedLabel = computed(() => {
    const found = props.options.find((item) => item.value === props.modelValue)
    return found?.label || ''
})

function toggle() {
    if (props.disabled) return
    open.value ? close() : show()
}

async function show() {
    mobile.value = window.innerWidth <= 640
    open.value = true
    await nextTick()
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKeydown)
}

function position() {
    if (mobile.value) {
        popStyle.value = {}
        return
    }
    const rect = trigger.value?.getBoundingClientRect()
    if (!rect) return
    const width = Math.max(rect.width, 150)
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 220 && rect.top > spaceBelow
    popStyle.value = {
        width: `${width}px`,
        left: `${Math.min(rect.left, window.innerWidth - width - 10)}px`,
        top: openUp ? 'auto' : `${rect.bottom + 8}px`,
        bottom: openUp ? `${window.innerHeight - rect.top + 8}px` : 'auto'
    }
}

function choose(option) {
    if (option.value !== props.modelValue) {
        emit('update:modelValue', option.value)
    }
    close()
}

function close() {
    if (!open.value) return
    open.value = false
    window.removeEventListener('resize', position)
    window.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKeydown)
}

function onScroll(event) {
    if (event.target === root.value) return
    close()
}

function onOutside(event) {
    if (!root.value?.contains(event.target)) close()
}

function onKeydown(event) {
    if (event.key === 'Escape') {
        close()
        trigger.value?.focus()
    }
}

watch(() => props.disabled, (value) => {
    if (value) close()
})

onBeforeUnmount(close)
</script>
