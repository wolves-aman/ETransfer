<template>
    <div v-if="message.type === 'system'" class="sys">
        <AppIcon name="info" />
        {{ message.text }}
        <time>{{ time }}</time>
    </div>

    <div v-else class="msg" :class="{ me: mine }">
        <div v-if="!mine" class="av">{{ initials(message.fromName) }}</div>
        <div class="msg-body">
            <div v-if="!mine" class="msg-name">{{ message.fromName || '成员' }}</div>

            <template v-if="message.revoked">
                <div class="bubble">
                    <span class="revoked-text">消息已撤回</span>
                </div>
            </template>

            <template v-else-if="message.type === 'text'">
                <div class="bubble md">
                    <div class="md-content" v-html="html"></div>
                    <a
                        v-if="preview"
                        class="link-preview"
                        :href="linkUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <img
                            v-if="preview.image"
                            :src="preview.image"
                            alt=""
                            loading="lazy"
                            @error="$event.target.style.display = 'none'"
                        >
                        <div>
                            <strong>{{ preview.title || preview.site }}</strong>
                            <small v-if="preview.description">{{ preview.description }}</small>
                            <em>{{ preview.site }}</em>
                        </div>
                    </a>
                    <div v-if="mine" class="msg-actions">
                        <button type="button" title="复制" @click="copy"><AppIcon name="copy" /></button>
                        <button type="button" title="撤回" @click="$emit('recall', message.id)"><AppIcon name="trash" /></button>
                    </div>
                </div>
            </template>

            <template v-else-if="message.type === 'image'">
                <div class="bubble image-bubble">
                    <button type="button" @click="$emit('open-image', message)">
                        <div class="shot">
                            <img :src="message.image" alt="图片消息" loading="lazy">
                        </div>
                    </button>
                    <div v-if="mine" class="msg-actions">
                        <button type="button" title="撤回" @click="$emit('recall', message.id)"><AppIcon name="trash" /></button>
                    </div>
                </div>
            </template>

            <template v-else-if="message.type === 'file'">
                <div class="bubble">
                    <div class="file-card">
                        <div class="file-ico"><AppIcon name="file" /></div>
                        <div class="file-body">
                            <div class="file-name">{{ message.file.name }}</div>
                            <div class="file-meta">
                                <span>{{ formatBytes(message.file.size) }}</span>
                                <span :class="{ canceled: message.file.canceled }">{{ statusText }}</span>
                            </div>
                            <div class="progress">
                                <i :style="{ width: `${filePercent}%` }"></i>
                            </div>
                            <div class="file-status">
                                <span>{{ formatBytes(message.file.received) }} / {{ formatBytes(message.file.size) }}</span>
                                <span v-if="message.file.error" class="canceled">{{ message.file.error }}</span>
                                <span v-else-if="message.file.complete && canDownload">已接收</span>
                                <span v-else-if="message.file.complete">已完成</span>
                                <span v-else>接收中</span>
                            </div>
                        </div>
                        <button
                            class="file-dl"
                            type="button"
                            :aria-label="canDownload ? '保存文件' : '文件尚未接收完成'"
                            :title="canDownload ? '保存到本地' : '文件尚未接收完成'"
                            :disabled="!canDownload"
                            @click="download"
                        >
                            <AppIcon name="download" />
                        </button>
                    </div>
                </div>
            </template>

            <div class="msg-meta">
                {{ time }}
                <AppIcon v-if="mine && !message.revoked" name="check" />
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { formatBytes, formatTime, initials, percent } from '../lib/format'
import { renderMarkdown, findFirstUrl } from '../lib/markdown'
import { getLinkPreview } from '../lib/link-preview'
import { saveReceivedFile } from '../lib/download'
import { copyText } from '../lib/clipboard'
import { toast } from '../lib/feedback'
import { state } from '../store'

const props = defineProps({
    message: {
        type: Object,
        required: true
    }
})

defineEmits(['open-image', 'recall'])

const preview = ref(null)
const mine = computed(() => Boolean(props.message.mine || props.message.from === state.self.id))
const time = computed(() => formatTime(props.message.ts))
const html = computed(() => props.message.type === 'text' ? renderMarkdown(props.message.text) : '')
const linkUrl = computed(() => findFirstUrl(props.message.text || ''))

const filePercent = computed(() => {
    const file = props.message.file
    if (!file) return 0
    if (file.complete) return 100
    return percent(file.received || 0, file.size || 1)
})

const statusText = computed(() => {
    const file = props.message.file
    if (!file) return ''
    if (file.canceled) return '已取消'
    if (file.complete) return '100%'
    return `${filePercent.value}%`
})

const canDownload = computed(() => Boolean(
    props.message.file?.blob || props.message.file?.opfsPath
))

async function loadPreview() {
    if (props.message.type !== 'text' || props.message.revoked) return
    const url = linkUrl.value
    if (!url) return
    preview.value = await getLinkPreview(url)
}

async function download() {
    const file = props.message.file
    if (!file || !canDownload.value) {
        toast.warn('文件尚未接收完成', '等传输结束后再保存')
        return
    }
    try {
        await saveReceivedFile(file)
        toast.success('文件已保存', file.name)
    } catch (error) {
        if (error.name === 'AbortError') return
        toast.error('保存失败', error.message)
    }
}

async function copy() {
    const ok = await copyText(props.message.text || '')
    if (ok) toast.success('已复制')
}

onMounted(loadPreview)
watch(() => [props.message.text, props.message.revoked], loadPreview)
</script>
