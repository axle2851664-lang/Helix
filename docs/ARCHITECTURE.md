# Helix Architecture

## Current state

Helix began as an empty repository (`git init`, zero commits, zero files). There
was no prior framework, build system or feature set to preserve. Everything here
is new, which is why this document describes intent as well as implementation —
but implemented and planned items are labelled distinctly throughout.

## Shell strategy: browser-first, Tauri later

**Target:** a portable `Helix.exe` built with Tauri.

**Why Tauri over Electron.** The requirement that "Core should remain small" is
decisive. A Tauri binary is single-digit megabytes; Electron bundles a ~150 MB+
Chromium runtime into every copy, which on a portable drive ships with the app
forever. The WebView2 runtime that Tauri renders through is **already present on
the development machine** (v151.0.4129.107), so the runtime side of that choice
costs nothing.

**Why not Tauri from day one.** Building Tauri requires the Rust toolchain, MSVC
Build Tools and the Windows SDK — roughly 7–10 GB, none of which is installed on
the development machine. Rather than block every feature phase behind that
install, Helix is built browser-first.

**Why this is safe.** Nearly everything in phases 3–8 is browser-native:
`getUserMedia` for camera and microphone, MediaPipe for hand tracking, WebGL2
and Three.js for the 3D viewer, Spatial Mode and Helix Earth. These run
unmodified inside a Tauri WebView later.

**What absorbs the change.** [`PlatformAdapter`](../src/platform/PlatformAdapter.ts)
is the single boundary where the two hosts differ. Feature code depends on that
interface and never touches `window.__TAURI__` or a browser global directly.
Adding the Tauri shell means writing `TauriPlatform` alongside the existing
`BrowserPlatform` — not rewriting features.

The interface deliberately forces honesty: capabilities are *reported*, not
assumed, and values the host cannot determine are `null` rather than estimated.
`BrowserPlatform` therefore declares filesystem access, real disk statistics,
process spawning and removable-media control **unavailable, with reasons**,
instead of stubbing them out to look functional.

## Module map

Implemented modules are marked ✅; the rest are planned and named here so
boundaries are fixed before code lands.

```
src/
├── core/
│   ├── EventBus.ts          ✅ typed pub/sub, error-isolated dispatch
│   ├── events.ts            ✅ the event catalogue (single source of truth)
│   ├── HelixKernel.ts       ✅ DI container, startup and shutdown
│   ├── Logger.ts            ✅ structured logging, redacts secrets on write
│   ├── HelixError.ts        ✅ user-facing vs technical messages
│   ├── HelixOrchestrator.ts ✅ tool registry and routing
│   ├── ActivityManager.ts   ✅ real activity tracking
│   ├── HelixCore.ts         ▫ later — deeper orchestration
│   ├── ContextManager.ts    ▫ phase 5 — context assembly
│   ├── ProviderManager.ts   ▫ phase 5 — local/cloud/hybrid selection
│   ├── secrets.ts           ✅ shared credential detection
│   └── PermissionManager.ts ▫ phase 7 — sensor and tool permissions
├── platform/
│   ├── PlatformAdapter.ts   ✅ the host boundary
│   ├── BrowserPlatform.ts   ✅ browser implementation
│   └── TauriPlatform.ts     ▫ later phase
├── storage/
│   ├── PathManager.ts       ✅ portable path resolution
│   ├── KeyValueStore.ts     ✅ persistence boundary + memory backend
│   ├── IndexedDbStore.ts    ✅ durable browser persistence
│   └── StorageManager.ts    ▫ later — the storage ceiling
├── settings/
│   ├── schema.ts            ✅ typed, defaulted, validated schema
│   └── SettingsManager.ts   ✅ load, validate, migrate, persist
├── conversations/
│   └── ConversationStore.ts ✅ short-term memory, privacy-gated
├── memory/
│   ├── MemoryManager.ts     ✅ long-term memory, credential refusal
│   └── types.ts             ✅ record shape and categories
├── camera/
│   └── CameraManager.ts     ✅ device lifecycle, capture, indicator
├── vision/
│   └── types.ts             ✅ provider interface, null implementation
├── gestures/
│   ├── types.ts             ✅ provider interface
│   ├── recognize.ts         ✅ pinch and palm detection, pure and tested
│   └── MediaPipeGestureProvider.ts ✅ on-device hand tracking
├── spatial/
│   ├── SpatialScene.ts      ✅ object state, move/duplicate/delete
│   └── GestureController.ts ✅ gestures mapped to scene actions
├── voice/
│   ├── VoiceManager.ts      ✅ pipeline, mic indicator, interruption
│   ├── BrowserSpeechRecognition.ts ✅ Web Speech API input
│   ├── BrowserSpeechSynthesis.ts   ✅ speech output
│   └── selectVoice.ts       ✅ British voice preference
├── persona/
│   └── voice.ts             ✅ the Helix character, in one place
├── knowledge/
│   ├── KnowledgeIndex.ts    ✅ file text index and keyword search
│   └── extract.ts           ✅ text extraction, honest about limits
├── projects/
│   ├── ProjectManager.ts    ✅ projects, assets, search
│   ├── validation.ts        ✅ upload allowlist and sanitising
│   └── types.ts             ✅ stable ids, origin separation
├── ui/                      ✅ shell, Helix mark, design tokens
└── types/                   ✅ shared types
```

