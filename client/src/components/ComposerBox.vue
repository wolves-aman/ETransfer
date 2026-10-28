<template>
    <div class="composer">
        <p v-if="!canSend" class="composer-warning">
            正在建立 P2P 数据通道，消息会在通道就绪后可用。
        </p>
        <div class="composer-box">
            <textarea
                ref="input"
                v-model="text"
                rows="1"
                :placeholder="canSend ? '输入消息，支持 Markdown / 代码块，或把文件拖进来…' : '等待通道建立…'"
                :disabled="!canSend"
                @keydown.enter.exact.prevent="send"
                @keydown.enter.shift.exact.prevent="newline"
                @input="resize"
                @paste="onPaste"
            ></textarea>
            <div class="composer-bar">
                <button class="icon-btn tip" type="button" data-tip="发送文件" :disabled="!canSend" @click="$emit('pick', 'file')">
                    <AppIcon name="paperclip" />
                </button>
                <button class="icon-btn tip" type="button" data-tip="发送图片" :disabled="!canSend" @click="$emit('pick', 'image')">
                    <AppIcon name="image" />
                </button>
                <button class="icon-btn tip" type="button" data-tip="发送文件夹" :disabled="!canSend" @click="$emit('pick', 'folder')">
                    <AppIcon name="folder" />
                </button>
                <button class="icon-btn tip" type="button" data-tip="共享屏幕" :disabled="!canSend" @click="$emit('screen')">
                    <AppIcon name="monitor" />
                </button>
                <span class="composer-hint">ENTER 发送 · SHIFT+ENTER 换行</span>
                <button class="send-btn" type="button" aria-label="发送" :disabled="!canSend || !text.trim()" @click="send">
                    <AppIcon name="send" />
                </button>
            </div>
        </div>
        <div class="composer-foot">
            <span>支持 MARKDOWN / 代码块 / 粘贴图片</span>
            <span><AppIcon name="lock" /> 端到端加密</span>
        </div>
    </div>
</template>

<script setup>
import { nextTick, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
    canSend: {
        type: Boolean,
        default: false
    }
})

const emit = defineEmits(['send', 'pick', 'screen', 'paste-files'])
const text = ref('')
const input = ref(null)

function resize() {
    const element = input.value
    if (!element) return
    element.style.height = '38px'
    element.style.height = `${Math.min(130, element.scrollHeight)}px`
}

function send() {
    const value = text.value.trim()
    if (!value || !props.canSend) return
    emit('send', value)
    text.value = ''
    nextTick(() => {
        resize()
        input.value?.focus()
    })
}

function newline() {
    const element = input.value
    if (!element) return
    const start = element.selectionStart
    const end = element.selectionEnd
    const value = element.value
    text.value = `${value.slice(0, start)}\n${value.slice(end)}`
    nextTick(() => {
        element.selectionStart = element.selectionEnd = start + 1
        resize()
    })
}

function onPaste(event) {
    const files = [...(event.clipboardData?.files || [])]
    if (!files.length) return
    event.preventDefault()
    emit('paste-files', files)
}
</script>
