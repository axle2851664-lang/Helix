# Helix Providers

> **Phase 1 status:** `ProviderManager` is **not yet implemented** (phase 3).
> This document fixes the contract before implementations land.

## Principle

Helix is not bound to any single vendor. Every external capability sits behind a
replaceable interface, and each implementation declares whether it is **local**,
**cloud**, or **hybrid**.

```
LocalLanguageProvider    CloudLanguageProvider
LocalVisionProvider      CloudVisionProvider
LocalImageProvider       CloudImageProvider
Local3DProvider          Cloud3DProvider
MapProvider              StreetImageryProvider
```


## Claude models

Helix selects between three Claude models. The ids below are the exact strings
the Anthropic API accepts - they are complete as written. Never append a date
suffix and never construct an id by pattern.

| Model | Id | Context | $/1M in | $/1M out |
|---|---|---|---|---|
| Opus 5 | `claude-opus-5` | 1M | $5 | $25 |
| Sonnet 5 | `claude-sonnet-5` | 1M | $2 | $10 |
| Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 | $5 |

**There is no Haiku 5.** The current Haiku is 4.5. A request to switch to
"Haiku 5" selects Haiku 4.5 and the reply says so, rather than accepting a
model id that would 404 the moment a key is connected.

Opus 5 is the default. Helix does not downgrade for cost on the user's behalf -
that is the user's decision.

Switching is real and persisted: say "switch to Sonnet" on the home screen, or
use Settings -> AI providers. The choice survives a restart.

**Selecting a model does not connect to it.** No API key is configured and the
request path is not built, so Helix reports the selected model and states that
it still cannot answer. See the note below on why the key cannot live in the
browser.

### Why the API key is not in the browser

Helix currently runs as a browser application. Calling the Anthropic API
directly from browser code would ship the API key to the client, where any
viewer can read it - the official SDK requires an explicit
`dangerouslyAllowBrowser` flag for exactly this reason.

Helix will not do that. The request path belongs in the Tauri shell, where the
key stays in the native process and never reaches frontend code, which is
consistent with the rule in [SECURITY.md](SECURITY.md) that secrets are never
exposed to the frontend. Until that shell exists, model selection is stored and
reported but no request is made.

## Selection and fallback

`ProviderManager` chooses per request based on availability, user preference, and
connectivity. Fallbacks are explicit:

| Situation | Behaviour |
|---|---|
| No local model | Use a configured cloud provider |
| No cloud provider configured | Use a local provider if one is available |
| Neither available | Say so plainly — never fabricate a result |
| Offline | Stop retrying cloud requests; use local capability |

Offline mode must not retry failing cloud requests in a loop. Connectivity drives
`CONNECTIVITY_CHANGED`, and the UI shows `ONLINE` / `OFFLINE` / `HYBRID` at all
times.

## Hardware gating

A provider must not be offered if the machine cannot run it. `HardwareProfile`
reports cores, memory, GPU and VRAM — with **`null` for anything the host cannot
actually measure**, never an estimate. On the current development machine
(7.8 GB RAM, Intel Iris Xe, no dedicated VRAM, no CUDA), local image generation
and local image-to-3D are not viable; those local implementations must report
themselves unavailable rather than fail obscurely mid-generation.

## Image-to-3D

`ImageTo3DEngine` exposes `generate3D()`, `getGenerationStatus()`,
`getGeneratedModel()` and `cancelGeneration()`. Primary output format is
GLB/glTF.

**If generation fails, Helix says it failed and preserves the original image.** A
failed generation is never reported as a model. Polygon counts, file sizes and
generation statistics are read from the actual artifact or omitted — never
invented.

## Geographic and street imagery

`GeographicDataProvider` and `StreetImageryProvider` are replaceable and must use
properly licensed APIs or open datasets. Candidates include Mapillary and
KartaView for street-level imagery.

Non-negotiable: respect licensing, attribution, rate limits and privacy terms. Do
not scrape services in violation of their terms, and do not copy proprietary
imagery. Where imagery does not exist for a location, **say it is unavailable** —
never substitute something else and present it as that location.

## Configuration

Providers are configured through environment variables or OS credential storage.
No key is ever hard-coded, committed, or exposed to frontend code. See
[SECURITY.md](SECURITY.md).
