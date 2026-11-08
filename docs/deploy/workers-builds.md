# Deploy with Cloudflare Workers Builds

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) is Cloudflare's own Git integration for Workers. Connect the repository in the dashboard and every push to the production branch builds and deploys automatically — no GitHub Actions secrets, no local `wrangler deploy`, no API token stored in the repository.

Use this path when the code you want to deploy **is this repository** (a fork with your own changes). The [`deploy-cloudflare.yml`](../../.github/workflows/deploy-cloudflare.yml) workflow is a different path: it checks out the upstream `saltbo/zpan` **release tag**, so local customisations are never included.

This project already targets Workers Builds: `deploy.yml` skips its dispatcher for the upstream repo, `scripts/app-version.mjs` reads `WORKERS_CI_COMMIT_SHA` (Workers Builds checkouts have no git tags), and the scripts below keep D1 migrations in the deploy phase.

## 1. One-time account setup

### Connect the repository

**Workers & Pages → Create → Workers → Connect to Git**, select this repository and the production branch `main`. The Worker **must be named `zpan`** — it has to match `name = "zpan"` in `wrangler.toml`, otherwise the build fails.

There is also a [**Deploy to Cloudflare** button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) flow (`https://deploy.workers.cloudflare.com/?url=<your repo>`). It provisions resources and configures Workers Builds in one step, but it **clones the source into a new repository** in your account and requires the source repo to be public. It is meant for sharing public templates, not for deploying an existing private fork.

### D1 and KV are created automatically

You do **not** need to create the D1 database or the KV namespace by hand. Since [Wrangler 4.45 (open beta)](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/), bindings declared without resource IDs are provisioned on the target account during `wrangler deploy`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "zpan-dba"

