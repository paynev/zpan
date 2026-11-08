#!/bin/sh
set -e

# No secret provisioning needed. The server derives BETTER_AUTH_SECRET from
# ZPAN_USERNAME / ZPAN_PASSWORD at startup using HMAC-SHA256, so the same
# credentials always produce the same 64-character signing key — no random
# value, no persisted secret file, and nothing to back up.
#
# An explicitly supplied BETTER_AUTH_SECRET still overrides the derived value.
# ZPAN_USERNAME and ZPAN_PASSWORD are required; the server fails fast with a
# clear message when they are missing.

exec "$@"
