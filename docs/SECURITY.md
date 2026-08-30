# Helix Security

> **Phase 1 status:** the secrets baseline and CSP are in place. `PermissionManager`,
> `ToolRegistry` validation and sensor indicators arrive in phases 3 and 5.

## Secrets

- **No API keys exist in this repository, and none may ever be committed.**
- `.gitignore` was the first file created in this project, before any config
  file existed that could leak. Its secrets block is intentionally first.
- Keys belong in environment variables or OS credential storage — never in
  source, never in frontend-reachable code, never in a committed config file.
- Passwords, API keys, tokens and private keys must **never** be written into
  normal memory records or logs. This is enforced, not advisory: `core/secrets.ts`
  holds one pattern list, `Logger` redacts matches before they reach a sink, and
  `MemoryManager` refuses to store them at all. Both consumers share the list so
  they cannot drift apart.

`C:\Users\selam\.claude\.credentials.json` belongs to Claude Code, not Helix. It
is not a Helix credential source and must not be read or copied into this project.

## Content Security Policy

`index.html` ships a restrictive CSP: `default-src 'self'`, no remote scripts,
`connect-src 'self'`. When cloud providers are added in phase 3, their origins
must be added explicitly and individually — never by widening to `*`.

## Filesystem

The AI gets **no unrestricted filesystem access**. Helix operates inside a
controlled workspace: its own data directories plus files the user has
explicitly authorised. Uploaded files are never executed. File type and size are
validated on upload.

## Tools

Every capability is a registered tool with a declared input schema. Arguments are
validated **before** execution. Generated text is never executed as code, and a
model-produced command is not authorisation to run it. Destructive operations
require confirmation.

## Sensors

Camera and microphone are the highest-sensitivity surfaces in Helix:

- Access is **always explicit** and never silent.
- A visible active indicator is mandatory whenever a device is live.
- Nothing is recorded or stored by default — not camera frames, not microphone
  audio.
- Neither may appear in logs in any form.

The `CAMERA_STARTED` / `CAMERA_STOPPED` and `MICROPHONE_STARTED` /
`MICROPHONE_STOPPED` events exist so the indicator is driven by actual device
state rather than by UI bookkeeping that could drift out of sync.

## Logging

Levels: `ERROR`, `WARN`, `INFO`, `DEBUG`, with debug disableable and automatic
rotation. Never logged: passwords, API keys, tokens, private file contents,
camera frames, microphone audio.

## Dependencies

The dependency tree is kept deliberately small (currently 54 packages,
0 known vulnerabilities). The initial Vite 5 toolchain carried 5 advisories
rooted in `esbuild <=0.24.2`; rather than suppress them, the toolchain was
upgraded to Vite 8 — which resolved all five and halved the dependency count.
Prefer removing a dependency over auditing around it.
