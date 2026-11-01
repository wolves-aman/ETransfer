import { handleSignal } from './_lib/signal-service.js'
import { backend } from './_lib/store.js'

const MAX_BODY = 256 * 1024

function applyCors(req, res) {
    const origin = req.headers.origin
    const allowed = String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    if (allowed.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*')
    } else if (origin && allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

async function readBody(req) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        return req.body
    }
    if (Buffer.isBuffer(req.body)) {
        try {
            return JSON.parse(req.body.toString('utf8'))
        } catch {
            const error = new Error('请求体必须是 JSON')
            error.status = 400
            error.code = 'INVALID_JSON'
            throw error
        }
    }
    if (typeof req.body === 'string' && req.body) {
        try {
            return JSON.parse(req.body)
        } catch {
            const error = new Error('请求体必须是 JSON')
            error.status = 400
            error.code = 'INVALID_JSON'
            throw error
        }
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) {
            const error = new Error('请求体过大')
            error.status = 413
            error.code = 'BODY_TOO_LARGE'
            throw error
        }
        chunks.push(chunk)
    }
    if (!chunks.length) {
        return {}
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        const error = new Error('请求体必须是 JSON')
        error.status = 400
        error.code = 'INVALID_JSON'
        throw error
    }
}

export default async function handler(req, res) {
    applyCors(req, res)

    if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
    }
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=UTF-8' })
        res.end(JSON.stringify({ error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED' }))
        return
    }

    if (process.env.VERCEL && backend === 'memory') {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=UTF-8' })
        res.end(JSON.stringify({
            error: 'Vercel 部署需要 Upstash Redis 环境变量',
            code: 'REDIS_REQUIRED'
        }))
        return
    }

    try {
        const body = await readBody(req)
        const clientId = body.client_id
        const token = body.token
        if (typeof clientId !== 'string' || typeof token !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' })
            res.end(JSON.stringify({ error: '缺少 client_id 或 token', code: 'INVALID_SESSION' }))
            return
        }

        const { client_id, token: ignoredToken, ...message } = body
        void client_id
        void ignoredToken

        const result = await handleSignal({ clientId, token, message })
        if (!result.ok) {
            res.writeHead(result.status || 400, { 'Content-Type': 'application/json; charset=UTF-8' })
            res.end(JSON.stringify({ error: result.error, code: result.code }))
            return
        }

        res.writeHead(202, { 'Content-Type': 'application/json; charset=UTF-8' })
        res.end(JSON.stringify({ ok: true }))
    } catch (error) {
        const status = error.status || 500
        res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' })
        res.end(JSON.stringify({
            error: status === 500 ? '服务器处理请求失败' : error.message,
            code: error.code || 'INTERNAL'
        }))
    }
}
