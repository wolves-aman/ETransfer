class HttpError extends Error {
    constructor(message, status = 400, code = 'BAD_REQUEST') {
        super(message)
        this.status = status
        this.code = code
    }
}

function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
}

function applyCors(req, res, allowedOrigins) {
    const origin = req.headers.origin
    if (allowedOrigins.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*')
    } else if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

async function readJsonBody(req, maxBytes) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
        total += chunk.length
        if (total > maxBytes) {
            throw new HttpError('请求体过大', 413, 'BODY_TOO_LARGE')
        }
        chunks.push(chunk)
    }
    if (!total) {
        throw new HttpError('请求体不能为空', 400, 'EMPTY_BODY')
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw new HttpError('请求体必须是 JSON', 400, 'INVALID_JSON')
    }
}

/**
 * 只保留信令相关 HTTP 接口：健康检查、SSE 下行、POST 上行。
 *
 * @param {{ config: object, logger: object, sse: import('./sse.js').SseHub }} options
 */
export function createHttpHandler({ config, logger, sse }) {
    return async function handleHttp(req, res) {
        applyCors(req, res, config.allowedOrigins)

        if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
        }

        let url
        try {
            url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        } catch {
            send(res, 400, { error: '无效的请求地址', code: 'INVALID_URL' })
            return
        }

        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                send(res, 200, {
                    status: 'ok',
                    uptime: Math.round(process.uptime()),
                    sse: true
                })
                return
            }

            if (req.method === 'GET' && url.pathname === '/api/events') {
                sse.open(req, res)
                return
            }

            if (req.method === 'POST' && url.pathname === '/api/signal') {
                const body = await readJsonBody(req, config.maxPayload)
                const result = sse.signal(body)
                if (!result.ok) {
                    throw new HttpError(
                        result.error || 'SSE 信令失败',
                        result.status || 400,
                        result.code || 'SSE_SIGNAL_FAILED'
                    )
                }
                send(res, 202, { ok: true })
                return
            }

            send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' })
        } catch (error) {
            if (error instanceof HttpError) {
                send(res, error.status, { error: error.message, code: error.code })
                return
            }
            logger.warn('http_request_failed', {
                path: url.pathname,
                error: error.message
            })
            if (res.headersSent) {
                res.end()
                return
            }
            send(res, 500, { error: '服务器处理请求失败' })
        }
    }
}
