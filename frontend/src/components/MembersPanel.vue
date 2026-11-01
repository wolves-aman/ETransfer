<template>
    <div class="peer-list">
        <div class="peer-row">
            <span class="peer-avatar">{{ initials(selfName) }}</span>
            <div class="peer-main">
                <strong>
                    {{ selfName || '我' }}
                    <span v-if="selfIsHost" class="host-tag">HOST</span>
                </strong>
                <small><i></i> 本机 · {{ selfIsHost ? '房主' : '成员' }}</small>
            </div>
        </div>

        <div v-for="peer in peers" :key="peer.id" class="peer-row">
            <span class="peer-avatar remote">{{ initials(peer.name) }}</span>
            <div class="peer-main">
                <strong>
                    {{ peer.name }}
                    <span v-if="peer.isHost" class="host-tag">HOST</span>
                </strong>
                <small>
                    <i :class="{ off: !peer.chatReady }"></i>
                    {{ peer.chatReady ? '已连接' : (peer.connected ? '正在加密' : '连接中…') }}
                </small>
            </div>
            <button
                v-if="selfIsHost && !peer.isHost"
                class="peer-kick"
                type="button"
                title="移除成员"
                @click="$emit('kick', peer.id)"
            >
                <AppIcon name="x" />
            </button>
        </div>
    </div>
</template>

<script setup>
import AppIcon from './AppIcon.vue'
import { initials } from '../lib/format'

defineProps({
    peers: { type: Array, default: () => [] },
    selfName: { type: String, default: '' },
    selfIsHost: { type: Boolean, default: false }
})

defineEmits(['kick'])
</script>
