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

## Voice

Speech input and output use the browser's Web Speech API. No key and no
additional dependency are required, and both sit behind replaceable interfaces
(`SpeechToTextProvider`, `TextToSpeechProvider`) so a local model or cloud
provider can be substituted later.

### Speech recognition is not on-device

**Chrome and Edge implement `SpeechRecognition` by streaming microphone audio to
a Google speech service.** It is not local, despite being a browser API with no
key. Helix reports this rather than letting the absence of a key imply privacy:

- the provider declares `processing: 'remote'` and `requiresNetwork: true`;
- `VoiceManager` refuses to start it in offline mode, or when the browser
  reports no connection, rather than failing mid-utterance;
- nothing is recorded or stored. Helix keeps the resulting text only, and audio
  is never buffered, written to disk, or logged.

Firefox does not implement `SpeechRecognition` at all, and Helix says so instead
of appearing broken.

### Voice selection

`selectVoice.ts` ranks installed voices toward a composed British English voice:
British English first, then names that conventionally indicate a male voice in
the standard Windows, Chrome and macOS sets, then quality markers. It is a
preference over what the machine has, not a guarantee, and
`describeSelection()` states what was actually chosen.

**On the current development machine no British English voice is installed** -
only `Microsoft David`, `Mark` and `Zira`, all `en-US`. Helix therefore falls
back to a US male voice and says so. On Windows a British voice can be added
under Settings, Time & Language, Speech, Manage voices, English (United
Kingdom); Helix will pick it up automatically once installed.

Speech synthesis voices are generally installed with the operating system and
run locally, but the API does not reliably distinguish local from remote voices,
so `processing` is reported as `'unknown'` rather than claiming on-device.

### On-device speech recognition (default)

Whisper (`whisper-tiny.en`) runs in WebAssembly via transformers.js, with its
weights served from Helix's own origin. **No audio leaves the machine**, so this
works offline and sends nothing to a third party - the opposite of the browser
Web Speech API, which remains selectable but is labelled in Settings as sending
audio to Google.

`npm run fetch:models` installs the weights (~42 MB) alongside the hand-tracking
model. Neither is committed.

Turn-taking is driven by measured microphone level through an `AnalyserNode`,
not a fixed timer: a turn ends after ~900ms below the speech floor, and the
tuning constants live at the top of `src/voice/silence.ts`. The level loop runs
on `setInterval` rather than `requestAnimationFrame` - RAF is throttled to a
standstill in a background tab, which would leave the microphone open and
silently deaf.

#### Weight format and size

The fp32 export is used, not the smaller `_quantized` one. The current
onnxruntime cannot consume that older quantisation and fails with
"Missing required scale" - a message that reads like a corrupt download but
is really a format mismatch. fp32 costs ~151 MB instead of ~42 MB; it is the
variant that actually runs.

The ONNX runtime itself is also served locally. Left alone, onnxruntime-web
fetches its WASM backend from a jsdelivr CDN at load time, which the content
security policy blocks; the failure then surfaces as "no available backend
found", which sounds like a broken model rather than a blocked request.

#### Speed

On the development machine (i5-1235U, WASM, single-threaded) a two-second clip
takes roughly 11 seconds to transcribe. That is usable for short commands but
is not conversational latency. WebGPU would improve it substantially where the
browser supports it.
