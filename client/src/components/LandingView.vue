<template>
    <section class="screen landing">
        <div class="screen-bg" aria-hidden="true">
            <i class="glow g1"></i><i class="glow g2"></i><i class="glow g3"></i>
            <div class="scan"></div>
        </div>

        <header class="topbar">
            <a class="brand" href="#" @click.prevent>
                <BrandMark />
                <span class="brand-name">ETRANSFER</span>
                <span class="brand-beta">BETA</span>
            </a>
            <nav class="topnav">
                <a href="#features">端到端加密</a>
                <a href="#features">无需安装</a>
                <a href="https://github.com/wolves-aman/ETransfer" target="_blank" rel="noreferrer">
                    GITHUB <AppIcon name="external" />
                </a>
            </nav>
            <div class="net-pill" :class="state.connection">
                <i class="dot"></i>
                {{ connectionLabel }}
                <button v-if="state.connection === 'offline'" @click="actions.retryConnection()">重试</button>
            </div>
        </header>

        <main class="landing-main">
            <div class="hero">
                <div class="eyebrow"><span class="eyebrow-line"></span> PEER-TO-PEER / NO CLOUD / NO TRACE</div>
                <h1>文件不落地，<br><span class="grad-text">直达</span>对方屏幕<span class="cursor"></span></h1>
                <p class="lede">基于 WebRTC 的点对点传输。文件、图片、语音与屏幕画面在两端之间加密直连，服务器只负责牵线，不保存任何内容。</p>

                <div class="hero-facts">
                    <div class="fact"><strong>0<small>KB</small></strong><span>云端留存</span></div>
                    <div class="fact"><strong>8<small>PEERS</small></strong><span>Mesh 房间</span></div>
                    <div class="fact"><strong>∞<small>SIZE</small></strong><span>文件大小</span></div>
                </div>

                <div class="chips" id="features">
                    <span class="chip"><AppIcon name="zap" /> WebRTC 直连</span>
                    <span class="chip"><AppIcon name="lock" /> DTLS 加密</span>
                    <span class="chip"><AppIcon name="users" /> 多人 Mesh</span>
                    <span class="chip"><AppIcon name="shield" /> 房间密码</span>
                    <span class="chip"><AppIcon name="clock" /> 有效期 / 一次性</span>
                </div>
            </div>

            <div class="portal">
                <div class="orbit o1"><i></i></div>
                <div class="orbit o2"><i></i></div>
                <div class="orbit o3"></div>
                <span class="float-tag t1">DTLS 1.2</span>
                <span class="float-tag t3">WEBRTC / SCTP</span>

                <form class="create-card" @submit.prevent="submit">
                    <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
                    <div class="card-head">
                        <span class="mono-label">{{ mode === 'create' ? 'NEW CHANNEL' : 'JOIN CHANNEL' }}</span>
                        <span class="secure"><AppIcon name="lock" /> END-TO-END</span>
                    </div>

                    <div class="mode-switch">
                        <button type="button" :class="{ on: mode === 'create' }" @click="switchMode('create')">创建通道</button>
                        <button type="button" :class="{ on: mode === 'join' }" @click="switchMode('join')">加入通道</button>
                    </div>

                    <h2>{{ mode === 'create' ? '建立传输通道' : '进入传输通道' }}</h2>
                    <p class="card-sub">
                        {{ mode === 'create'
                            ? '生成一条一次性邀请链接，对方打开即可进入同一通道。'
                            : '输入对方发来的短码，如果房间设置了密码请一并填写。' }}
                    </p>

                    <div class="form-stack" style="margin-top: 18px">
                        <div>
                            <label class="compact-label" for="name">你的昵称 <span>最多 24 字</span></label>
                            <div class="input-shell small">
                                <AppIcon name="user" />
                                <input id="name" v-model="form.name" maxlength="24" placeholder="例如 Aman" autocomplete="nickname">
                            </div>
                        </div>

                        <div>
                            <label class="compact-label" for="code">
                                房间短码
                                <span>{{ mode === 'create' ? '留空自动生成' : '必填' }}</span>
                            </label>
                            <div class="input-shell small">
                                <AppIcon name="hash" />
                                <input
                                    id="code"
                                    :value="form.code"
                                    maxlength="12"
                                    placeholder="例如 A7F3K2"
                                    autocomplete="off"
                                    spellcheck="false"
                                    @input="onCodeInput"
                                >
                                <button v-if="mode === 'create'" class="ghost-chip" type="button" @click="randomCode">随机</button>
                            </div>
                        </div>

                        <div v-if="mode === 'join'">
                            <label class="compact-label" for="join-password">房间密码 <span>没有则留空</span></label>
                            <div class="input-shell small">
                                <AppIcon name="key" />
                                <input
                                    id="join-password"
                                    v-model="form.password"
                                    type="password"
                                    maxlength="64"
                                    placeholder="房间密码"
                                    autocomplete="current-password"
                                >
                            </div>
                        </div>

                        <template v-if="mode === 'create'">
                            <button class="advanced-toggle" type="button" @click="advanced = !advanced">
                                <span>高级选项 · 密码 / 有效期 / 人数</span>
                                <AppIcon :name="advanced ? 'shrink' : 'expand'" />
                            </button>

                            <div v-if="advanced" class="advanced-panel">
                                <div class="switch-row">
                                    <div>
                                        <strong>设置房间密码</strong>
                                        <small>加入时需要输入密码</small>
                                    </div>
                                    <button
                                        class="switch"
                                        :class="{ on: form.usePassword }"
                                        type="button"
                                        :aria-pressed="form.usePassword"
                                        @click="form.usePassword = !form.usePassword"
                                    ></button>
                                </div>

                                <div v-if="form.usePassword">
                                    <div class="input-shell small">
                                        <AppIcon name="key" />
                                        <input
                                            v-model="form.password"
                                            type="password"
                                            maxlength="64"
                                            placeholder="至少 4 位字符"
                                            autocomplete="new-password"
                                        >
                                    </div>
                                </div>

                                <div class="form-row">
                                    <div>
                                        <label class="compact-label">有效期</label>
                                        <div class="select-shell">
                                            <select v-model.number="form.expiresIn">
                                                <option :value="0">永久</option>
                                                <option :value="30">30 分钟</option>
                                                <option :value="180">3 小时</option>
                                                <option :value="480">8 小时</option>
                                                <option :value="1440">24 小时</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div>
                                        <label class="compact-label">人数上限</label>
                                        <div class="select-shell">
                                            <select v-model.number="form.maxUsers" :disabled="form.oneTime">
                                                <option :value="2">2 人</option>
                                                <option :value="4">4 人</option>
                                                <option :value="6">6 人</option>
                                                <option :value="8">8 人</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                <div class="switch-row">
                                    <div>
                                        <strong>一次性房间</strong>
                                        <small>成员离开即销毁，不可重复使用</small>
                                    </div>
                                    <button
                                        class="switch"
                                        :class="{ on: form.oneTime }"
                                        type="button"
                                        :aria-pressed="form.oneTime"
                                        @click="form.oneTime = !form.oneTime"
                                    ></button>
                                </div>
                            </div>
                        </template>
                    </div>

                    <p v-if="error" class="error-line">{{ error }}</p>

                    <button class="btn primary" type="submit" :disabled="busy">
                        <AppIcon v-if="busy" name="refresh" class="spin" />
                        {{ busy ? '正在建立通道…' : (mode === 'create' ? '创建房间' : '加入房间') }}
                        <AppIcon v-if="!busy" name="arrow" />
                    </button>

                    <div class="join-line">
                        {{ mode === 'create' ? '已有房间号？' : '还没有房间？' }}
                        <a href="#" @click.prevent="switchMode(mode === 'create' ? 'join' : 'create')">
                            {{ mode === 'create' ? '直接加入' : '创建一个' }}
                        </a>
                    </div>

                    <div class="card-foot">
                        <span>{{ mode === 'create' ? '01' : '02' }} / 03</span>
                        <span class="foot-secure"><i></i> SECURE HANDSHAKE</span>
                    </div>
                </form>
            </div>
        </main>

        <footer class="screen-foot">
            <span>ETRANSFER / 2026</span>
            <span>FILES NEVER TOUCH THE CLOUD</span>
        </footer>
    </section>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import BrandMark from './BrandMark.vue'
