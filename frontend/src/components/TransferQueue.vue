<template>
    <Teleport to="body">
        <Transition name="modal" appear>
            <div v-if="open" class="drawer-veil" @click.self="$emit('close')"></div>
        </Transition>
        <Transition name="drawer" appear>
            <aside v-if="open" class="drawer">
                <div class="drawer-head">
                    <AppIcon name="upload" />
                    <strong>{{ t('传输队列') }}</strong>
                    <span class="mono-label">{{ items.length }} ITEMS</span>
                    <button class="drawer-close" type="button" :aria-label="t('关闭')" @click="$emit('close')">
                        <AppIcon name="x" />
                    </button>
                </div>

                <div class="drawer-body">
                    <div v-if="!items.length" class="queue-empty">
                        <AppIcon name="upload" />
                        <span>{{ t('队列为空，拖入文件或从聊天框发送。') }}</span>
                    </div>

                    <div v-for="item in items" :key="item.id" class="queue-item">
                        <div class="queue-head">
                            <span class="queue-ico"><AppIcon name="file" /></span>
                            <div class="queue-main">
                                <strong>{{ item.name }}</strong>
                                <small>
                                    {{ formatBytes(item.size) }}
                                    <template v-if="item.parts.length"> · {{ t('{n} 个对端', { n: item.parts.length }) }}</template>
                                    · {{ statusLabel(item) }}
                                </small>
                            </div>
                            <div class="queue-actions">
                                <button
                                    v-if="item.status === 'active'"
                                    type="button"
                                    :title="t('暂停')"
                                    @click="$emit('pause', item)"
                                ><AppIcon name="pause" /></button>
                                <button
                                    v-if="item.status === 'paused'"
                                    type="button"
                                    :title="t('继续')"
                                    @click="$emit('resume', item)"
                                ><AppIcon name="play" /></button>
                                <button
                                    v-if="!['done', 'canceled', 'error'].includes(item.status)"
                                    type="button"
                                    :title="t('取消')"
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
                    </div>
                </div>

                <div class="drawer-foot">
                    <p class="panel-note" style="margin: 0">
                        {{ t('传输全部走 WebRTC DataChannel，不经过服务器。') }}
                    </p>
                </div>
            </aside>
        </Transition>
    </Teleport>
</template>

<script setup>
import AppIcon from './AppIcon.vue'
import { t } from '../lib/i18n'
import {
    formatBytes,
    formatDuration,
    formatSpeed
} from '../lib/format'

defineProps({
    open: { type: Boolean, default: false },
    items: { type: Array, default: () => [] }
})

defineEmits(['close', 'pause', 'resume', 'cancel'])

function progressOf(item) {
    if (item.status === 'done') return 100
    if (item.status === 'canceled') return item.progress || 0
    return Math.min(100, Math.round(item.progress || 0))
}

function statusLabel(item) {
    const map = {
        queued: t('排队中'),
        active: t('传输中'),
        paused: t('已暂停'),
        done: t('已完成'),
        canceled: t('已取消'),
        error: t('失败')
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
