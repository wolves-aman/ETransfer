import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import WebSocket from 'ws'
import { createSignalingServer } from '../app.js'
import { createLogger } from '../logger.js'

const silentLogger = createLogger({ level: 'silent' })

async function startServer(overrides = {}) {
    const relayDir = await mkdtemp(path.join(tmpdir(), 'etransfer-relay-'))
    const app = createSignalingServer({
        config: {
            host: '127.0.0.1',
            logLevel: 'silent',
            shutdownTimeout: 200,
            heartbeatInterval: 60_000,
            sweepInterval: 60_000,
            relay: { dir: relayDir, enabled: true, maxBytes: 1024 * 1024, ttlMs: 60_000 },
            ...overrides
        },
        logger: silentLogger
    })
    const address = await app.listen(0, '127.0.0.1')
    return {
        app,
        relayDir,
        wsUrl: `ws://127.0.0.1:${address.port}`,
        httpUrl: `http://127.0.0.1:${address.port}`
    }
}

function track(ws) {
    const queue = []
    const waiters = []

    ws.on('message', (raw) => {
        let message
        try {
            message = JSON.parse(raw.toString())
        } catch {
            return
        }
        for (let index = 0; index < waiters.length; index += 1) {
            if (waiters[index].predicate(message)) {
                const [waiter] = waiters.splice(index, 1)
                clearTimeout(waiter.timer)
                waiter.resolve(message)
                return
            }
        }
        queue.push(message)
    })

    return {
        ws,
        send(message) {
            ws.send(JSON.stringify(message))
        },
        next(actionOrPredicate, timeout = 2_000) {
            const predicate = typeof actionOrPredicate === 'function'
                ? actionOrPredicate
                : (message) => message.action === actionOrPredicate
            const index = queue.findIndex(predicate)
            if (index !== -1) {
                return Promise.resolve(queue.splice(index, 1)[0])
            }
            return new Promise((resolve, reject) => {
                const waiter = { predicate, resolve, timer: null }
                waiter.timer = setTimeout(() => {
                    const waiterIndex = waiters.indexOf(waiter)
                    if (waiterIndex !== -1) waiters.splice(waiterIndex, 1)
                    reject(new Error(`等待消息超时: ${String(actionOrPredicate)}`))
                }, timeout)
                waiters.push(waiter)
            })
        },
        close() {
            ws.close()
        }
    }
}

async function connect(url, options) {
    const ws = new WebSocket(url, options)
    await once(ws, 'open')
    return track(ws)
}

async function createRoom(client, overrides = {}) {
    client.send({
        action: 'CREATE_ROOM',
        room_id: 'ROOM1',
        name: 'Host',
        ...overrides
    })
    const created = await client.next('CREATE_ROOM')
    assert.equal(created.status, true, created.msg)
    return created
}

async function joinRoom(client, roomId, overrides = {}) {
    client.send({ action: 'JOIN_ROOM', room_id: roomId, name: 'Guest', ...overrides })
    return client.next('JOIN_ROOM')
}

test('创建房间 -> 加入 -> mesh 目标转发 -> 离开通知', async (t) => {
    const { app, relayDir, wsUrl } = await startServer()
    t.after(async () => {
        await app.close()
        await rm(relayDir, { recursive: true, force: true })
    })

    const host = await connect(wsUrl)
    const guest = await connect(wsUrl)

    const created = await createRoom(host, { room_id: 'ROOM1' })
    assert.equal(created.room_id, 'ROOM1')
    assert.equal(created.host, true)
    assert.match(created.self_id, /^[A-Za-z0-9_-]{8}$/)

    const joined = await joinRoom(guest, 'ROOM1')
    assert.equal(joined.status, true)
    assert.equal(joined.peers.length, 1)
    assert.equal(joined.peers[0].id, created.self_id)

    const peerJoined = await host.next('PEER_JOINED')
    assert.equal(peerJoined.peer.id, joined.self_id)

    host.send({
        action: 'TRANSFER',
        target: joined.self_id,
        type: 'offer',
        offer: { type: 'offer', sdp: 'v=0' }
    })
    const offer = await guest.next('TRANSFER')
    assert.equal(offer.from, created.self_id)
    assert.equal(offer.type, 'offer')
    assert.equal(offer.offer.sdp, 'v=0')

    const guestClosed = once(guest.ws, 'close')
    guest.close()
    await guestClosed
    const peerLeft = await host.next('PEER_LEFT')
    assert.equal(peerLeft.peer_id, joined.self_id)
})

test('房间密码：缺失 / 错误 / 正确', async (t) => {
    const { app, relayDir, wsUrl } = await startServer()
    t.after(async () => {
        await app.close()
        await rm(relayDir, { recursive: true, force: true })
    })

    const host = await connect(wsUrl)
    await createRoom(host, { room_id: 'PASS1', password: 'pass1234' })

    const guest = await connect(wsUrl)
    const missing = await joinRoom(guest, 'PASS1')
    assert.equal(missing.status, false)
    assert.equal(missing.code, 'PASSWORD_REQUIRED')

    const wrong = await joinRoom(guest, 'PASS1', { password: 'nope1234' })
    assert.equal(wrong.code, 'WRONG_PASSWORD')

    const ok = await joinRoom(guest, 'PASS1', { password: 'pass1234' })
    assert.equal(ok.status, true)
})

