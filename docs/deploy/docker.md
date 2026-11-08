# Docker Deployment

ZPan ships as a single Docker image. By default it uses an embedded SQLite database (`better-sqlite3`). For production multi-replica deployments you can opt into [Turso](https://turso.tech) (libSQL) as a shared remote database.

## Image tags

ZPan publishes a single server image to `ghcr.io/saltbo/zpan`.

| Tag | Built from | When | Use for |
| --- | --- | --- | --- |
| `latest`, `2.6.1`, `2.6`, `2` | release tags (`v*`) | on every release | **production** — stable, version-pinned |
| `dev` | `main` HEAD | every push to `main` (after CI passes) | trying the newest code as soon as it lands |
| `nightly` | `main` HEAD | daily, full no-cache rebuild | newest code **plus** fresh base-image/OS security patches |

`dev` and `nightly` are moving, unreviewed tags — do not pin production to them. Pulling without a tag (`ghcr.io/saltbo/zpan`) resolves to `latest`.

## Default: local SQLite

No extra configuration needed. Mount a volume so the database survives container restarts:

```yaml
services:
  zpan:
    image: ghcr.io/saltbo/zpan:latest
    ports:
      - "8222:8222"
    environment:
      PORT: 8222
      BETTER_AUTH_URL: https://your-domain.example
      DATABASE_URL: /data/zpan.db
      ZPAN_USERNAME: admin@example.com
      ZPAN_PASSWORD: <choose-a-strong-password>
    volumes:
      - zpan-data:/data
    restart: unless-stopped

volumes:
  zpan-data:
```

Migrations run automatically at startup.

To expose WebDAV at the root of a dedicated hostname, enable WebDAV in Admin Settings, set the site's **Public URL**, and configure your front proxy to route `dav.<public-hostname>` to ZPan while internally prefixing requests with `/dav`. A different hostname can be configured in the WebDAV settings drawer. See [WebDAV custom domains](../webdav-custom-domain.md) for the complete proxy contract.

## Turso (libSQL) opt-in

Set `TURSO_DATABASE_URL` to switch from local SQLite to a Turso (or self-hosted libSQL) database. `TURSO_AUTH_TOKEN` is required for remote URLs; it can be omitted for local `file://` URLs.

```yaml
services:
  zpan:
    image: ghcr.io/saltbo/zpan:latest
    ports:
      - "8222:8222"
    environment:
      PORT: 8222
      BETTER_AUTH_URL: https://your-domain.example
      TURSO_DATABASE_URL: libsql://your-db-name-orgname.turso.io
      TURSO_AUTH_TOKEN: <your-turso-auth-token>
      ZPAN_USERNAME: admin@example.com
      ZPAN_PASSWORD: <choose-a-strong-password>
    restart: unless-stopped
```

When `TURSO_DATABASE_URL` is present:
- `DATABASE_URL` is ignored.
- Migrations are applied automatically at startup via `drizzle-orm/libsql/migrator`.
- `TURSO_AUTH_TOKEN` may be omitted only for `file://` URLs (local libSQL files).

### Running migrations manually against Turso

```sh
TURSO_DATABASE_URL=libsql://your-db.turso.io \
TURSO_AUTH_TOKEN=your-token \
pnpm db:migrate:node
```

`drizzle.config.ts` automatically switches to the `turso` dialect when `TURSO_DATABASE_URL` is set, so `pnpm db:generate` and `pnpm db:migrate:node` work against Turso without any extra flags.

### Obtaining a Turso auth token

```sh
turso db tokens create your-db-name
```

Or create one in the [Turso dashboard](https://app.turso.tech).

## Administrator account

ZPan is single-admin: self-service sign-up is disabled entirely.

- `ZPAN_USERNAME` (a plain username such as `admin`, or an email address) and
  `ZPAN_PASSWORD` are **required**. They seed the administrator on first start,
  only when the user table is empty; later restarts are a no-op. Plain usernames
  are mapped internally to `<name>@zpan.local` and lower-cased; allowed
  characters are letters, digits, dots, hyphens and underscores.
- The same pair derives `BETTER_AUTH_SECRET` with HMAC-SHA256, producing a stable
  64-character hex signing key. No separate secret needs to be generated,
  mounted or backed up. An explicit `BETTER_AUTH_SECRET` overrides the derived
  value.
- Changing either credential rotates the signing key and invalidates all
  existing sessions.

Keep `ZPAN_PASSWORD` out of image layers and rotate it if it was ever exposed.

## Background work

The Docker container runs a persistent Node.js process, so the built-in interval
jobs fire automatically — **no external cron is required**: hourly statistics
rollups, WebDAV lock expiry, resource-change retention, daily trash purge, and
optional instance telemetry. There is no licensing refresh or metered traffic
sync; those features were removed with the paid-tier architecture.
