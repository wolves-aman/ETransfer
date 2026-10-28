import { createReadStream } from 'node:fs'
import { isIP } from 'node:net'

const PREVIEW_UA = 'ETransferBot/1.0 (+https://github.com/wolves-aman/ETransfer)'
const previewCache = new Map()

/**
 * 判断 host 是否指向内网/本机，避免链接预览变成 SSRF 跳板。
 *
 * @param {string} hostname
 */
function isPrivateHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') {
        return true
    }

    const version = isIP(host)
    if (version === 4) {
        const [a, b] = host.split('.').map(Number)
        return a === 10
            || a === 127
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || a === 0
    }
    if (version === 6) {
        return host === '::1'
            || host.startsWith('fc')
            || host.startsWith('fd')
            || host.startsWith('fe80')
    }
    return false
}

/**
 * @param {string} raw
 * @returns {URL}
 */
function parsePublicUrl(raw) {
    let url
    try {
        url = new URL(raw)
    } catch {
        throw new RelayHttpError('链接格式无效', 400, 'INVALID_URL')
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new RelayHttpError('只支持 http/https 链接', 400, 'INVALID_URL')
    }
    if (isPrivateHost(url.hostname)) {
        throw new RelayHttpError('不允许预览内网地址', 400, 'PRIVATE_URL')
    }
    return url
}

class RelayHttpError extends Error {
    constructor(message, status = 400, code = 'BAD_REQUEST') {
        super(message)
        this.status = status
        this.code = code
    }
}

function decodeEntities(text = '') {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * 从 HTML 中提取 Open Graph / title / description。
 *
 * @param {string} html
 * @param {string} baseUrl
 */
function extractPreview(html, baseUrl) {
    const pickMeta = (names) => {
        for (const name of names) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const patterns = [
                new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
                new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i')
            ]
            for (const pattern of patterns) {
                const match = html.match(pattern)
                if (match?.[1]) {
                    return decodeEntities(match[1])
                }
            }
        }
        return ''
    }

    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
    const title = pickMeta(['og:title', 'twitter:title']) || decodeEntities(titleTag)
    const description = pickMeta(['og:description', 'twitter:description', 'description'])
    const image = pickMeta(['og:image', 'twitter:image'])
    const site = pickMeta(['og:site_name']) || new URL(baseUrl).hostname

    let resolvedImage = ''
    if (image) {
        try {
            resolvedImage = new URL(image, baseUrl).toString()
        } catch {
            resolvedImage = ''
        }
    }

    return {
        url: baseUrl,
        title: title.slice(0, 200),
        description: description.slice(0, 400),
        image: resolvedImage,
        site: site.slice(0, 80)
    }
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 */
async function readLimitedText(response, maxBytes) {
    const reader = response.body?.getReader()
    if (!reader) {
        return ''
    }
    const decoder = new TextDecoder()
    let received = 0
    let text = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > maxBytes) {
            await reader.cancel()
            break
        }
        text += decoder.decode(value, { stream: true })
    }
    return text
}

function applyCors(req, res, allowedOrigins) {
    const origin = req.headers.origin
    if (allowedOrigins.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', '*')
    } else if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-File-Name,X-File-Type,X-Room-Id')
    res.setHeader('Access-Control-Max-Age', '86400')
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    })
    res.end(body)
}

/**
 * @param {{ config: object, logger: object, relay: import('./relay-store.js').RelayStore }} options
 */
export function createHttpHandler({ config, logger, relay }) {
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
            sendJson(res, 400, { error: '无效的请求地址', code: 'INVALID_URL' })
            return
        }

        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                sendJson(res, 200, {
                    status: 'ok',
                    uptime: Math.round(process.uptime()),
                    relay: config.relay.enabled
                })
                return
            }

            if (req.method === 'GET' && url.pathname === '/api/link-preview') {
                const target = parsePublicUrl(url.searchParams.get('url') || '')
                const cached = previewCache.get(target.toString())
                if (cached && cached.expiresAt > Date.now()) {
                    sendJson(res, 200, cached.data)
                    return
                }

                const response = await fetch(target, {
                    redirect: 'follow',
                    signal: AbortSignal.timeout(config.preview.timeoutMs),
                    headers: {
                        'User-Agent': PREVIEW_UA,
                        Accept: 'text/html,application/xhtml+xml'
                    }
                })
                if (!response.ok) {
                    throw new RelayHttpError('目标站点返回错误', 502, 'PREVIEW_FAILED')
                }
                if (isPrivateHost(new URL(response.url).hostname)) {
                    throw new RelayHttpError('不允许预览内网地址', 400, 'PRIVATE_URL')
                }
                const type = response.headers.get('content-type') || ''
                if (!type.includes('text/html')) {
                    throw new RelayHttpError('目标不是 HTML 页面', 415, 'NOT_HTML')
                }

                const html = await readLimitedText(response, config.preview.maxBytes)
                const data = extractPreview(html, response.url)
                previewCache.set(target.toString(), {
                    expiresAt: Date.now() + config.preview.cacheTtlMs,
                    data
                })
                sendJson(res, 200, data)
                return
            }

            if (req.method === 'POST' && url.pathname === '/api/relay') {
                if (!config.relay.enabled) {
                    throw new RelayHttpError('服务器中继未启用', 403, 'RELAY_DISABLED')
                }
                const length = Number(req.headers['content-length'] || 0)
                if (length && length > config.relay.maxBytes) {
                    throw new RelayHttpError('文件超过中继大小限制', 413, 'RELAY_TOO_LARGE')
                }

                const name = decodeURIComponent(String(req.headers['x-file-name'] || 'file'))
                const meta = await relay.put(req, {
                    name,
                    type: String(req.headers['x-file-type'] || 'application/octet-stream')
                })
                logger.info('relay_uploaded', { id: meta.id, size: meta.size })
                sendJson(res, 200, {
                    ...meta,
                    url: `/api/relay/${meta.id}`
                })
                return
            }

            if (req.method === 'GET' && url.pathname.startsWith('/api/relay/')) {
                const id = url.pathname.slice('/api/relay/'.length)
                const record = await relay.get(id)
                if (!record) {
                    throw new RelayHttpError('中继文件不存在或已过期', 404, 'RELAY_NOT_FOUND')
                }
                res.writeHead(200, {
                    'Content-Type': record.meta.type,
                    'Content-Length': record.size,
                    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.meta.name)}`,
                    'Cache-Control': 'private, max-age=300'
                })
                createReadStream(record.path).pipe(res)
                return
            }

            sendJson(res, 404, { error: 'Not Found' })
        } catch (error) {
            if (error instanceof RelayHttpError) {
                sendJson(res, error.status, { error: error.message, code: error.code })
                return
            }
            if (error?.code === 'RELAY_TOO_LARGE') {
                sendJson(res, 413, { error: error.message, code: error.code })
                return
            }
            logger.warn('http_request_failed', {
                path: url.pathname,
                error: error.message
            })
            sendJson(res, 500, { error: '服务器处理请求失败' })
        }
    }
}
