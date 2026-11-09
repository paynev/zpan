// CF Workers scheduled() handler.
//
// Workers Free allows only 5 cron triggers per ACCOUNT, shared by every Worker
// on the account (other Workers on the same account already consume quota, and
// a failed trigger update is not rolled back). This project therefore registers
// a SINGLE hourly cron and fans out inside the handler by UTC time, instead of
// registering one cron per job.
//
// Schedule (all times UTC, the cron fires at minute 10):
//   every hour     WebDAV lock / resource-change cleanup
//   hour === 4     expired trash purge (daily)
//   hour % 12 === 0 instance telemetry heartbeat (every 12 hours)

import { createDeps } from '../server/composition'
import { createCloudflarePlatform } from '../server/platform/cloudflare'
import { purgeExpiredTrash, resolveTrashRetentionDays } from '../server/usecases/object'
import { purgeExpiredResourceChanges } from '../server/usecases/resource-changes'
import { INSTANCE_TELEMETRY_CRON, reportInstanceTelemetry } from '../server/usecases/site/instance-telemetry'

// Subset of the worker Env used by the scheduled handler.
// The full Env is defined in bootstrap.ts; this avoids circular imports.
export interface ScheduledEnv {
  DB: D1Database
  ZPAN_TELEMETRY_ALLOW_IP?: string
  ZPAN_TRASH_RETENTION_DAYS?: string
  [key: string]: unknown
}

// Must stay in sync with [triggers].crons in wrangler.toml (exactly one entry).
const HOURLY_CRON = '10 * * * *'
// Daily trash purge runs in the hour after 04:00 (was `0 4 * * *`).
const TRASH_PURGE_UTC_HOUR = 4
// Telemetry heartbeat every 12 hours (was `0 */12 * * *`); the cron expression
// is still reported as the schedule for parity with the Node runtime entry.
const TELEMETRY_UTC_HOUR_INTERVAL = 12
type ScheduledTrigger = Pick<ScheduledEvent, 'cron'>

function envAllowsIp(value: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '')
}

export async function handleScheduled(event: ScheduledTrigger, env: ScheduledEnv): Promise<void> {
  if (event.cron !== HOURLY_CRON) {
    return
  }
  const platform = createCloudflarePlatform(env)
  const deps = createDeps(platform)
  const now = new Date()
  const hour = now.getUTCHours()

  await Promise.all([deps.webdavState.purgeExpiredLocks(), purgeExpiredResourceChanges(deps, now)])

  if (hour === TRASH_PURGE_UTC_HOUR) {
    await purgeExpiredTrash(deps, resolveTrashRetentionDays(env.ZPAN_TRASH_RETENTION_DAYS))
  }

  if (hour % TELEMETRY_UTC_HOUR_INTERVAL === 0) {
    await reportInstanceTelemetry(deps, {
      config: {
        allowIp: envAllowsIp(env.ZPAN_TELEMETRY_ALLOW_IP),
      },
      cron: INSTANCE_TELEMETRY_CRON,
      trigger: 'scheduled',
      runtime: {
        runtime: 'workerd',
        platform: 'cloudflare-workers',
      },
    })
  }
}
