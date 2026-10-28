import { createSignalingServer } from './app.js'

const app = createSignalingServer()
const { config, logger } = app

let shuttingDown = false

/**
 * 优雅关闭：先广播关闭帧，再停止监听；超时则强制退出。
 *
 * @param {string} signal
 */
async function shutdown(signal) {
    if (shuttingDown) {
        return
    }
    shuttingDown = true
    logger.info('shutdown_started', { signal })

    const forceExit = setTimeout(() => {
        logger.error('shutdown_forced', { timeout: config.shutdownTimeout })
        process.exit(1)
    }, config.shutdownTimeout)
    forceExit.unref()

    try {
        await app.close()
        logger.info('shutdown_completed')
        process.exit(0)
    } catch (error) {
        logger.error('shutdown_failed', { error: error.message })
        process.exit(1)
    }
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', { error: error.stack })
    shutdown('uncaughtException')
})

process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { error: String(reason) })
    shutdown('unhandledRejection')
})

try {
    await app.listen()
} catch (error) {
    logger.error('server_start_failed', { code: error.code, error: error.message })
    process.exit(1)
}
