/* ETransfer service worker: app shell cache + PWA Share Target */
const CACHE = 'etransfer-shell-v3'
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(SHELL))
            .catch(() => null)
            .then(() => self.skipWaiting())
    )
})

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys()
        await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
        await self.clients.claim()
    })())
})

self.addEventListener('fetch', (event) => {
    const request = event.request
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
        event.respondWith(handleShareTarget(request))
        return
    }

    if (request.method !== 'GET' || url.origin !== self.location.origin) {
        return
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
        return
    }

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request))
        return
    }
    event.respondWith(cacheFirst(request))
})

async function networkFirst(request) {
    try {
        const response = await fetch(request)
        const cache = await caches.open(CACHE)
        cache.put(request, response.clone()).catch(() => {})
        return response
    } catch {
        return (await caches.match(request)) || (await caches.match('./index.html'))
    }
}

async function cacheFirst(request) {
    const cached = await caches.match(request)
    if (cached) return cached
    try {
        const response = await fetch(request)
        if (response.ok) {
            const cache = await caches.open(CACHE)
            cache.put(request, response.clone()).catch(() => {})
        }
        return response
    } catch {
        return new Response('', { status: 504 })
    }
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('etransfer', 3)
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains('messages')) {
                const store = db.createObjectStore('messages', { keyPath: 'id' })
                store.createIndex('roomId', 'roomId', { unique: false })
            }
            if (!db.objectStoreNames.contains('shares')) {
                db.createObjectStore('shares', { keyPath: 'id', autoIncrement: true })
            }
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' })
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

async function handleShareTarget(request) {
    try {
        const form = await request.formData()
        const files = form.getAll('files').filter((file) => file && file.size > 0)
        if (files.length) {
            const db = await openDatabase()
            await new Promise((resolve) => {
                const transaction = db.transaction('shares', 'readwrite')
                const store = transaction.objectStore('shares')
                for (const file of files) {
                    store.add({
                        name: file.name,
                        type: file.type,
                        lastModified: file.lastModified || Date.now(),
                        blob: file,
                        createdAt: Date.now()
                    })
                }
                transaction.oncomplete = resolve
                transaction.onerror = resolve
            })
        }
    } catch {
        // 分享失败也回到首页，不阻塞用户
    }
    return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303)
}
