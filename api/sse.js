import eventsHandler from './_lib/events-handler.js'
import healthHandler from './_lib/health-handler.js'
import signalHandler from './_lib/signal-handler.js'

/**
 * 单 Function 同时承载 GET SSE / POST 信令 / 健康检查。
 *
 * 这样 events 和 signal 共享同一个模块作用域的内存存储，
 * 不再依赖 Redis。代价是只适合单实例，Vercel 多实例时会丢房间。
 */
export default async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    let route = url.searchParams.get('route')

    if (!route) {
        if (url.pathname.endsWith('/events')) route = 'events'
        else if (url.pathname.endsWith('/signal')) route = 'signal'
        else if (url.pathname.endsWith('/health')) route = 'health'
        else route = req.method === 'POST' ? 'signal' : 'events'
    }

    if (route === 'events') {
        await eventsHandler(req, res)
        return
    }
    if (route === 'signal') {
        await signalHandler(req, res)
        return
    }
    if (route === 'health') {
        await healthHandler(req, res)
        return
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' })
    res.end(JSON.stringify({ error: 'Not Found', code: 'NOT_FOUND' }))
}
