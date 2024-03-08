<template>
    <Header></Header>
    <div class="body">
        <Loading v-if="!wsConnection" :hint="hint"></Loading>
        <CreateRoom v-if="wsConnection && !isCreatedRoom" @createRoom="createRoom"></CreateRoom>
        <Room v-if="wsConnection && isCreatedRoom" :room-id="roomId" :is-connected="isConnected"
              :is-send="isSend" :messages="messages"
              @sendMsg="sendPcMsg"
              @share-screen="createScreenShare"
              @choose-file="startSendFile"></Room>
        <div v-show="showScreenShare" ref="screen" id="screen"
             draggable="true"
             @dragstart="dragStartScreen"
             @drag="dragEndScreen">
            <video ref="screenVideo" autoplay></video>
            <div class="tools text-right">
                <i class="pi pi-window-minimize mr-4" @click="exitFullScreen"></i>
                <i class="pi pi-window-maximize" @click="fullScreen"></i>

            </div>
        </div>
    </div>
    <ConfirmDialog></ConfirmDialog>
    <Toast position="top-center"/>

</template>

<script>

import Loading from "@/components/Loading.vue";
import CreateRoom from "@/components/CreateRoom.vue";
import Header from "@/components/Header.vue";
import Room from "@/components/Room.vue";
import {useConfirm} from "primevue/useconfirm";
import {useToast} from "primevue/usetoast";
import ConfirmDialog from 'primevue/confirmdialog';
import {nanoid} from 'nanoid'
import Toast from "primevue/toast";