test('多人 mesh：成员列表与定向转发', async (t) => {
    const { app, relayDir, wsUrl } = await startServer()
    t.after(async () => {
        await app.close()
        await rm(relayDir, { recursive: true, force: true })
    })

    const host = await connect(wsUrl)
    const alice = await connect(wsUrl)
    const bob = await connect(wsUrl)

    const created = await createRoom(host, { room_id: 'MESH1', max_users: 4 })
    const joinedAlice = await joinRoom(alice, 'MESH1', { name: 'Alice' })
    assert.equal(joinedAlice.peers.length, 1)

    const joinedBob = await joinRoom(bob, 'MESH1', { name: 'Bob' })
    assert.equal(joinedBob.peers.length, 2)
    assert.deepEqual(
        joinedBob.peers.map((peer) => peer.name).sort(),
        ['Alice', 'Host']
    )

    const hostSeesBob = await host.next((message) => (
        message.action === 'PEER_JOINED' && message.peer.id === joinedBob.self_id
    ))
    assert.equal(hostSeesBob.peer.name, 'Bob')

    host.send({
        action: 'TRANSFER',
        target: joinedBob.self_id,
        type: 'answer',
        answer: { type: 'answer', sdp: 'v=0' }
    })
    const toBob = await bob.next('TRANSFER')
    assert.equal(toBob.from, created.self_id)
    assert.equal(toBob.type, 'answer')

    bob.send({
        action: 'TRANSFER',
        target: joinedAlice.self_id,
        type: 'candidate',
        candidate: { candidate: 'candidate:1' }
    })
    const toAlice = await alice.next('TRANSFER')
    assert.equal(toAlice.from, joinedBob.self_id)
})

test('房主踢人与一次性房间关闭', async (t) => {
    const { app, relayDir, wsUrl } = await startServer()
    t.after(async () => {
        await app.close()
        await rm(relayDir, { recursive: true, force: true })
    })

    const host = await connect(wsUrl)
    const guest = await connect(wsUrl)
    const created = await createRoom(host, { room_id: 'KICK1' })
    const joined = await joinRoom(guest, 'KICK1')

    host.send({ action: 'KICK', peer_id: joined.self_id })
    const kicked = await guest.next('KICKED')
    assert.equal(kicked.reason, 'host_kicked')

    const left = await host.next('PEER_LEFT')
    assert.equal(left.peer_id, joined.self_id)
    assert.equal(left.reason, 'kicked')

    const guestClosed = once(guest.ws, 'close')
    await guestClosed

    const oneTimeHost = await connect(wsUrl)
    const oneTimeGuest = await connect(wsUrl)
    const oneTimeThird = await connect(wsUrl)
    await createRoom(oneTimeHost, {
        room_id: 'ONCE1',
        one_time: true,
        max_users: 6
    })
    await joinRoom(oneTimeGuest, 'ONCE1')
    const third = await joinRoom(oneTimeThird, 'ONCE1')
    assert.equal(third.status, false)
    assert.equal(third.code, 'ROOM_USED')

    const guestClosed2 = once(oneTimeGuest.ws, 'close')
    oneTimeGuest.close()
    const closed = await oneTimeHost.next('ROOM_CLOSED')
    assert.equal(closed.reason, 'one_time_closed')
    await guestClosed2
    assert.equal(app.registry.get('ONCE1'), undefined)
    assert.equal(created.room_id, 'KICK1')
})

test('房间过期自动关闭', async (t) => {
    const { app, relayDir, wsUrl } = await startServer({ sweepInterval: 50 })
    t.after(async () => {
        await app.close()
        await rm(relayDir, { recursive: true, force: true })
    })

    const host = await connect(wsUrl)
    await createRoom(host, { room_id: 'EXP01', expires_in: 1 })
    const room = app.registry.get('EXP01')
    assert.ok(room)
    room.expiresAt = Date.now() - 1

    const closed = await host.next('ROOM_CLOSED', 3_000)
    assert.equal(closed.reason, 'expired')
    assert.equal(app.registry.get('EXP01'), undefined)
})

test('ALLOWED_ORIGINS 白名单', async (t) => {
    const { app, relayDir, wsUrl } = await startServer({
        allowedOrigins: ['https://allowed.example']
    })
    t.after(async () => {
        await app.close()
        await rm(relayDir, { recursive: true, force: true })
    })

    const rejected = new WebSocket(wsUrl, { origin: 'https://evil.example' })
    const [code] = await once(rejected, 'close')
    assert.equal(code, 1008)

    const allowed = new WebSocket(wsUrl, { origin: 'https://allowed.example' })
    await once(allowed, 'open')
    allowed.close()
})

test('HTTP 健康检查、链接预览 SSRF 防护与中继上传下载', async (t) => {
    const { app, relayDir, httpUrl } = await startServer()
    t.after(async () => {
        await app.close()
        await rm(relayDir, { recursive: true, force: true })
    })

    const health = await fetch(`${httpUrl}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'ok')

    const privatePreview = await fetch(
        `${httpUrl}/api/link-preview?url=${encodeURIComponent('http://127.0.0.1:8080/secret')}`
    )
    assert.equal(privatePreview.status, 400)
    assert.equal((await privatePreview.json()).code, 'PRIVATE_URL')

    const content = Buffer.from('relay payload 你好', 'utf8')
    const upload = await fetch(`${httpUrl}/api/relay`, {
        method: 'POST',
        headers: {
            'x-file-name': encodeURIComponent('hello.txt'),
            'x-file-type': 'text/plain'
        },
        body: content
    })
    assert.equal(upload.status, 200)
    const meta = await upload.json()
    assert.equal(meta.size, content.byteLength)

    const download = await fetch(`${httpUrl}${meta.url}`)
    assert.equal(download.status, 200)
    assert.equal(Buffer.from(await download.arrayBuffer()).toString('utf8'), 'relay payload 你好')
})
