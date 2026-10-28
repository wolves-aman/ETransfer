const DB_NAME = 'etransfer'
const DB_VERSION = 3

let databasePromise = null

function openDatabase() {
    if (!('indexedDB' in window)) {
        return Promise.resolve(null)
    }
    if (databasePromise) {
        return databasePromise
    }
    databasePromise = new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
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
        request.onerror = () => resolve(null)
    })
    return databasePromise
}

function run(storeName, mode, action) {
    return openDatabase().then((db) => {
        if (!db) return null
        return new Promise((resolve) => {
            try {
                const transaction = db.transaction(storeName, mode)
                const store = transaction.objectStore(storeName)
                const request = action(store)
                transaction.oncomplete = () => resolve(request?.result ?? null)
                transaction.onerror = () => resolve(null)
                transaction.onabort = () => resolve(null)
            } catch {
                resolve(null)
            }
        })
    })
}

export function idbPut(storeName, value) {
    return run(storeName, 'readwrite', (store) => store.put(value))
}

export function idbGetAll(storeName) {
    return run(storeName, 'readonly', (store) => store.getAll()).then((value) => value || [])
}

export function idbDelete(storeName, key) {
    return run(storeName, 'readwrite', (store) => store.delete(key))
}

export function idbClear(storeName) {
    return run(storeName, 'readwrite', (store) => store.clear())
}

export function idbGet(storeName, key) {
    return run(storeName, 'readonly', (store) => store.get(key))
}

export async function idbAddShare(files) {
    const db = await openDatabase()
    if (!db) return
    await new Promise((resolve) => {
        const transaction = db.transaction('shares', 'readwrite')
        const store = transaction.objectStore('shares')
        for (const file of files) {
            store.add({
                name: file.name,
                type: file.type,
                lastModified: file.lastModified,
                blob: file,
                createdAt: Date.now()
            })
        }
        transaction.oncomplete = resolve
        transaction.onerror = resolve
    })
}

export async function idbTakeShares() {
    const rows = await idbGetAll('shares')
    if (rows.length) {
        await idbClear('shares')
    }
    return rows
}
