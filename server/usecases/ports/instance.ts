// Instance identity: a stable per-installation id + display name, both stored
// in system_options. Shared by telemetry, the admin About page, and internal
// report routes. (Extracted from the former licensing ports — the instance
// identity survives the licensing removal; the cloud binding does not.)

export interface InstanceRepo {
  getOrCreateInstanceId(): Promise<string>
  getInstanceDisplayName(): Promise<string>
}

// Runtime/engine snapshot reported for the instance. The coarse shape matches
// what external report consumers expect.
export interface CloudInstanceInfo {
  id: string
  name: string
  url: string
  version: string
  commit?: string | null
  runtime?: {
    provider: 'cloudflare' | 'node'
    target: 'cloudflare-worker' | 'node/docker'
  } | null
  server?: { os?: { platform?: string | null; arch?: string | null; release?: string | null } | null } | null
  node?: { version?: string | null } | null
}
