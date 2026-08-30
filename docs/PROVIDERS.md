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
