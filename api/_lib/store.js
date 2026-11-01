/**
 * Vercel 纯内存存储。
 *
 * 所有状态只存在当前 Function 实例内，不依赖 Redis。
 * - 只适合单实例 / 低流量演示
 * - Vercel 多实例或实例回收后会丢失房间
 */

const memory = globalThis.__etVercelStore || {
    values: new Map(),
    lists: new Map()
}
globalThis.__etVercelStore = memory

function getValue(key) {
    const item = memory.values.get(key)
    if (!item) return null
    if (item.expiresAt && item.expiresAt <= Date.now()) {
        memory.values.delete(key)
        return null
    }
    return item.value
}

function setValue(key, value, px) {
    memory.values.set(key, {
        value: String(value),
        expiresAt: px ? Date.now() + px : 0
    })
}

function getList(key) {
    const item = memory.lists.get(key)
    if (!item) return null
    if (item.expiresAt && item.expiresAt <= Date.now()) {
        memory.lists.delete(key)
        return null
    }
    return item
}

export async function get(key) {
    return getValue(key)
}

export async function set(key, value, { px = 0 } = {}) {
    setValue(key, value, px)
    return 'OK'
}

export async function setNx(key, value, { px = 0 } = {}) {
    if (getValue(key) !== null) return null
    setValue(key, value, px)
    return 'OK'
}

export async function del(key) {
    memory.values.delete(key)
    memory.lists.delete(key)
    return 1
}

export async function expire(key, seconds) {
    const expiresAt = Date.now() + seconds * 1000
    const value = memory.values.get(key)
    if (value) value.expiresAt = expiresAt
    const list = memory.lists.get(key)
    if (list) list.expiresAt = expiresAt
    return 1
}

export async function rpush(key, values, { ttl = 0 } = {}) {
    let item = getList(key)
    if (!item) {
        item = { items: [], expiresAt: 0 }
        memory.lists.set(key, item)
    }
    const list = Array.isArray(values) ? values : [values]
    item.items.push(...list)
    if (ttl) item.expiresAt = Date.now() + ttl * 1000
    return list.length
}

export async function lpop(key, count = 1) {
    const item = getList(key)
    if (!item) return []
    return item.items.splice(0, count)
}

export async function getJson(key) {
    const raw = await get(key)
    if (!raw) return null
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

export async function setJson(key, value, options) {
    return set(key, JSON.stringify(value), options)
}

export async function releaseLock(key, value) {
    if (getValue(key) === value) {
        memory.values.delete(key)
    }
    return 1
}

export const backend = 'memory'