[[kv_namespaces]]
binding = "CACHE_KV"
```

`wrangler.toml` is committed in exactly this form, so no account-specific IDs live in the repository. This repo pins `wrangler ^4.136.2`, well above the minimum. Supported auto-provisioned resources are KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces and Queues.

How it behaves:

- On the first deploy, Wrangler calls the Cloudflare API to create the D1 database and KV namespace (named with the Worker name as prefix) and binds them to the Worker.
- When deploying from the dashboard / GitHub, the generated IDs are visible in the dashboard but are **not written back to the repository**. That is expected: Wrangler keeps the resources linked by name across future deploys, so nothing needs committing. A local `wrangler deploy` will write the IDs back into the config file instead.
- `wrangler dev` likewise creates local resources automatically, persisted between runs. See [Local development](#6-local-development).

**Not auto-provisioned:** `WEBDAV_RATE_LIMITER` (`[[ratelimits]]`). Rate limiting bindings are not in the supported list — and they do not need creating. `namespace_id` is simply an arbitrary positive integer you choose, unique within your Cloudflare account; it is a namespace label, not a pre-created resource. The committed `2802` works on any account. Change it only if it collides with another Worker on the same account (same `namespace_id` = shared counters).

**Optional — pin existing resources.** If you want to reuse a D1 database / KV namespace you already created, set the build variables `ZPAN_D1_DATABASE_ID`, `ZPAN_KV_NAMESPACE_ID` (and `ZPAN_RATELIMIT_NAMESPACE_ID` for a different namespace label), or commit the IDs back into `wrangler.toml`. The build phase upserts them into the **first** (top-level) binding block only. With no overrides set, the script prints `Auto-provisioning mode` and does nothing to the config.

### Grant the build token D1 access (if needed)

The API token Workers Builds generates automatically is documented with these permissions: Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit), Workers Routes (edit), User Details (read), Memberships (read). **No D1 permission is listed.** Creating a D1 database and running remote migrations both touch D1, so if the first deploy or the migration step reports a 403 / authorization error:

Go to **My Profile → API Tokens**, find the token named `Workers Builds`, and add `Account → D1 → Edit`. Adding it up front is harmless and recommended. Use the same token for all deployments of this Worker so permissions stay consistent. (There are 2026 field reports that the default token already succeeds; this may vary by account.)

### Set runtime secrets

In the Worker's **Settings → Variables and Secrets** (not Build variables — those are build-time only and invisible at runtime):

| Name | Value |
| --- | --- |
| `ZPAN_USERNAME` | Single administrator login name — a plain username (e.g. `admin`) **or** an email address |
| `ZPAN_PASSWORD` | Single administrator password |

Set them **before the first request**. `ensureAdminSeed` creates the admin only when the `user` table is empty, and the seed promise is cached per isolate — adding secrets later requires a new deployment. Do **not** set `BETTER_AUTH_SECRET`: the app derives a stable 64-character signing key from these two values with HMAC-SHA256. An older deployment that still has an explicit `BETTER_AUTH_SECRET` secret will override the derived value; remove it with `pnpm exec wrangler secret delete BETTER_AUTH_SECRET` (this invalidates existing sessions).

`ZPAN_USERNAME` accepts a username (letters, digits, dots, hyphens, underscores) or a full email address. A plain username is mapped to `<name>@zpan.local` internally because Better Auth's credential sign-in requires an email-shaped identifier; the seed and the sign-in form share the same normalisation, and both lower-case the value (Better Auth looks users up with `email.toLowerCase()`). No email is ever sent — outbound email was removed. So `admin` and `admin@zpan.local` denote the same account. Keep the value stable: it also derives the signing key, so changing it logs everyone out.

The `cloudflare.bindings` descriptions in `package.json` and `.dev.vars.example` let the Deploy-to-Cloudflare setup page prompt for these values. Do **not** also declare them under `[vars]` in `wrangler.toml`: a same-named plaintext var collides with the secret binding and would be committed to git. Only non-sensitive settings such as `ZPAN_CACHE_MODE` belong in `[vars]`.

### Cron triggers and the Free plan quota

Workers Free allows **5 cron triggers per account** — shared by every Worker on the account, not 5 per Worker. Workers Paid allows 250. Wrangler registers `[triggers].crons` at the very end of a deploy, so exceeding the quota fails **after** the Worker has already been uploaded:

```text
✘ [ERROR] Trigger configuration for "zpan" was only partially updated:
- This account has reached the Workers Free limit of 5 cron triggers per account. [code: 10072]
Successful trigger changes were not rolled back.
Failed: error occurred while running deploy command
```

This repo registers exactly three crons, each with a matching branch in `workers/scheduled.ts`:

| Cron | Job |
| --- | --- |
| `10 * * * *` | Hourly stats rollup, expired WebDAV lock and resource-change cleanup |
| `0 4 * * *` | Purge expired trash |
| `0 */12 * * *` | Instance telemetry heartbeat |

Older releases registered six (including `*/10 * * * *`, `0 */6 * * *`, `0 0 1 * *`); those three had no handler branch after the background-jobs / quota features were removed, so they were dropped. Never add a cron without a matching branch — it consumes quota and wakes the Worker for nothing.

`pnpm workers-builds:check` prints the cron count and fails if it exceeds 5; set the build variable `ZPAN_CRON_LIMIT` on Workers Paid. If other Workers on the account already use cron triggers, budget accordingly or remove their unused ones in **Workers & Pages → &lt;Worker&gt; → Settings → Triggers**. A failed partial update leaves triggers registered and is not rolled back, so check that page after a failed deploy. If three is still too many, all three jobs can be folded into one hourly cron by branching on the UTC hour inside `workers/scheduled.ts`.

A failed trigger update also aborts the rest of `pnpm workers-builds:deploy`: `wrangler deploy` exits non-zero, so the remote D1 migration step is skipped. Re-run the deployment (push again) after fixing the config — the new cron list replaces the partial one, and migrations will then run.

### Build variables

| Name | Value | Why |
| --- | --- | --- |
| `NODE_VERSION` | `24` | `engines` requires Node >= 24; the Cloudflare build VM does not honour the Volta pin |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID | Needed by the remote D1 migration; the script warns if it is absent |
| `ZPAN_D1_DATABASE_ID` / `ZPAN_KV_NAMESPACE_ID` | optional | Pin existing resources instead of auto-provisioning |
| `ZPAN_D1_DATABASE_NAME` | optional | Force which remote D1 database `workers-builds:migrate` / `verify` target when the account has several |
| `ZPAN_CRON_LIMIT` | optional | Cron trigger ceiling checked by `workers-builds:check`; defaults to `5` (Workers Free), raise it on Workers Paid |
| `ZPAN_SYNC_WEBDAV` | `1` | Optional WebDAV post-processing (see below) |

`packageManager` is already an exact semver (`pnpm@10.30.2`), which is what corepack/Workers Builds needs to provision the right pnpm; `PNPM_VERSION` is not required.

## 2. Builds settings

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `/` (leave empty) |
| Build command | `pnpm workers-builds:build` |
| Deploy command | `pnpm workers-builds:deploy` |
| Preview builds | **Disabled** (see below) |
| Build cache | Enabled |

What each command does:

- `pnpm workers-builds:build` → optionally pin resource IDs from `ZPAN_*_ID` variables → `pnpm build` (agent-skills + Vite, producing `dist/zpan/wrangler.json`) → verify that the generated Worker name is `zpan` and that the `DB` / `CACHE_KV` bindings are present.
- `pnpm workers-builds:deploy` → `wrangler deploy` (**creates D1/KV on a fresh account**) → resolve the remote D1 UUID(s) and run `wrangler d1 migrations apply <uuid> --remote` → **verify the business tables exist** → optional WebDAV post-processing.

**Deploy runs before migrations on purpose.** With no IDs in the config, the remote database does not exist until `wrangler deploy` provisions it; migrating first would fail on a brand-new account. The few-second window before migrations finish is harmless as long as migrations stay additive.

**Migrations must target the UUID, not the `DB` binding.** `wrangler d1 ... DB` resolves the binding through the config: with no `database_id`, Wrangler looks up `database_name` (`zpan-dba`) in the API. An auto-provisioned database is named `<worker>-<binding>` (`zpan-db`), so that lookup can miss — or worse, hit a different empty database — and the Worker then fails with `D1_ERROR: no such table: system_options`. The deploy script instead runs `wrangler d1 list --json`, migrates every plausible `zpan*` database by UUID (migrations are idempotent via `d1_migrations`), and then queries `sqlite_master` for `d1_migrations`, `system_options`, `user`, `account`, `session`. If none of them exist, the deploy **fails loudly** instead of leaving an empty schema behind.

Double-check this setting after a deploy that "succeeded" but has no business tables: if the log never shows `$ wrangler d1 list --json` / `$ wrangler d1 migrations apply`, the dashboard is still running the default `wrangler deploy` as its Deploy command.

If Cloudflare does not install dependencies automatically (or the log shows `pnpm: command not found`), use this Build command instead:

```sh
corepack enable && pnpm install --frozen-lockfile && pnpm workers-builds:build
```

Run `pnpm workers-builds:check` locally for a read-only self-check of the bindings, any configured overrides, and the generated deploy config.

### Inspect / repair the remote D1 schema

Two commands work on an already-deployed Worker, without redeploying it:

| Command | Effect |
| --- | --- |
| `pnpm workers-builds:verify` | Read-only: lists remote D1 databases, tables in each `zpan*` database and the applied migration count. Exits non-zero if there are no business tables |
| `pnpm workers-builds:migrate` | Applies migrations to the remote database(s) and verifies the core tables; `pnpm db:migrate:d1:prod` is an alias |

Both need Cloudflare credentials in the environment (the token needs `Account → D1 → Edit`; `wrangler login` works locally too):

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm workers-builds:verify
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... pnpm workers-builds:migrate
```