let confirm, toast;
let ws = null;
let pc = null, sendTextChannel;
export default {
    name: 'App',
    components: {
        Header,
        CreateRoom,
        Loading,
        Room,
        ConfirmDialog,
        Toast
    },
    data() {
        return {
            roomId: '',
            wsConnection: false, //ws是否连接
            isCreatedRoom: false, //是否创建了房间
            isConnected: false,//房间用户连接
            isSend: false,//是否可以发送消息
            messages: [],
            fileChannelMap: {},
            hint: "",
            screenStartX: 0,
            screenStartY: 0,
            screenStartLeft: 0,
            screenStartTop: 0,
            showScreenShare: false,
            webSocketHeartInterval: null

        }
    },
    setup() {
        confirm = useConfirm();
        toast = useToast();
    },
    created() {
        this.initWebSocket()
        this.initPeerConnection()
        this.$nextTick(() => {
            this.$refs.screenVideo.addEventListener("touchstart",this.touchStartScreen)
            this.$refs.screenVideo.addEventListener("touchmove",this.touchEndScreen)
        })
    },
    methods: {
        getRoomId() {
            this.roomId = window.location.hash.substring(2)
            return this.roomId !== ""
        },
        joinRoom() {
            this.sendMsg({
                action: "JOIN_ROOM",
                room_id: this.roomId
            })
        },
        createRoom(roomId) {
            this.sendMsg({
                action: "CREATE_ROOM",
                room_id: roomId
            })
        },
        //初始化webSocket
        initWebSocket() {
            if (ws === null) {
                try {
                    this.hint = "正在连接webSocket服务"
                    ws = new WebSocket(window.WSURL);
                    ws.onerror = this.webSocketOnError;
                    ws.onopen = this.webSocketOnOpen;
                    ws.onmessage = this.webSocketOnMessage;
                    ws.onclose = this.webSocketOnClose;
                } catch (e) {
                    this.wsConnection = false;
                    this.hint = "连接webSocket服务出错！"
                }
            }
        },
        webSocketOnMessage(event) {
            const data = JSON.parse(event.data)
            switch (data.action) {
                case "CREATE_ROOM": //创建房间
                    if (data.status !== true) {
                        confirm.require({
                            message: data.msg,
                            header: '提示',
                            icon: 'pi pi-exclamation-triangle',
                            rejectClass: 'hidden',
                            acceptLabel: '确定',
                            acceptClass: 'p-button-warning',
                        });
                    } else {
                        history.pushState({}, "", "/#/"+data.room_id);
                        this.roomId = data.room_id
                        this.isCreatedRoom = true;
                    }
                    break;
                case "JOIN_ROOM":
                    if (data.status !== true) {
                        this.goBack()
                        confirm.require({
                            message: data.msg,
                            header: '提示',
                            icon: 'pi pi-exclamation-triangle',
                            rejectClass: 'hidden',
                            acceptLabel: '确定',
                            acceptClass: 'p-button-warning',
                        });
                    } else {
                        this.isConnected = true
                        this.isCreatedRoom = true
                    }
                    break;
                case "LEAVE_ROOM":
                    toast.add({
                        severity: 'warn',
                        summary: '提示',
                        detail: "用户离开房间",
                        life: 3000
                    })
                    this.isConnected = false
                    sendTextChannel.close()
                    sendTextChannel=null
                    pc.close()
                    pc=null
                    this.initPeerConnection()
                    break;
                case "CLOSE_ROOM":
                    this.isConnected = false
                    this.isCreatedRoom = false
                    break;
                case "CONNECT":
                    toast.add({
                        severity: 'success',
                        summary: '提示',
                        detail: "用户加入房间",
                        life: 3000
                    })
                    this.isConnected = true
                    this.createAndSendOffer()
                    break;
                case "TRANSFER" :
                    this.transfer(data)
                    break;
            }
        },
        transfer(data) {
            switch (data.type) {
                case 'offer':
                    console.log("get offer", data.offer)
                    pc.setRemoteDescription(data.offer)
                    pc.createAnswer().then((desc) => {
                        pc.setLocalDescription(desc)
                        this.sendMsg({
                            action: "TRANSFER",
                            type: "answer",
                            answer: desc
                        })
                    })
                    break;
                case 'answer':
                    console.log("收到answer", data.answer)
                    pc.setRemoteDescription(data.answer)
                    console.log("设置远程answer", data.answer)
                    break;
                case 'candidate':
                    console.log("收到candidate", data.candidate)
                    pc.addIceCandidate(data.candidate)
                    break;
            }
        },
        //连接发生错误的回调方法
        webSocketOnError() {
            this.wsConnection = false;
            this.isCreatedRoom = false;
            this.isConnected = false;
            this.hint = "连接webSocket服务错误"
        },
        webSocketOnOpen() {
            this.hint = "连接webSocket成功！"
            this.wsConnection = true;
            //判断是否有roomId
            if (this.getRoomId()) {
                this.joinRoom()
            }
            this.webSocketHeart()
        },
        webSocketOnClose() {
            this.wsConnection = false;
            this.isCreatedRoom = false;
            this.isConnected = false;
            this.hint = "webSocket服务已断开"
        },
        webSocketHeart(){
            //心跳
            this.webSocketHeartInterval = setInterval(() => {
                if(!this.wsConnection && this.webSocketHeartInterval){
                    clearInterval(this.webSocketHeartInterval)
                    return
                }
                this.sendMsg({
                    action: "HEART_BEAT"
                })
            },10000)
        },
        initPeerConnection() {
            if (pc === null) {
                pc = new RTCPeerConnection( window.WEBRTC_CONFIG)
                pc.oniceconnectionstatechange = function(event) {
                    console.log('oniceconnectionstatechange',event);
                };
                sendTextChannel = pc.createDataChannel("sendDataChannel")
                sendTextChannel.onopen = this.onSendTextChannelStateChange;
                sendTextChannel.onclose = this.onSendTextChannelStateChange;
                pc.onicecandidate = (event) => {
                    if (event.candidate) {
                        this.sendMsg({
                            action: "TRANSFER",
                            type: "candidate",
                            candidate: event.candidate,
                        })
                        console.log("发送candidate", event.candidate)
                    }
                }
                pc.ondatachannel = this.onDataChannel
                pc.ontrack = this.onStream;
                console.log("创建webrtc")
            }

        },
        onDataChannel(e) {
            if (e.channel.label === "sendDataChannel") {
                e.channel.onmessage = (event) => {
                    let data = JSON.parse(event.data)
                    if(data.type === "close_screen") {
                        this.showScreenShare = false
                        this.$refs.screenVideo.srcObject =null
                        toast.add({
                            severity: 'warn',
                            summary: '提示',
                            detail: "屏幕共享已结束",
                            life: 3000
                        })
                    }else{
                        this.messages.push({
                            data: data,
                            from: "other",
                            time: new Date().getTime()
                        })
                    }
                }
            }else {
                let channelName = e.channel.label;
                e.channel.onmessage = (event) => {
                    console.log(channelName, event.data.byteLength)
                    this.updateFileProgress(channelName, event.data)
                }


            }
        },
        onStream(e) {
            if (!this.$refs.screen) {
                return
            }
            this.showScreenShare = true
            this.$refs.screenVideo.srcObject = e.streams[0];
            this.$refs.screenVideo.play();
            return false
        },
        onSendTextChannelStateChange() {
            const readyState = sendTextChannel.readyState;
            this.isSend = readyState === 'open'
            console.log('onSendTextChannelStateChange is: ' + readyState);
        },
        sendPcMsg(data) {
            if (sendTextChannel.readyState === 'open') {
                sendTextChannel.send(JSON.stringify(data))
                this.messages.push({
                    data: data,
                    from: "me",
                    time: new Date().getTime()
                })
            }

        },
        createAndSendOffer(){
            pc.createOffer().then((desc) => {
                console.log("创建offer", desc)
                console.log("设置本地offer", desc)
                pc.setLocalDescription(desc)
                console.log("发送offer", desc)
                this.sendMsg({
                    action: "TRANSFER",
                    type: "offer",
                    offer: desc
                })
            })
        },

        startSendFile(file) {
            if (file.size === 0) {
                return
            }
            if(!this.isSend){
                toast.add({
                    severity: 'warn',
                    summary: '错误',
                    detail: "对方还没连接，请稍后再试",
                    life: 3000
                })
                return;
            }
            const channelName = nanoid();
            const chunkSize = 10240;
            let fileReader = new FileReader();
            let offset = 0;
            //开始创建发送文件通道
            let channel = pc.createDataChannel(channelName)
            channel.onclose = () => {
                channel = null
            };
            channel.onopen = () => {
                this.createFileMessage(channelName, file)
                fileReader.addEventListener('error', error => console.error('Error reading file:', error));
                fileReader.addEventListener('abort', event => console.log('File reading aborted:', event));
                fileReader.addEventListener('load', e => {
                    channel.send(e.target.result);
                    offset += e.target.result.byteLength;
                    this.updateFileProgress(channelName, e.target.result)
                    if (offset < file.size) {
                        readSlice(offset);
                    } else {
                        console.log("传输完成，", file.name)
                        channel.close()
                        channel = null
                        fileReader = null
                    }
                });
                const readSlice = o => {
                    const slice = file.slice(offset, o + chunkSize);
                    fileReader.readAsArrayBuffer(slice);
                };
                readSlice(0);
            };
        },
        createFileMessage(channelName, file) {
            if (sendTextChannel.readyState === 'open') {
                let data = {
                    file: {
                        name: file.name,
                        type: file.type,
                        totalSize: file.size,
                        lastModified: file.lastModified,
                        size: 0,
                        data: []
                    },
                    type: "file",
                    from: "me",
                    id: channelName,
                };
                this.sendPcMsg(data)
            }

        },
        //更新文件传输进度
        updateFileProgress(channelName, data) {
            let message = this.messages.find(item => item.data.id === channelName)
            if (message) {
                message.end_time = new Date().getTime()
                message.data.file.data.push(data)
                message.data.file.size += data.byteLength
            }
        },
        sendMsg(data) {
            ws.send(JSON.stringify(data))
        },
        goBack() {
            history.pushState({}, "", "/");
            this.isCreatedRoom = false;
            this.roomId = "";
        },
        createScreenShare() {

            if ((navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices)) {
                navigator.mediaDevices.getDisplayMedia({
                    audio: true,
                    video: true
                }).then(this.createScreenShareSuccess).catch(this.createScreenShareError)
            } else {
                toast.add({
                    severity: 'warn',
                    summary: '错误',
                    detail: "该浏览器不支持屏幕共享",
                    life: 3000
                })
            }

        },
        createScreenShareSuccess(stream) {
            stream.getTracks().forEach(track => {
                pc.addTrack(track,stream)
            });
            stream.getVideoTracks()[0].addEventListener('ended', () => {
                let data = {type: "close_screen"};
                this.sendPcMsg(data)
                toast.add({
                    severity: 'warn',
                    summary: '提示',
                    detail: "屏幕共享已结束",
                    life: 3000
                })
            });
            this.createAndSendOffer()
        },
        createScreenShareError(error) {
            toast.add({
                severity: 'error',
                summary: '分享屏幕错误',
                detail: error.name,
                life: 3000
            })
        },
        dragStartScreen(e) {
            this.screenStartX = e.clientX
            this.screenStartY = e.clientY
            this.screenStartLeft = parseInt(getComputedStyle(this.$refs.screen).left);
            this.screenStartTop = parseInt(getComputedStyle(this.$refs.screen).top);

        },
        dragEndScreen(e) {
            const dx = e.clientX - this.screenStartX;
            const dy = e.clientY - this.screenStartY;
            let newLeft = this.screenStartLeft + dx;
            let newTop = this.screenStartTop + dy;
            if (newTop < 62) {
                newTop = 62
            } else if (newTop > (window.innerHeight - this.$refs.screen.offsetHeight)) {
                newTop = window.innerHeight - this.$refs.screen.offsetHeight
            }
            if (newLeft < 0) {
                newLeft = 0
            } else if (newLeft > (window.innerWidth - this.$refs.screen.offsetWidth)) {
                newLeft = window.innerWidth - this.$refs.screen.offsetWidth
            }
            this.$refs.screen.style.left = newLeft + 'px';
            this.$refs.screen.style.top = newTop + 'px';


        },
        touchStartScreen(e) {
            this.screenStartX = e.targetTouches[0].clientX
            this.screenStartY = e.targetTouches[0].clientY
            this.screenStartLeft = parseInt(getComputedStyle(this.$refs.screen).left);
            this.screenStartTop = parseInt(getComputedStyle(this.$refs.screen).top);
            e.preventDefault();
        },
        touchEndScreen(e) {
            const dx = e.targetTouches[0].clientX - this.screenStartX;
            const dy = e.targetTouches[0].clientY - this.screenStartY;
            let newLeft = this.screenStartLeft + dx;
            let newTop = this.screenStartTop + dy;
            if (newTop < 62) {
                newTop = 62
            } else if (newTop > (window.innerHeight - this.$refs.screen.offsetHeight)) {
                newTop = window.innerHeight - this.$refs.screen.offsetHeight
            }
            if (newLeft < 0) {
                newLeft = 0
            } else if (newLeft > (window.innerWidth - this.$refs.screen.offsetWidth)) {
                newLeft = window.innerWidth - this.$refs.screen.offsetWidth
            }
            this.$refs.screen.style.left = newLeft + 'px';
            this.$refs.screen.style.top = newTop + 'px';
            e.preventDefault();

        },
        fullScreen() {
            if (document.documentElement.requestFullscreen) {
                this.$refs.screen.requestFullscreen();
            } else if (document.documentElement.mozRequestFullScreen) {
                this.$refs.screen.mozRequestFullScreen();
            } else if (document.documentElement.webkitRequestFullscreen) {
                this.$refs.screen.webkitRequestFullscreen();
            } else if (document.documentElement.msRequestFullscreen) {
                this.$refs.screen.msRequestFullscreen();
            }
        },
        exitFullScreen() {
            if(this.isFullScreen()){
                let exitFullScreen = document.exitFullscreen ||
                    document.mozCancelFullScreen ||
                    document.webkitExitFullscreen ||
                    document.msExitFullscreen;
                if (exitFullScreen) {
                    exitFullScreen.call(document);
                }
            }

        },
        isFullScreen() {
            return document.fullscreenElement ||
                document.mozFullScreenElement ||
                document.webkitFullscreenElement ||
                document.msFullscreenElement || false;
        }
    },

    unmounted() {
        this.pcMsg.close()
        ws.close()
        this.pcMsg = null
    }
}
</script>

