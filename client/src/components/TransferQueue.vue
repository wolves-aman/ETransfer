<template>
    <Teleport to="body">
        <Transition name="modal" appear>
            <div v-if="open" class="drawer-veil" @click.self="$emit('close')"></div>
        </Transition>
        <Transition name="drawer" appear>
            <aside v-if="open" class="drawer">
                <div class="drawer-head">
                    <AppIcon name="upload" />
                    <strong>传输队列</strong>
                    <span class="mono-label">{{ items.length }} ITEMS</span>
                    <button class="drawer-close" type="button" aria-label="关闭" @click="$emit('close')">
                        <AppIcon name="x" />
                    </button>
                </div>

                <div class="drawer-body">
                    <div v-if="!items.length" class="queue-empty">
                        <AppIcon name="upload" />
                        <span>队列为空，拖入文件或从聊天框发送。</span>
                    </div>

                    <div v-for="item in items" :key="item.id" class="queue-item">
                        <div class="queue-head">
                            <span class="queue-ico"><AppIcon name="file" /></span>
                            <div class="queue-main">
                                <strong>{{ item.name }}</strong>
                                <small>
                                    {{ formatBytes(item.size) }}
                                    <template v-if="item.parts.length"> · {{ item.parts.length }} 个对端</template>
                                    · {{ statusLabel(item) }}
                                </small>
                            </div>
                            <div class="queue-actions">
                                <button
                                    v-if="item.status === 'active'"
                                    type="button"
                                    title="暂停"
                                    @click="$emit('pause', item)"
                                ><AppIcon name="pause" /></button>
                                <button
                                    v-if="item.status === 'paused'"
                                    type="button"
                                    title="继续"
                                    @click="$emit('resume', item)"
                                ><AppIcon name="play" /></button>
                                <button
                                    v-if="!['done', 'canceled', 'error', 'relayed'].includes(item.status)"
                                    type="button"
                                    title="取消"
                                    @click="$emit('cancel', item)"
                                ><AppIcon name="x" /></button>
                            </div>
                        </div>

                        <div class="queue-progress">
                            <div class="progress">
                                <i :style="{ width: `${progressOf(item)}%` }"></i>
                            </div>
                            <div class="queue-stats">
                                <span>{{ formatBytes(item.sentBytes) }} / {{ formatBytes(item.size) }}</span>
                                <span v-if="item.status === 'active'">
                                    <b>{{ formatSpeed(item.speed) }}</b> · {{ item.eta ? formatDuration(item.eta) : '--' }}
                                </span>
                                <span v-else>{{ progressOf(item) }}%</span>
                            </div>
                        </div>

                        <div v-if="item.error" class="queue-error">{{ item.error }}</div>

                        <div v-if="item.status === 'error'" class="queue-relay">
                            <AppIcon name="alert" />
                            <span>P2P 未成功，可改用服务器中转</span>
                            <button
                                type="button"
                                :disabled="item.relay?.status === 'uploading'"
                                @click="$emit('relay', item)"
                            >
                                {{ item.relay?.status === 'uploading' ? `上传 ${item.relay.progress}%` : '上传中转' }}
                            </button>
                        </div>

                        <div v-if="item.status === 'relayed'" class="queue-relay">
                            <AppIcon name="check" />
                            <span>已通过服务器中转，下载链接已发送</span>
                        </div>
                    </div>
                </div>

                <div class="drawer-foot">
                    <p class="panel-note" style="margin: 0">
                        传输直接走 P2P DataChannel；只有你手动选择「上传中转」时才会经过服务器。
                    </p>
                </div>
            </aside>
        </Transition>
    </Teleport>
</template>

<script setup>
import AppIcon from './AppIcon.vue'
import {
    formatBytes,
    formatDuration,
    formatSpeed
} from '../lib/format'

defineProps({
    open: { type: Boolean, default: false },
    items: { type: Array, default: () => [] }
})

defineEmits(['close', 'pause', 'resume', 'cancel', 'relay'])

function progressOf(item) {
    if (item.status === 'done' || item.status === 'relayed') return 100
    if (item.status === 'canceled') return item.progress || 0
    return Math.min(100, Math.round(item.progress || 0))
}

function statusLabel(item) {
    const map = {
        queued: '排队中',
        active: '传输中',
        paused: '已暂停',
        done: '已完成',
        canceled: '已取消',
        error: '失败',
        relayed: '已中转'
    }
    return map[item.status] || item.status
}
</script>

<style scoped>
.drawer-enter-active,
.drawer-leave-active {
    transition: transform .3s cubic-bezier(.22, 1, .36, 1), opacity .2s;
}
.drawer-enter-from,
.drawer-leave-to {
    transform: translateX(40px);
    opacity: 0;
}
</style>
