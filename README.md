# Helix

A modular, portable Windows AI assistant.

Helix is designed to run from a portable SSD or USB drive, operate within a
configurable storage ceiling, combine local and cloud AI, remember only what the
user approves, and — as later phases land — see through a permitted camera,
understand hand gestures, display interactive 3D projects, and provide a spatial
geographic environment.

> **Status: milestone 3 of 12.** The kernel, persistence, settings, the reference
> interface, the orchestrator, conversations and projects are built and tested.
> Voice, vision, camera, gestures, memory, 3D, web and computer control are
> **not yet implemented**. This
> README describes what is actually here, not what is planned. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the roadmap.

## What works today

| Subsystem | State |
|---|---|
| Build system (Vite 8 + React 19 + TypeScript 5.9, strict) | Working |
| `EventBus` — typed pub/sub, error-isolated (spec §20) | Working |
| `Logger` — structured, leveled, redacts secrets before writing | Working |
| `HelixError` — separate user-facing and technical messages (spec §17) | Working |
| `PathManager` — portable paths, survives a drive-letter change (spec §13) | Working |
| `KeyValueStore` + IndexedDB backend — durable, namespaced persistence | Working |
| `SettingsManager` — typed, validated, migrating, **actually persists** (spec §15) | Working |
| `HelixKernel` — DI container and lifecycle (spec §19) | Working |
| Workspace navigation — six workspaces, real capability gating | Working |
| Settings UI — schema-driven, survives reload | Working |
| System UI — measured hardware, storage, capabilities, live log | Working |
| `ActivityManager` - drives ACTIVE OPERATION from real work | Working |
| `ConversationStore` - real conversations, privacy-gated persistence | Working |
| `HelixOrchestrator` - tool registry; navigation and project tools | Working |
| `ProjectManager` - projects, assets, validation, search (spec 7) | Working |
| Reference three-column UI, 11 navigable workspaces | Working |
| Upload Project - real import, validation, originals vs generated | Working |
| Memory, Files, Web, Coding, Image Gen, Earth, Storage, Gestures | Not implemented |

## Requirements

- **Node.js 20+** (developed against v24.20.0)
- A Chromium-based browser for development

On this machine Node is installed at `C:\Program Files\nodejs` but is **not on
PATH**. Either add it to PATH, or prefix commands:

```bash
export PATH="/c/Program Files/nodejs:$PATH"
```

## Running Helix

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Run the full verification pass (typecheck, tests, production build):

```bash
npm run verify
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | TypeScript project-references build, no emit of JS |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Tests in watch mode |
| `npm run verify` | typecheck + test + build |

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, shell strategy, phase plan
- [PORTABLE.md](docs/PORTABLE.md) — portable mode and path resolution
- [STORAGE.md](docs/STORAGE.md) — the storage ceiling and its real constraints
- [SECURITY.md](docs/SECURITY.md) — permissions, secrets, sensor indicators
- [PROVIDERS.md](docs/PROVIDERS.md) — local / cloud / hybrid provider model
- [DEVELOPMENT.md](docs/DEVELOPMENT.md) — conventions, testing, troubleshooting