<style>
html, body {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    background: var(--surface-ground);
}

.title {
    font-size: 3rem;
    font-weight: bold;
    margin: 100px 0 50px 0;
}

[data-theme="light"] {
    --headerbg: rgba(255, 255, 255, .7);
}

[data-theme="dark"] {
    --headerbg: rgba(0, 0, 0, .3);
}

header {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 62px;
    box-shadow: rgba(41, 50, 65, 0.06) 0 10px 40px 0;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    background-color: var(--headerbg);
    border-bottom: 1px solid var(--surface-border);
}

.body {
    margin-top: 62px;
}

.logo-text {
    background: linear-gradient(45deg, var(--primary-700), var(--primary-400));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}

#screen {
    position: fixed;
    left: 0;
    top: 62px;
    max-height: 300px;
    max-width: 400px;
    width:33vw;
    height: 33vw;
    background: #000;
    z-index: 10;
}

#screen video {
    width: 100%;
    height: 100%;
}

#screen .tools {
    position: absolute;
    width: 100%;
    bottom: 0;
    padding: 10px;
    font-size: 1rem;
}

#screen .tools:hover {
    background: rgba(255, 255, 255, .3);
}

#screen .tools:hover > .pi {
    display: inline-block;

}

#screen .tools > .pi {
    font-size: 1.2rem;
    color: #fff;
    cursor: pointer;
    display: none;
}
</style>
