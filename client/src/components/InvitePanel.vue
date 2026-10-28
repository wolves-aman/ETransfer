<template>
    <Teleport to="body">
        <Transition name="modal" appear>
            <div class="dialog-veil" @click.self="$emit('close')">
                <div class="dialog-card invite-card">
                    <div class="invite-head">
                        <AppIcon name="qr" />
                        <strong>邀请成员</strong>
                        <button class="drawer-close" style="margin-left: auto" type="button" @click="$emit('close')">
                            <AppIcon name="x" />
                        </button>
                    </div>

                    <div class="invite-body">
                        <div class="qr-wrap">
                            <img v-if="qrData" :src="qrData" alt="房间邀请二维码">
                        </div>

                        <div class="code-display">{{ groupedCode }}</div>
                        <p class="panel-note" style="text-align: center">
                            扫码或打开链接加入，链接只在房间有效期内可用。
                        </p>

                        <div class="copy-link-box">
                            <span>{{ link }}</span>
                            <button type="button" @click="copyLink">{{ copied.link ? '已复制' : '复制' }}</button>
                        </div>
                        <div v-if="room.password" class="invite-password">
                            <AppIcon name="key" />
                            房间密码：{{ room.password }}
                            <button type="button" class="copy-inline" @click="copyPassword">
                                {{ copied.password ? '已复制' : '复制' }}
                            </button>
                        </div>

                        <div class="invite-note">
                            <AppIcon name="shield" />
                            <span>
                                {{ room.oneTime ? '一次性房间：成员离开后立即销毁。' : '端到端加密：文件不经过服务器，只在本房间成员之间直连。' }}
                                <template v-if="room.expiresAt"> 有效期剩余 {{ expiresText }}。</template>
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import QRCode from 'qrcode'
import AppIcon from './AppIcon.vue'
import { copyText } from '../lib/clipboard'
import { formatCountdown, groupCode } from '../lib/format'
import { state } from '../store'

const props = defineProps({
    room: { type: Object, required: true },
    link: { type: String, required: true }
})

defineEmits(['close'])

const qrData = ref('')
const copied = reactive({ link: false, password: false })
const groupedCode = computed(() => groupCode(props.room.id))
const expiresText = computed(() => {
    if (!props.room.expiresAt) return '永久'
    if (props.room.expiresAt <= state.now) return '已过期'
    return formatCountdown(props.room.expiresAt - state.now)
})

async function renderQr() {
    try {
        qrData.value = await QRCode.toDataURL(props.link, {
            width: 520,
            margin: 1,
            errorCorrectionLevel: 'M',
            color: { dark: '#03140b', light: '#54ffa8' }
        })
    } catch {
        qrData.value = ''
    }
}

function flash(key) {
    copied[key] = true
    setTimeout(() => {
        copied[key] = false
    }, 1400)
}

async function copyLink() {
    if (await copyText(props.link)) flash('link')
}

async function copyPassword() {
    if (await copyText(props.room.password)) flash('password')
}

onMounted(renderQr)
watch(() => props.link, renderQr)
</script>
