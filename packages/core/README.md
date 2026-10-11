# @hx/core

Primitives shared by both AI identities. Nothing in here knows which one is
using it, and that is the constraint that keeps it shareable.

| Module | What it is |
|---|---|
| `EventBus` | Typed synchronous pub/sub, generic over the host's own event map |
| `Logger` | Structured, levelled logging that redacts secrets before a sink sees them |
| `HelixError` | Separate user-facing and technical messages |
| `secrets` | One pattern list, shared by the logger and by anything that persists text |

## The rule for this package

**No identity-specific knowledge.** No Helix event names, no AXUM event names,
no persona, no settings schema, no storage layout. A module that needs to know
whose it is belongs in that app, not here.

`EventBus` is the worked example. It was previously typed directly against
`HelixEventMap` — Helix's catalogue of 31 events, covering projects, spatial
mode, camera and 3D generation. Shared as written, AXUM would have inherited
compile-time knowledge of features it does not have. It is now generic over its
map, and each app binds it to its own catalogue:

```ts
// src/core/EventBus.ts, in the Helix app
export class EventBus extends TypedEventBus<HelixEventMap> {}
```

The app-level file is the bus; this one is the mechanism.

## Why the name is not `@helix/core`

Helix is one of the two systems that depend on this, so naming the shared layer
after it would be backwards. `hx` is the prefix this project already uses for
its CSS classes and design tokens, it is short, and it reads as the shared layer
rather than as either AI.
