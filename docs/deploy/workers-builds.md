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
database_name = "zpan-db"

[[kv_namespaces]]
binding = "CACHE_KV"
```

`wrangler.toml` is committed in exactly this form, so no account-specific IDs live in the repository. This repo pins `wrangler ^4.136.2`, well above the minimum. Supported auto-provisioned resources are KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces and Queues.

How it behaves:

- On the first deploy, Wrangler calls the Cloudflare API to create the D1 database and KV namespace (named with the Worker name as prefix) and binds them to the Worker.
- When deploying from the dashboard / GitHub, the generated IDs are visible in the dashboard but are **not written back to the repository**. That is expected: Wrangler keeps the resources linked by name across future deploys, so nothing needs committing. A local `wrangler deploy` will write the IDs back into the config file instead.
- `wrangler dev` likewise creates local resources automatically, persisted between runs. See [Local development](#7-local-development).

**Not auto-provisioned:** `WEBDAV_RATE_LIMITER` (`[[ratelimits]]`). Rate limiting bindings are not in the supported list — and they do not need creating. `namespace_id` is simply an arbitrary positive integer you choose, unique within your Cloudflare account; it is a namespace label, not a pre-created resource. The committed `2801` works on any account. Change it only if it collides with another Worker on the same account (same `namespace_id` = shared counters).

**Optional — pin existing resources.** If you want to reuse a D1 database / KV namespace you already created, set the build variables `ZPAN_D1_DATABASE_ID`, `ZPAN_KV_NAMESPACE_ID` (and `ZPAN_RATELIMIT_NAMESPACE_ID` for a different namespace label), or commit the IDs back into `wrangler.toml`. The build phase upserts them into the **top-level** binding blocks only; the `[previews]` block is left untouched. With no overrides set, the script prints `Auto-provisioning mode` and does nothing to the config.

### Grant the build token D1 access (if needed)

The API token Workers Builds generates automatically is documented with these permissions: Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit), Workers Routes (edit), User Details (read), Memberships (read). **No D1 permission is listed.** Creating a D1 database and running remote migrations both touch D1, so if the first deploy or the migration step reports a 403 / authorization error:

Go to **My Profile → API Tokens**, find the token named `Workers Builds`, and add `Account → D1 → Edit`. Adding it up front is harmless and recommended. Use the same token for all deployments of this Worker so permissions stay consistent. (There are 2026 field reports that the default token already succeeds; this may vary by account.)

### Set runtime secrets

In the Worker's **Settings → Variables and Secrets** (not Build variables — those are build-time only and invisible at runtime):

| Name | Value |
| --- | --- |
| `ZPAN_USERNAME` | Single administrator login identity (an email address) |
| `ZPAN_PASSWORD` | Single administrator password |

Set them **before the first request**. `ensureAdminSeed` creates the admin only when the `user` table is empty, and the seed promise is cached per isolate — adding secrets later requires a new deployment. Do **not** set `BETTER_AUTH_SECRET`: the app derives a stable 64-character signing key from these two values with HMAC-SHA256. An older deployment that still has an explicit `BETTER_AUTH_SECRET` secret will override the derived value; remove it with `pnpm exec wrangler secret delete BETTER_AUTH_SECRET` (this invalidates existing sessions).

The `cloudflare.bindings` descriptions in `package.json` and `.dev.vars.example` let the Deploy-to-Cloudflare setup page prompt for these values.

### Build variables

| Name | Value | Why |
| --- | --- | --- |
| `NODE_VERSION` | `24` | `engines` requires Node >= 24; the Cloudflare build VM does not honour the Volta pin |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID | Needed by the remote D1 migration; the script warns if it is absent |
| `ZPAN_D1_DATABASE_ID` / `ZPAN_KV_NAMESPACE_ID` | optional | Pin existing resources instead of auto-provisioning |
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
- `pnpm workers-builds:deploy` → `wrangler deploy` (**creates D1/KV on a fresh account**) → `pnpm db:migrate:d1:prod` (`wrangler d1 migrations apply DB --remote`) → optional WebDAV post-processing.

**Deploy runs before migrations on purpose.** With no IDs in the config, the remote database does not exist until `wrangler deploy` provisions it; migrating first would fail on a brand-new account. The few-second window before migrations finish is harmless as long as migrations stay additive. Migrations reference the **binding name** `DB` rather than the database name, per Cloudflare's [Deploy button best practice](https://developers.cloudflare.com/workers/platform/deploy-buttons/), so a renamed resource still resolves.

If Cloudflare does not install dependencies automatically (or the log shows `pnpm: command not found`), use this Build command instead:

```sh
corepack enable && pnpm install --frozen-lockfile && pnpm workers-builds:build
```

Run `pnpm workers-builds:check` locally for a read-only self-check of the bindings, any configured overrides, and the generated deploy config.

## 3. Avoid double deploys

`deploy.yml` enables its Cloudflare branch only when all four **Actions** secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ZPAN_USERNAME`, `ZPAN_PASSWORD`) are present. After switching to Workers Builds, remove those Actions secrets (this does **not** touch the Worker runtime secrets) or disable the `Deploy to Cloudflare Workers` workflow in the Actions tab. Otherwise one push deploys twice — and the two deploys contain different code, because the Actions workflow builds the upstream release tag.