## The EventBus contract

Modules communicate through [`EventBus`](../src/core/EventBus.ts) rather than
importing each other. This is what keeps Camera, Spatial, Memory and Storage
independently removable, and it is why the event catalogue is a typed map — a
mistyped event name or payload is a compile error, not a silent no-op.

Three properties matter and are covered by tests:

1. **A throwing subscriber cannot stop the others.** Each handler runs in its own
   try/catch, so one broken listener cannot prevent camera teardown or block a
   storage warning from reaching anyone else.
2. **Errors are never swallowed silently.** They are reported to an injected
   logger (spec §23).
3. **Dispatch iterates a snapshot,** so a handler may subscribe or unsubscribe
   mid-dispatch without corrupting the in-flight iteration.

Sensor events (`CAMERA_STARTED` / `CAMERA_STOPPED`, `MICROPHONE_STARTED` /
`MICROPHONE_STOPPED`) exist specifically so the active-sensor indicator can never
drift out of sync with real device state. See [SECURITY.md](SECURITY.md).

## Hardware reality on the development machine

These measurements constrain the design and are recorded so later phases do not
promise what the hardware cannot deliver:

```
CPU    12th Gen Intel Core i5-1235U (10 cores / 12 threads, mobile)
RAM    7.8 GB total
GPU    Intel Iris Xe integrated — no dedicated VRAM, no CUDA
C:     237.1 GB total / 87.1 GB free (NTFS)
G:     15 GB FAT32 — Google Drive mount, not removable media
```

Consequences carried into the roadmap:

- **Local image generation and local image-to-3D are not feasible here.** Those
  pipelines want 8–12 GB VRAM. The `ImageTo3DEngine` interface is still built as
  specified, with cloud implementations, and a local implementation that reports
  itself unavailable on this hardware rather than failing obscurely.
- **Local LLM is marginal.** At 7.8 GB total RAM, realistically ~3B at Q4 while
  contending with the OS and a WebView process. Hybrid is therefore the default
  posture: cloud primary, local opt-in.
- **The 500 GB ceiling has no volume that can approach it.** See
  [STORAGE.md](STORAGE.md).

## Phase plan

| Phase | Scope | State |
|---|---|---|
| 1 | Repository analysis, architecture, build system | **Complete** |
| 2 | Kernel, persistence, settings, workspace navigation | **Complete** |
| 3 | Reference interface, orchestrator, conversations, projects | **Complete** |
| 4 | Memory system | **Complete** |
| 4b | File and knowledge indexing | **Complete** |
| 5a | Voice pipeline (browser speech) | **Complete** |
| 5b | Language provider connection | Blocked on the Tauri shell |
| 7 | Camera, hand tracking and spatial manipulation | **Complete** |
| 6 | Web research and coding | Planned |
| 8 | Image generation | Planned |
| 9 | Helix 3D and the 3D viewer | Planned |
| 10 | Helix Earth | Planned |
| 11 | StorageManager, portable packaging, Tauri shell | Planned |
| 12 | Security review, testing, optimisation | Planned |

A phase does not begin while the previous one is fundamentally broken.