On Windows PowerShell, set them with `$env:CLOUDFLARE_API_TOKEN = "..."` and `$env:CLOUDFLARE_ACCOUNT_ID = "..."` first. If the account has several unrelated D1 databases, pin the target with `ZPAN_D1_DATABASE_ID=<uuid>` (or `ZPAN_D1_DATABASE_NAME=<name>`); `verify` prints the UUIDs.

## 3. Avoid double deploys

`deploy.yml` enables its Cloudflare branch only when all four **Actions** secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ZPAN_USERNAME`, `ZPAN_PASSWORD`) are present. After switching to Workers Builds, remove those Actions secrets (this does **not** touch the Worker runtime secrets) or disable the `Deploy to Cloudflare Workers` workflow in the Actions tab. Otherwise one push deploys twice — and the two deploys contain different code, because the Actions workflow builds the upstream release tag.

Leaving the other platform workflows in place is harmless.

## 4. Preview builds

Keep them disabled. `wrangler.toml` has no `[previews]` block, and the leftover `wrangler.preview-migrations.json` plus the Cloud staging / GitHub OAuth / Stripe / `preview-tasks` sections of [worker-previews.md](worker-previews.md) describe an upstream topology whose features have since been removed. Preview builds would also register their own cron triggers against the same 5-per-account Free quota. If you ever enable Previews, define the preview bindings explicitly first.

## 5. Optional: dedicated WebDAV domain

Off by default. Set the build variable `ZPAN_SYNC_WEBDAV=1` to run the same post-deploy steps as the GitHub Actions workflow: clear WebDAV readiness in D1 → discover the primary Worker Custom Domain and attach the `dav.` hostname plus its Transform Rule → record readiness back into D1. D1 commands use the `DB` binding name so they work with auto-provisioned databases.

Prerequisites: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` available to the deploy phase, and the token has **Transform Rules:Edit** in addition to Workers Routes. Without a primary custom domain the step only cleans up stale managed resources and does not change behaviour. See [WebDAV custom domains](../webdav-custom-domain.md).

