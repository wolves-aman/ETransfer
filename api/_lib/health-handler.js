import { backend } from './store.js'

export default function handler(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' })
    res.end(JSON.stringify({
        status: 'ok',
        sse: true,
        store: backend
    }))
}