Leaving the other platform workflows in place is harmless.

## 4. Preview builds

Keep them disabled. The `[previews]` bindings in `wrangler.toml` and `wrangler.preview-migrations.json` still carry the upstream account's staging D1/KV/ratelimit IDs, and the Cloud staging / GitHub OAuth / Stripe / `preview-tasks` sections of [worker-previews.md](worker-previews.md) describe features that have since been removed. Unlike the top-level bindings, these preview blocks have explicit IDs and therefore will **not** be auto-provisioned. If you enable Previews, remove those IDs or replace them with your own first.

## 5. Optional: dedicated WebDAV domain

Off by default. Set the build variable `ZPAN_SYNC_WEBDAV=1` to run the same post-deploy steps as the GitHub Actions workflow: clear WebDAV readiness in D1 → discover the primary Worker Custom Domain and attach the `dav.` hostname plus its Transform Rule → record readiness back into D1. D1 commands use the `DB` binding name so they work with auto-provisioned databases.

Prerequisites: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` available to the deploy phase, and the token has **Transform Rules:Edit** in addition to Workers Routes. Without a primary custom domain the step only cleans up stale managed resources and does not change behaviour. See [WebDAV custom domains](../webdav-custom-domain.md).

## 6. Local development

`wrangler dev`, `pnpm db:migrate:d1` and `pnpm test:cf` all work with the ID-less config: Wrangler creates local D1/KV resources rooted at the Worker name. If you previously ran a config with hard-coded IDs, that older local state is separate — it may look empty until you run `pnpm db:migrate:d1` once. Verified with the ID-less config: all 94 migrations apply from an empty local D1 and all 62 Cloudflare contract tests pass.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| 403 / authorization error while creating D1 or migrating | Add `Account → D1 → Edit` to the `Workers Builds` token |
| `D1 database not found` on the very first deploy | Migrations must run **after** `wrangler deploy`; use `pnpm workers-builds:deploy` rather than an older `pnpm deploy` ordering |
| Rate limit counters shared with another Worker | `WEBDAV_RATE_LIMITER` `namespace_id` is an arbitrary account-local integer; pick a unique one |
| Worker name mismatch on build | The dashboard Worker must be named `zpan` |
| `Invalid package manager specification` | `packageManager` must be an exact semver, not a range (this repo pins `pnpm@10.30.2`) |
| `pnpm: command not found` | Use the explicit `corepack enable && pnpm install ...` Build command |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 10 blocks dependency build scripts; this repo declares `onlyBuiltDependencies` — verify the lockfile is unchanged |
| Deploy succeeds but nobody can sign in | Runtime secrets missing or set too late; set them under **Variables and Secrets**, then redeploy |
| `Generated config is missing the DB or CACHE_KV binding` | Build phase did not run, or `wrangler.toml` top-level bindings were renamed |
| Login works locally but not on the deployment | `ZPAN_USERNAME` must be an email address; both values also derive the signing key, so changing either logs everyone out |

## References

- [Automatic resource provisioning (changelog, 2025-10-24)](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
- [Wrangler configuration → Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
