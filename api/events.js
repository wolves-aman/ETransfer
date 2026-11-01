import {
    createClientSession,
    disconnectClient,
    getClientSession,
    pollEvents
} from './_lib/signal-service.js'
import { backend } from './_lib/store.js'

const MAX_STREAM_MS = 280_000
const POLL_MS = 250
const PING_MS = 15_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

export default async function handler(req, res) {
    applyCors(req, res)

    if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
    }
    if (req.method !== 'GET') {
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

    let closed = false
    req.on('close', () => {
        closed = true
    })
    res.on('close', () => {
        closed = true
    })

    const session = await (async () => {
        const url = new URL(req.url, 'http://localhost')
        const clientId = url.searchParams.get('client_id')
        const token = url.searchParams.get('token')
        if (clientId && token) {
            const resumed = await getClientSession(clientId, token)
            if (resumed) return resumed
        }
        return createClientSession()
    })()

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    res.flushHeaders?.()

    res.write(`data: ${JSON.stringify({
        action: 'CONNECTED',
        client_id: session.id,
        token: session.token,
        transport: 'sse-vercel',
        heartbeat_ms: PING_MS
    })}\n\n`)

    const startedAt = Date.now()
    let lastPing = Date.now()
    let timedOut = false

    try {
        while (!closed && Date.now() - startedAt < MAX_STREAM_MS) {
            const events = await pollEvents(session.id, 50)
            if (events.length > 0) {
                for (const event of events) {
                    if (event.__close) {
                        closed = true
                        break
                    }
                    res.write(`data: ${JSON.stringify(event)}\n\n`)
                }
            } else {
                await sleep(POLL_MS)
            }

            if (!closed && Date.now() - lastPing >= PING_MS) {
                res.write(': ping\n\n')
                lastPing = Date.now()
            }
        }
        if (!closed) {
            timedOut = true
        }
    } catch (error) {
        console.error('vercel_sse_stream_failed', error)
    } finally {
        if (!timedOut) {
            try {
                await disconnectClient(session.id)
            } catch {
                // ignore
            }
        }
        if (!res.writableEnded) {
            res.end()
        }
    }
}
