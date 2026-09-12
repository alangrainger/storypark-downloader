import { createServer } from 'node:http'
import { AuthError } from './api.js'
import { loadConfig } from './config.js'
import { log } from './log.js'
import { syncAll, type SyncStats } from './sync.js'

const config = loadConfig()

/** State exposed on /health for Uptime Kuma. */
const health = {
  status: 'starting' as 'starting' | 'ok' | 'auth_error' | 'error',
  lastRun: null as string | null,
  lastSuccess: null as string | null,
  lastError: null as string | null,
  lastStats: null as SyncStats | null,
}

async function runOnce(): Promise<void> {
  health.lastRun = new Date().toISOString()
  try {
    const stats = await syncAll(config)
    health.status = 'ok'
    health.lastSuccess = health.lastRun
    health.lastError = null
    health.lastStats = stats
    log.info(
      `done: ${stats.children} children, ${stats.stories} stories, ${stats.downloaded} downloaded, ` +
        `${stats.skipped} already present, ${stats.stamped} dates embedded, ${stats.failed} failed`,
    )
  } catch (err) {
    health.lastError = (err as Error).message
    if (err instanceof AuthError) {
      health.status = 'auth_error'
      log.error(`COOKIE EXPIRED: ${err.message}`)
    } else {
      health.status = 'error'
      log.error(`run failed: ${(err as Error).stack ?? err}`)
    }
  }
}

function startHealthServer(): void {
  createServer((req, res) => {
    if (req.url === '/health') {
      const ok = health.status === 'ok' || health.status === 'starting'
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(health))
    } else {
      res.writeHead(404).end()
    }
  }).listen(config.port, () => log.info(`health endpoint on :${config.port}/health`))
}

async function main(): Promise<void> {
  const cadence = config.intervalMs ? `every ${config.intervalMs / 60000} min` : 'run once'
  log.info(`output ${config.outputDir}, ${cadence}, time zone ${config.timeZone}`)
  if (config.intervalMs === 0) {
    await runOnce()
    process.exit(health.status === 'ok' ? 0 : 1)
  }
  startHealthServer()
  for (;;) {
    await runOnce()
    await new Promise(r => setTimeout(r, config.intervalMs))
  }
}

main().catch(err => {
  log.error(String(err))
  process.exit(1)
})
