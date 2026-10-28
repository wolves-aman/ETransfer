import test from 'node:test'
import assert from 'node:assert/strict'

import {
    ProtocolError,
    normalizeExpiry,
    normalizeMaxUsers,
    normalizeName,
    normalizePassword,
    normalizeRoomId,
    parseMessage,
    sendJson
} from '../protocol.js'

test('parseMessage 支持字符串和 Buffer', () => {
    assert.deepEqual(parseMessage('{"action":"HEART_BEAT"}'), { action: 'HEART_BEAT' })
    assert.deepEqual(
        parseMessage(Buffer.from('{"action":"CREATE_ROOM","room_id":"abc"}')),
        { action: 'CREATE_ROOM', room_id: 'abc' }
    )
})

test('parseMessage 拒绝非法 JSON / 非对象 / 未知 action', () => {
    assert.throws(() => parseMessage('{oops'), (error) => (
        error instanceof ProtocolError && error.code === 'INVALID_JSON'
    ))
    assert.throws(() => parseMessage('[]'), (error) => error.code === 'INVALID_MESSAGE')
    assert.throws(() => parseMessage('null'), (error) => error.code === 'INVALID_MESSAGE')
    assert.throws(() => parseMessage('{"action":"HACK"}'), (error) => error.code === 'UNKNOWN_ACTION')
    assert.throws(() => parseMessage('{}'), (error) => error.code === 'UNKNOWN_ACTION')
})

test('normalizeRoomId 转大写、去空格并校验', () => {
    assert.equal(normalizeRoomId(undefined), '')
    assert.equal(normalizeRoomId('  '), '')
    assert.equal(normalizeRoomId(' abcd '), 'ABCD')
    assert.equal(normalizeRoomId('ROOM-1'), 'ROOM-1')
})

test('normalizeRoomId 拒绝非法输入', () => {
    assert.throws(() => normalizeRoomId('abc'), (error) => error.code === 'INVALID_ROOM_ID')
    assert.throws(() => normalizeRoomId('bad id'), (error) => error.code === 'INVALID_ROOM_ID')
    assert.throws(() => normalizeRoomId('房间1'), (error) => error.code === 'INVALID_ROOM_ID')
    assert.throws(() => normalizeRoomId(123), (error) => error.code === 'INVALID_ROOM_ID')
    assert.throws(() => normalizeRoomId('A'.repeat(13)), (error) => error.code === 'INVALID_ROOM_ID')
})

test('密码与名称规范化', () => {
    assert.equal(normalizePassword(''), '')
    assert.equal(normalizePassword('secret'), 'secret')
    assert.throws(() => normalizePassword('123'), (error) => error.code === 'INVALID_PASSWORD')
    assert.throws(() => normalizePassword('a'.repeat(65)), (error) => error.code === 'INVALID_PASSWORD')

    assert.equal(normalizeName('  Aman  '), 'Aman')
    assert.equal(normalizeName('a'.repeat(40)).length, 24)
    assert.equal(normalizeName(123), '')
})

test('有效期与人数上限', () => {
    assert.equal(normalizeExpiry(undefined, 180, 1440), 180)
    assert.equal(normalizeExpiry(0, 180, 1440), 0)
    assert.equal(normalizeExpiry(30, 180, 1440), 30)
    assert.equal(normalizeExpiry(9999, 180, 1440), 1440)

    assert.equal(normalizeMaxUsers(4, 8, 8), 4)
    assert.equal(normalizeMaxUsers(1, 8, 8), 2)
    assert.equal(normalizeMaxUsers(99, 8, 8), 8)
    assert.equal(normalizeMaxUsers('x', 8, 8), 8)
})

test('sendJson 只向 OPEN 的 socket 发送', () => {
    const messages = []
    const openClient = {
        readyState: 1,
        send(raw) {
            messages.push(JSON.parse(raw))
        }
    }
    const closedClient = { readyState: 3, send() { throw new Error('should not be called') } }

    assert.equal(sendJson(openClient, { action: 'HEART_BEAT' }), true)
    assert.deepEqual(messages, [{ action: 'HEART_BEAT' }])
    assert.equal(sendJson(closedClient, { action: 'HEART_BEAT' }), false)
})
