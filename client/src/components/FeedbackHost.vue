<template>
    <Teleport to="body">
        <div class="toast-host" aria-live="polite" aria-atomic="false">
            <TransitionGroup name="toast">
                <div
                    v-for="item in feedback.toasts"
                    :key="item.id"
                    class="toast"
                    :class="item.type"
                >
                    <span class="toast-ic">
                        <AppIcon :name="item.icon" />
                    </span>
                    <div class="toast-copy">
                        <strong>{{ item.title }}</strong>
                        <small v-if="item.message">{{ item.message }}</small>
                    </div>
                    <button class="toast-close" aria-label="关闭提示" @click="dismissToast(item.id)">
                        <AppIcon name="x" />
                    </button>
                    <span
                        v-if="item.duration > 0"
                        class="toast-bar"
                        :style="{ animationDuration: `${item.duration}ms` }"
                    ></span>
                </div>
            </TransitionGroup>
        </div>

        <Transition name="modal">
            <div v-if="feedback.dialog" class="dialog-veil feedback-veil" @click.self="settleDialog(false)">
                <div class="dialog-card" role="dialog" aria-modal="true">
                    <div class="dialog-head">
                        <span class="dialog-ic" :class="feedback.dialog.tone">
                            <AppIcon :name="feedback.dialog.tone === 'error' ? 'alert' : 'shield'" />
                        </span>
                        <span class="mono-label">CONFIRM</span>
                    </div>
                    <h3>{{ feedback.dialog.title }}</h3>
                    <p>{{ feedback.dialog.message }}</p>
                    <div class="dialog-actions">
                        <button
                            v-if="feedback.dialog.cancelText !== null"
                            class="btn ghost sm"
                            @click="settleDialog(false)"
                        >
                            {{ feedback.dialog.cancelText }}
                        </button>
                        <button class="btn primary sm" @click="settleDialog(true)">
                            {{ feedback.dialog.confirmText }}
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup>
import AppIcon from './AppIcon.vue'
import { feedback, dismissToast, settleDialog } from '../lib/feedback'
</script>