import { state, actions } from '../store'

const mode = ref(state.initialCode ? 'join' : 'create')
const advanced = ref(false)
const busy = ref(false)
const error = ref('')

const form = reactive({
    name: state.name || '',
    code: state.initialCode || '',
    password: '',
    usePassword: false,
    expiresIn: 180,
    oneTime: false,
    maxUsers: 4
})

const connectionLabel = computed(() => {
    if (state.connection === 'online') return '信令节点在线'
    if (state.connection === 'connecting') return '正在连接信令…'
    if (state.connection === 'idle') return '信令按需连接'
    return '信令节点离线'
})

function switchMode(next) {
    mode.value = next
    error.value = ''
    if (next === 'join') {
        advanced.value = false
    }
}

function onCodeInput(event) {
    form.code = event.target.value
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 12)
    event.target.value = form.code
}

function randomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 6; i += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    form.code = code
}

async function submit() {
    error.value = ''
    const code = form.code.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase()

    if (mode.value === 'join' && code.length < 4) {
        error.value = '请输入至少 4 位房间短码。'
        return
    }
    if (mode.value === 'create' && code && (code.length < 4 || code.length > 12)) {
        error.value = '房间短码需要 4~12 位。'
        return
    }
    if (form.usePassword && mode.value === 'create' && form.password.length < 4) {
        error.value = '房间密码至少 4 位字符。'
        return
    }

    busy.value = true
    try {
        if (mode.value === 'create') {
            await actions.createRoom({
                code,
                password: form.usePassword ? form.password : '',
                expiresIn: form.expiresIn,
                oneTime: form.oneTime,
                maxUsers: form.oneTime ? 2 : form.maxUsers,
                name: form.name
            })
        } else {
            await actions.joinRoom({
                code,
                password: form.password,
                name: form.name
            })
        }
    } catch (err) {
        error.value = err.message || '操作失败，请稍后重试。'
    } finally {
        busy.value = false
    }
}
</script>
