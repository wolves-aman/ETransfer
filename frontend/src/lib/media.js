import { reactive } from 'vue'
import { log } from './logger'

export class MediaController {
    constructor({ mesh }) {
        this.mesh = mesh
        this.micStream = null
        this.cameraStream = null
        this.screenStream = null
        this.state = reactive({
            active: false,
            micOn: false,
            camOn: false,
            sharing: false,
            cameraStream: null,
            screenStream: null,
            error: ''
        })
    }

    markActive() {
        this.state.active = Boolean(
            this.state.micOn || this.state.camOn || this.state.sharing
        )
    }

    async ensureMic() {
        if (this.micStream) {
            this.state.micOn = true
            this.markActive()
            return
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        })
        this.micStream = stream
        for (const track of stream.getTracks()) {
            track.addEventListener('ended', () => {
                this.state.micOn = false
                this.micStream = null
                this.markActive()
            })
            this.mesh.addTrack(track, stream)
        }
        this.state.micOn = true
        this.markActive()
        log.info('media', '麦克风已开启')
    }

    async ensureCamera() {
        if (this.cameraStream) {
            this.state.camOn = true
            this.markActive()
            return
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            }
        })
        this.cameraStream = stream
        this.state.cameraStream = stream
        for (const track of stream.getTracks()) {
            track.addEventListener('ended', () => {
                this.state.camOn = false
                this.state.cameraStream = null
                this.cameraStream = null
                this.markActive()
            })
            this.mesh.addTrack(track, stream)
        }
        this.state.camOn = true
        this.markActive()
        log.info('media', '摄像头已开启')
    }

    async toggleMic() {
        try {
            if (!this.micStream) {
                await this.ensureMic()
                return
            }
            const enabled = !this.state.micOn
            for (const track of this.micStream.getAudioTracks()) {
                track.enabled = enabled
            }
            this.state.micOn = enabled
            this.markActive()
        } catch (error) {
            this.state.error = error.name === 'NotAllowedError' ? '麦克风权限被拒绝' : error.message
            log.warn('media', '麦克风切换失败', { error: error.message })
            throw error
        }
    }

    async toggleCam() {
        try {
            if (!this.cameraStream) {
                await this.ensureCamera()
                return
            }
            const enabled = !this.state.camOn
            for (const track of this.cameraStream.getVideoTracks()) {
                track.enabled = enabled
            }
            this.state.camOn = enabled
            this.markActive()
        } catch (error) {
            this.state.error = error.name === 'NotAllowedError' ? '摄像头权限被拒绝' : error.message
            log.warn('media', '摄像头切换失败', { error: error.message })
            throw error
        }
    }

    async shareScreen() {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            throw new Error('当前浏览器不支持屏幕共享')
        }
        if (this.state.sharing) return

        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30 } },
            audio: true
        })
        this.screenStream = stream
        this.state.screenStream = stream
        this.state.sharing = true
        this.markActive()

        // 先广播流 ID，对端在 ontrack 时据此把屏幕流从摄像头流里分离出来
        this.mesh.broadcast({ kind: 'screen-start', streamId: stream.id })

        for (const track of stream.getTracks()) {
            track.addEventListener('ended', () => this.stopShare())
            this.mesh.addTrack(track, stream)
        }
        log.info('media', '屏幕共享已开始', {
            audio: stream.getAudioTracks().length > 0
        })
    }

    /**
     * 告知某个新加入的对端：当前正在共享屏幕。
     *
     * @param {string} [peerId]
     */
    announceScreen(peerId) {
        if (!this.state.sharing || !this.screenStream) return
        const payload = { kind: 'screen-start', streamId: this.screenStream.id }
        if (peerId) {
            this.mesh.sendChat(peerId, payload)
        } else {
            this.mesh.broadcast(payload)
        }
    }

    stopShare() {
        if (!this.screenStream) return
        this.mesh.broadcast({ kind: 'screen-stop' })
        for (const track of this.screenStream.getTracks()) {
            this.mesh.removeTrack(track)
            track.stop()
        }
        this.screenStream = null
        this.state.screenStream = null
        this.state.sharing = false
        this.markActive()
        log.info('media', '屏幕共享已结束')
    }

    hangup() {
        this.stopShare()
        for (const stream of [this.micStream, this.cameraStream]) {
            if (!stream) continue
            for (const track of stream.getTracks()) {
                this.mesh.removeTrack(track)
                track.stop()
            }
        }
        this.micStream = null
        this.cameraStream = null
        this.state.micOn = false
        this.state.camOn = false
        this.state.cameraStream = null
        this.state.active = false
        this.state.error = ''
        log.info('media', '通话已结束')
    }
}