## 6. Local development

`wrangler dev`, `pnpm db:migrate:d1` and `pnpm test:cf` all work with the ID-less config: Wrangler creates local D1/KV resources rooted at the Worker name. If you previously ran a config with hard-coded IDs, that older local state is separate — it may look empty until you run `pnpm db:migrate:d1` once. Verified with the ID-less config: all 94 migrations apply from an empty local D1 and all 62 Cloudflare contract tests pass.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Workers Free limit of 5 cron triggers per account` (code 10072) at the end of deploy | The Worker was uploaded but the deploy command failed and **D1 migrations did not run**. Keep `[triggers].crons` at 3 (see [Cron triggers](#cron-triggers-and-the-free-plan-quota)), delete leftover triggers in the dashboard, then re-run the deployment |
| 403 / authorization error while creating D1 or migrating | Add `Account → D1 → Edit` to the `Workers Builds` token |
| `D1 database not found` on the very first deploy | Migrations must run **after** `wrangler deploy`; use `pnpm workers-builds:deploy` rather than an older `pnpm deploy` ordering |
| Deploy succeeds but the D1 database is empty / `D1_ERROR: no such table: system_options` | The Deploy command in **Settings → Build** is probably still the default `wrangler deploy`, which never runs migrations. Set it to `pnpm workers-builds:deploy`, or run `pnpm workers-builds:migrate` once to repair, then confirm with `pnpm workers-builds:verify` |
| `Couldn't find a D1 DB named 'zpan-dba'` in the deploy log | Old migration step resolved the `DB` binding by name. The current script migrates by UUID instead; pull the latest commit and redeploy |
| `Could not decide which D1 database to migrate` | Several unrelated D1 databases on the account; set `ZPAN_D1_DATABASE_ID` to the UUID printed by `pnpm workers-builds:verify` |
| Rate limit counters shared with another Worker | `WEBDAV_RATE_LIMITER` `namespace_id` is an arbitrary account-local integer; pick a unique one |
| Worker name mismatch on build | The dashboard Worker must be named `zpan` |
| `Invalid package manager specification` | `packageManager` must be an exact semver, not a range (this repo pins `pnpm@10.30.2`) |
| `pnpm: command not found` | Use the explicit `corepack enable && pnpm install ...` Build command |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 10 blocks dependency build scripts; this repo declares `onlyBuiltDependencies` — verify the lockfile is unchanged |
| Deploy succeeds but nobody can sign in | Runtime secrets missing or set too late; set them under **Variables and Secrets**, then redeploy |
| `Generated config is missing the DB or CACHE_KV binding` | Build phase did not run, or `wrangler.toml` top-level bindings were renamed |
| `pnpm test:cf` fails locally: `requires compatibility date ... newest date supported by this server binary is ...` | The workerd binary bundled with `vitest-pool-workers` is older than `compatibility_date` in `wrangler.toml`. Production is unaffected (a deploy uploads the Worker; it does not boot a local runtime). Temporarily lower `compatibility_date` for local tests, or update the pool/workerd packages |
| Login works locally but not on the deployment | Runtime secrets are build-time only or were added after the first seed; both values also derive the signing key, so changing either logs everyone out. Plain usernames are allowed (`admin` → `admin@zpan.local`) |

## References

- [Automatic resource provisioning (changelog, 2025-10-24)](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
- [Wrangler configuration → Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/) (cron triggers: 5 per account on Free, 250 on Paid)
