import test from 'node:test'
import assert from 'node:assert/strict'

import { RoomError, RoomRegistry } from '../room/room.js'

function fakeClient() {
    return {
        readyState: 1,
        messages: [],
        send(raw) {
            this.messages.push(JSON.parse(raw))
        }
    }
}

test('创建房间：短码、密码、人数与信息', () => {
    const registry = new RoomRegistry({ roomIdLength: 6 })
    const owner = fakeClient()

    const room = registry.create({
        roomId: 'ROOM1',
        hostName: 'Aman',
        password: 'secret',
        oneTime: false,
        maxUsers: 4,
        expiresAt: 0
    }, owner)

    assert.equal(room.id, 'ROOM1')
    assert.equal(room.size, 1)
    assert.equal(room.hasPassword, true)
    assert.equal(room.maxUsers, 4)
    assert.equal(room.verifyPassword('secret'), true)
    assert.equal(room.verifyPassword('wrong'), false)
    assert.equal(room.info().host_id, room.hostId)

    assert.throws(
        () => registry.create({ roomId: 'ROOM1' }, fakeClient()),
        (error) => error instanceof RoomError && error.code === 'ROOM_EXISTS'
    )

    const generated = registry.create({}, fakeClient())
    assert.match(generated.id, /^[A-Z2-9]{6}$/)
})

test('加入房间：密码、满员、一次性限制', () => {
    const registry = new RoomRegistry()
    const owner = fakeClient()
    const guest = fakeClient()
    const third = fakeClient()

    registry.create({ roomId: 'ROOM2', password: 'pass1234', oneTime: true }, owner)

    assert.throws(
        () => registry.join('ROOM2', guest, { password: '' }),
        (error) => error.code === 'PASSWORD_REQUIRED'
    )
    assert.throws(
        () => registry.join('ROOM2', guest, { password: 'wrongpass' }),
        (error) => error.code === 'WRONG_PASSWORD'
    )

    const { user } = registry.join('ROOM2', guest, { password: 'pass1234', name: 'Guest' })
    assert.equal(user.name, 'Guest')
    assert.equal(user.isHost, false)
    assert.equal(registry.get('ROOM2').size, 2)

    assert.throws(
        () => registry.join('ROOM2', third, { password: 'pass1234' }),
        (error) => ['ROOM_USED', 'ROOM_FULL'].includes(error.code)
    )
})

test('房主离开后自动迁移房主', () => {
    const registry = new RoomRegistry()
    const owner = fakeClient()
    const guest = fakeClient()

    const room = registry.create({ roomId: 'ROOM3' }, owner)
    const { user: guestUser } = registry.join('ROOM3', guest, {})

    const result = registry.leave(room, owner)
    assert.equal(result.remaining, 1)
    assert.equal(result.closed, false)
    assert.equal(result.newHost.id, guestUser.id)
    assert.equal(guestUser.isHost, true)
    assert.equal(room.hostId, guestUser.id)
})

test('一次性房间在成员离开时关闭并删除', () => {
    const registry = new RoomRegistry()
    const owner = fakeClient()
    const guest = fakeClient()

    const room = registry.create({ roomId: 'ROOM4', oneTime: true }, owner)
    registry.join('ROOM4', guest, {})

    const result = registry.leave(room, guest)
    assert.equal(result.closed, true)
    assert.equal(registry.get('ROOM4'), undefined)
    assert.equal(registry.size, 0)
})

test('空房间回收与过期清理', () => {
    const registry = new RoomRegistry()
    const owner = fakeClient()
    const room = registry.create({ roomId: 'ROOM5' }, owner)

    assert.equal(registry.leave(room, owner).remaining, 0)
    assert.equal(registry.size, 0)

    const expiring = registry.create({
        roomId: 'ROOM6',
        expiresAt: Date.now() - 1
    }, fakeClient())
    const removed = registry.sweep()
    assert.deepEqual(removed.map((item) => item.id), ['ROOM6'])
    assert.equal(registry.get('ROOM6'), undefined)
    assert.equal(expiring.isExpired(), true)
})

test('广播跳过发送者并忽略已关闭连接', () => {
    const registry = new RoomRegistry()
    const owner = fakeClient()
    const guest = fakeClient()
    const closed = fakeClient()
    closed.readyState = 3

    const room = registry.create({ roomId: 'ROOM7', maxUsers: 4 }, owner)
    registry.join('ROOM7', guest, {})
    room.users.set(closed, { client: closed, id: 'x', isHost: false })

    const delivered = room.broadcast({ action: 'PEER_LEFT' }, owner)
    assert.equal(delivered, 1)
    assert.deepEqual(owner.messages, [])
    assert.deepEqual(guest.messages, [{ action: 'PEER_LEFT' }])
    assert.deepEqual(closed.messages, [])
})
