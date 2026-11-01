<template>
    <Teleport to="body">
        <Transition name="modal" appear>
            <div v-if="open" class="drawer-veil" @click.self="$emit('close')"></div>
        </Transition>
        <Transition name="drawer" appear>
            <aside v-if="open" class="drawer">
                <div class="drawer-head">
                    <AppIcon name="terminal" />
                    <strong>房间日志</strong>
                    <span class="mono-label">ROOM ONLY</span>
                    <button class="drawer-close" type="button" aria-label="关闭" @click="$emit('close')">
                        <AppIcon name="x" />
                    </button>
                </div>

                <div class="drawer-body" ref="scroller">
                    <div class="log-toolbar">
                        <button
                            v-for="level in levels"
                            :key="level.value"
                            type="button"
                            class="log-filter"
                            :class="{ on: filter === level.value }"
                            @click="filter = level.value"
                        >{{ level.label }}</button>
                        <span class="spacer"></span>
                        <button type="button" @click="exportLogs">导出</button>
                        <button type="button" @click="clear">清空</button>
                    </div>

                    <div v-if="!filtered.length" class="logs-empty">
                        暂无日志。连接、信令、传输和媒体事件都会出现在这里。
                    </div>

                    <div v-else class="log-list">
                        <div v-for="entry in filtered" :key="entry.id" class="log-line">
                            <time>{{ clock(entry.ts) }}</time>
                            <span class="log-level" :class="entry.level">{{ entry.level }}</span>
                            <span class="log-scope">{{ entry.scope }}</span>
                            <span class="log-message">
                                {{ entry.message }}
                                <span v-if="entry.data" class="log-data">{{ entry.data }}</span>
                            </span>
                        </div>
                    </div>
                </div>

                <div class="drawer-foot">
                    <p class="panel-note" style="margin: 0">
                        日志仅保存在当前页面内存中，关闭页面即清空。它只会在房间界面出现。
                    </p>
                </div>
            </aside>
        </Transition>
    </Teleport>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { logState, log } from '../lib/logger'

const props = defineProps({
    open: { type: Boolean, default: false }
})

defineEmits(['close'])

const filter = ref('all')
const scroller = ref(null)
const levels = [
    { value: 'all', label: 'ALL' },
    { value: 'info', label: 'INFO' },
    { value: 'warn', label: 'WARN' },
    { value: 'error', label: 'ERR' },
    { value: 'debug', label: 'DBG' }
]

const filtered = computed(() => {
    if (filter.value === 'all') return logState.entries
    return logState.entries.filter((entry) => entry.level === filter.value)
})

function clock(ts) {
    const date = new Date(ts)
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
    })
}

function exportLogs() {
    const blob = new Blob([log.exportText()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `etransfer-log-${Date.now()}.txt`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function clear() {
    log.clear()
}

watch(() => [props.open, filtered.value.length], async () => {
    if (!props.open) return
    await nextTick()
    if (scroller.value) {
        scroller.value.scrollTop = scroller.value.scrollHeight
    }
})
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
