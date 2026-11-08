/// <reference types="node" />

// Node built-ins (node:crypto, node:os, Buffer, process, ...) are used across
// server/, shared/ and workers/. Some tsconfig projects set an explicit
// `types` array for Cloudflare Workers globals, which disables automatic
// @types discovery, so load the Node declarations explicitly here. This file
// is included by both typecheck projects through ../shared.
