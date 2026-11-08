// CF Workers scheduled() handler.

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

// These three expressions must stay in sync with [triggers].crons in
// wrangler.toml. Any cron registered there without a matching branch below is
// a no-op invocation that still consumes the account's cron trigger quota
// (5 on Workers Free, shared across all Workers on the account).
const STATS_ROLLUP_CRON = '10 * * * *'
const TRASH_PURGE_CRON = '0 4 * * *'
// INSTANCE_TELEMETRY_CRON ('0 */12 * * *') is imported from
// server/usecases/site/instance-telemetry.ts.
type ScheduledTrigger = Pick<ScheduledEvent, 'cron'>

function envAllowsIp(value: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '')
}

export async function handleScheduled(event: ScheduledTrigger, env: ScheduledEnv): Promise<void> {
  const platform = createCloudflarePlatform(env)
  const deps = createDeps(platform)

  if (event.cron === STATS_ROLLUP_CRON) {
    const now = new Date()
    await Promise.all([
      deps.adminStats.refreshHourlyRollups(now),
      deps.webdavState.purgeExpiredLocks(),
      purgeExpiredResourceChanges(deps, now),
    ])
    return
  }

  if (event.cron === TRASH_PURGE_CRON) {
    await purgeExpiredTrash(deps, resolveTrashRetentionDays(env.ZPAN_TRASH_RETENTION_DAYS))
    return
  }

  if (event.cron === INSTANCE_TELEMETRY_CRON) {
    await reportInstanceTelemetry(deps, {
      config: {
        allowIp: envAllowsIp(env.ZPAN_TELEMETRY_ALLOW_IP),
      },
      cron: event.cron,
      trigger: 'scheduled',
      runtime: {
        runtime: 'workerd',
        platform: 'cloudflare-workers',
      },
    })
    return
  }
}
