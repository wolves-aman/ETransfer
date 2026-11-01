/**
 * Vercel 环境下的最小 Redis 适配层。
 *
 * - 配置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 时走 Upstash REST
 * - 本地或未配置时退回进程内 Map，便于测试和 vercel dev
 *
 * Vercel 多实例必须配置 Redis，否则房间状态只存在于单个实例。
 */

const PREFIX = 'et:'
const url = process.env.UPSTASH_REDIS_REST_URL
    || process.env.KV_REST_API_URL
    || ''
const token = process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.KV_REST_API_TOKEN
    || ''
const useRedis = Boolean(url && token)

const memory = globalThis.__etVercelStore || {
    values: new Map(),
    lists: new Map()
}
globalThis.__etVercelStore = memory

function memoryGet(key) {
    const item = memory.values.get(key)
    if (!item) return null
    if (item.expiresAt && item.expiresAt <= Date.now()) {
        memory.values.delete(key)
        return null
    }
    return item.value
}

function memorySet(key, value, px) {
    memory.values.set(key, {
        value: String(value),
        expiresAt: px ? Date.now() + px : 0
    })
}

function memoryDel(key) {
    memory.values.delete(key)
    memory.lists.delete(key)
}

function memoryList(key) {
    let list = memory.lists.get(key)
    if (!list) {
        list = []
        memory.lists.set(key, list)
    }
    return list
}

async function command(args) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(args)
    })
    const data = await response.json()
    if (!response.ok || data.error) {
        throw new Error(data.error || `Redis 请求失败 (${response.status})`)
    }
    return data.result
}

export async function get(key) {
    const full = PREFIX + key
    if (!useRedis) return memoryGet(full)
    return command(['GET', full])
}

export async function set(key, value, { px = 0 } = {}) {
    const full = PREFIX + key
    if (!useRedis) {
        memorySet(full, value, px)
        return 'OK'
    }
    return command(px ? ['SET', full, String(value), 'PX', String(px)] : ['SET', full, String(value)])
}

export async function setNx(key, value, { px = 0 } = {}) {
    const full = PREFIX + key
    if (!useRedis) {
        if (memoryGet(full) !== null) return null
        memorySet(full, value, px)
        return 'OK'
    }
    return command(px
        ? ['SET', full, String(value), 'PX', String(px), 'NX']
        : ['SET', full, String(value), 'NX'])
}

export async function del(key) {
    const full = PREFIX + key
    if (!useRedis) {
        memoryDel(full)
        return 1
    }
    return command(['DEL', full])
}

export async function expire(key, seconds) {
    const full = PREFIX + key
    if (!useRedis) {
        const item = memory.values.get(full)
        if (item) item.expiresAt = Date.now() + seconds * 1000
        return 1
    }
    return command(['EXPIRE', full, String(seconds)])
}

export async function rpush(key, values, { ttl = 0 } = {}) {
    const full = PREFIX + key
    const list = Array.isArray(values) ? values : [values]
    if (!useRedis) {
        memoryList(full).push(...list)
        if (ttl) {
            const item = memory.values.get(full)
            if (item) item.expiresAt = Date.now() + ttl * 1000
            else memory.values.set(full, { value: '', expiresAt: Date.now() + ttl * 1000 })
        }
        return list.length
    }
    const result = await command(['RPUSH', full, ...list])
    if (ttl) await command(['EXPIRE', full, String(ttl)])
    return result
}

export async function lpop(key, count = 1) {
    const full = PREFIX + key
    if (!useRedis) {
        const items = memoryList(full).splice(0, count)
        return items
    }
    const result = await command(['LPOP', full, String(count)])
    if (result === null || result === undefined) return []
    return Array.isArray(result) ? result : [result]
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
    if (!useRedis) {
        if (memoryGet(PREFIX + key) === value) {
            memoryDel(PREFIX + key)
        }
        return 1
    }
    return command([
        'EVAL',
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        '1',
        PREFIX + key,
        value
    ])
}

export const backend = useRedis ? 'redis' : 'memory'
