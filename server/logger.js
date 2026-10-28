/**
 * 极简结构化日志。
 *
 * 输出单行 JSON，方便被 Docker / Loki / ELK 直接采集；
 * 不依赖任何第三方库，避免为了日志引入额外运行时。
 */

const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100
}

/**
 * @param {{ level?: string, stream?: Pick<Console, 'log'|'warn'|'error'> }} [options]
 */
export function createLogger({ level = 'info', stream = console } = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info

    const write = (levelName, event, fields = {}) => {
        if (LEVELS[levelName] < threshold) {
            return
        }
        const record = {
            time: new Date().toISOString(),
            level: levelName,
            event,
            ...fields
        }
        const line = JSON.stringify(record)
        if (levelName === 'error') {
            stream.error(line)
        } else if (levelName === 'warn') {
            stream.warn(line)
        } else {
            stream.log(line)
        }
    }

    return {
        debug: (event, fields) => write('debug', event, fields),
        info: (event, fields) => write('info', event, fields),
        warn: (event, fields) => write('warn', event, fields),
        error: (event, fields) => write('error', event, fields)
    }
}

export const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' })
