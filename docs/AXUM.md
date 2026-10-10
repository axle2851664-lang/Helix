# AXUM — Phase 1: discovery, boundaries and proposed architecture

> **Status: nothing in this document is implemented.** It is the Phase 1
> deliverable — what was inspected, what was found, and what is proposed. No
> AXUM code exists in this repository. Two decisions are needed from the owner
> before Phase 2 can start; they are marked **DECISION** below.

## 1. What was actually inspected

Working tree at `claude/beautiful-johnson-uiz0sc`, identical to `main`
(commit `52be903`). 41,845 lines of TypeScript and Rust across `src/`,
`src-tauri/src/` and `scripts/`. Baseline verified before any analysis:

```
npm install        -> clean
npx vitest run     -> 55 files passed, 1 skipped; 1195 tests passed, 1 skipped
```

That number is the contract for everything below: AXUM must not reduce it.

**But `npm run verify` is red on `main`, and was before this document existed.**
`tsc --build --force` reports three errors, none of which the test suite catches
because each is a type error in a path tests do not typecheck through:

| Error | File | What it is |
|---|---|---|
| TS6133 | `src/core/HelixOrchestrator.ts:14` | `carriesAddress` imported and never used — dead import left by a later edit |
| TS2322 | `src/tools/researchCard.ts:67` | returns `kind: 'result'`, but `ToolCard.kind` in `src/tools/cards.ts:49` is `'brief' \| 'plan' \| 'requirement'`. The research card has never been a valid `ToolCard` |
| TS7053 | `src/ui/ai/ModelsWorkspace.tsx:168` | `VERDICT_TONE` has four keys; `FitVerdict` gained a fifth, `not-right-now`, in commit `1c7d6df`. The map was not updated, so that verdict renders `hx-dot--undefined` |

The third is a live rendering defect, not only a type complaint, and it fires on
exactly the case `resources.ts` was changed to introduce. The second means the
web-research card's declared type and its actual shape disagree.

These are **not fixed here** — this commit adds documentation only, and the
second needs a decision that is the owner's (does `ToolCard` gain a `'result'`
kind, or should `researchCard` use an existing one?). But the Phase 2 proof in
§8 is "`npm run verify` green", so they are the first thing to settle. They are
listed again as item 0 in §7.

## 2. The naming problem, stated first

**There is no HAVOC in this repository.** A case-insensitive search for
`havoc`, `axum`, `ultron`, `friday` and `jarvis` across every `.ts`, `.tsx`,
`.rs`, `.md`, `.json` and `.html` file returns only the word "Friday" used as
a weekday in test fixtures. The project here is called **Helix**, and that name
is load-bearing: it is the product name in `package.json` and
`src-tauri/tauri.conf.json`, the Tauri bundle identifier
(`com.helix.assistant`), the DOM root id (`helix-root`), the IndexedDB
namespaces, the class prefix on roughly every exported type
(`HelixKernel`, `HelixOrchestrator`, `HelixError`, `HelixTool`,
`HelixSettings`), the relay wire protocol (`helix-key:` on inbound mail,
`helix-do:` on outbound directives, `Helix` as the literal reply subject the
phone's Shortcut automation triggers on), and the persona's own name inside
`SYSTEM_PROMPT`.

So the brief's "existing HAVOC project" is one of three things, and they lead
to different work:

- **(a) Helix is HAVOC under an older name.** Then "preserve HAVOC's existing
  personality and interface" means preserve Helix's, and a rename is a separate
  piece of work with real cost — the three wire-protocol strings above cannot
  be renamed without editing the iOS Shortcuts on the phone at the same time,
  or the relay silently stops working.
- **(b) HAVOC is a different codebase** not attached to this session. Then it
  needs attaching before anything can be claimed about its interfaces, and this
  document describes integration with Helix, not with HAVOC.
- **(c) HAVOC is aspirational** — the name for what Helix becomes. Then nothing
  is blocked and the rename is optional.

**DECISION 1 required.** This document proceeds on assumption (a) — *Helix is
the main AI the brief calls HAVOC* — because it is the only reading under which
the instruction "inspect the existing codebase and reuse it" has a referent.
Where the brief says HAVOC, read Helix. **No renaming is proposed or performed.**

## 3. The overlap problem, stated second

This matters more than the name. The brief describes AXUM as "a portable AI
identity whose memory, settings and personal data travel with the user, running
locally or through the cloud depending on the device", with a
F.R.I.D.A.Y.-inspired persona that says "sir" and "boss" sparingly.

Helix is already that. From `README.md`, line 3: *"a modular, portable Windows
AI assistant… designed to run from a portable SSD or USB drive"*. Concretely,
and verified in code rather than in documentation:

| AXUM requirement (brief §) | Already in Helix | Where |
|---|---|---|
| Portable storage, drive-letter independent (§3) | Built and tested | `src/storage/PathManager.ts`, 14 named directories, `toPortable`/`fromPortable`, traversal clamping |
| Storage ceiling, cache eviction under pressure (§3) | Built and tested | `src/storage/StorageManager.ts`, `budget.ts`, `pressure.ts` |
| Local inference with hardware gating (§5) | Built and tested | `src/ai/OllamaProvider.ts`, `localModels.ts`, `resources.ts` |
| Cloud inference behind a replaceable interface (§5) | Built | `src/ai/CerebrasProvider.ts`, `InferenceProvider` in `types.ts` |
| Route deterministic commands to tools, not an LLM (§5) | Built and tested | `src/core/HelixOrchestrator.ts` — tools tried first, model sees only what no tool claimed |
| Encrypted-profile-shaped import/export (§8) | Built, **unencrypted** | `src/backup/BackupManager.ts`, `archive.ts` |
| Memory, notes, conversations, projects (§7) | Built and tested | `MemoryManager`, `ConversationStore`, `ProjectManager`, `VaultGraph` |
| Authenticated remote command channel (§7) | Built and tested | `src/relay/` + `src-tauri/src/listen.rs` |
| "sir"/"boss" used sparingly, rate-enforced (§1) | Built and tested | `src/persona/voice.ts` — `ADDRESS_RATE = 0.33`, rolling window, strict alternation |
| Granular privacy gating of what persists (§8) | Built | `saveConversationHistory`, `allowLongTermMemory`, `offlineMode` in `src/settings/schema.ts` |

That is the majority of the AXUM brief, already written and under test. Building
AXUM as a from-scratch second project would duplicate all of it, and the two
copies would diverge — the same persona bug fixed twice, the same path bug fixed
once.

**What is genuinely new in the AXUM brief**, and absent from Helix today:

1. A **second, distinct persona** — female voice preference, different
   character. Helix's `selectVoice.ts` actively ranks female voices *down*
   (`FEMALE_NAME_HINTS` subtracts, `MALE_NAME_HINTS` adds), so this is a real
   change, not a setting.
2. A **web client** served from a domain, usable from iPhone Safari. Helix has
   no server-rendered surface and no backend; `index.html` ships a CSP whose
   `connect-src` permits exactly one non-self origin, `http://127.0.0.1:11434`.
3. A **cloud backend** with accounts, sessions and device management. None
   exists. There is no server code in this repository at all.
4. **Selective two-way synchronisation** with conflict detection. None exists.
   `BackupManager` is whole-archive export/import, not sync.
5. **Encryption at rest.** None exists. `crypto.subtle` appears nowhere in
   `src/`; `src-tauri/src/google.rs:29` says in a comment that its token
   storage "is not encryption".
6. **AI-to-AI messaging** between two assistants. The relay authenticates a
   *human owner* by address plus shared secret; it has no notion of a peer
   system, no capability scoping, and no task/result envelope.
7. **A second identity's settings and storage namespace** that cannot collide
   with Helix's.

**DECISION 2 required.** Three ways to build AXUM. I recommend the third.

- **Fork.** Copy `src/`, rename, diverge. Fastest to a demo, worst long-term:
  every fix lands twice and the two personas will drift into each other.
- **One app, two modes.** A persona switch inside Helix. Cheapest, but the brief
  is explicit that the two must be *distinct systems* with separate credentials
  and permissions (§1, §9), and a mode switch cannot give you that — one
  process holding both identities' keys is one compromise away from both.
- **Workspace with a shared core (recommended).** Convert the repository to npm
  workspaces. The subsystems that are identity-neutral move to a shared package
  imported by both apps; each app owns its own persona, settings namespace,
  storage namespace, tool set and credentials. Two binaries, two identities, one
  copy of `PathManager`.

## 4. What Helix is, architecturally

Enough detail to show where AXUM attaches, and nothing more.

**Shell.** Browser-first React 19 + TypeScript 5.9 strict, Vite 8, with a Tauri
2 shell in `src-tauri/`. The split exists because a browser page cannot hold a
cloud API key — `docs/PROVIDERS.md` is explicit that the request path belongs in
the native process. `src/platform/PlatformAdapter.ts` is the single boundary:
capabilities are *reported*, never assumed, and unmeasurable values are `null`
rather than estimated. `BrowserPlatform` declares filesystem, real disk stats,
process spawning and removable-media control unavailable **with reasons**.

**Kernel.** `src/core/HelixKernel.ts` is a DI container owning construction
order and lifetime for 22 services (`KernelServices`). Startup *degrades* rather
than fails: no IndexedDB means an in-memory store and a warning, not a refusal
to open. `relay`, `listener` and `google` are typed `| null` because they cannot
exist in a browser host.

**Bus.** `src/core/EventBus.ts` — typed pub/sub over a catalogue in `events.ts`.
A throwing subscriber cannot stop the others; dispatch iterates a snapshot.
Sensor events exist specifically so the active-camera/mic indicator is driven by
device state rather than UI bookkeeping.

**Orchestrator.** `src/core/HelixOrchestrator.ts` (1,223 lines) holds a
registry of `HelixTool`s — `matches`, `unavailableReason`, `execute`, where
`execute` may return `null` to decline so the next tool gets a turn. Tools run
first; the model sees only what no tool claimed. `submit({ text,
conversationId })` is the single entry point, and both remote channels
deliberately route through it so a relayed instruction gets identical tools,
guardrails and refusals to a typed one.

**AI.** `src/ai/` separates *models* from *inference providers* — the type
system is built to say so, and `GenerateResult` carries the model and provider
that **actually** ran. `AIRouter` ranks candidates (local before cloud when
preferred, then preferred provider, then fallback; unverified model ids ranked
down), records every attempt including failures, and reports `substituted` and
`capabilityLoss` in the result rather than in a log. `localModels.ts` marks a
model `unavailable` when `resources.ts` says it will not fit, distinguishing
`will-not-fit` (hardware fact) from `not-right-now` (a reading of this instant).

**Persona.** `src/persona/voice.ts` composes every scripted sentence;
`systemPrompt.ts` carries the same character into model output;
`register.ts` checks the reply afterwards, "because a prompt is a request and a
small model may decline it". The address rate is enforced over a rolling window
that governs scripted *and* generated sentences, so the two halves cannot drift.

**Remote channels — the precedent AXUM's link must follow.**
`src/relay/command.ts` takes an email and refuses to act on it unless three
independent checks pass: owner address, shared secret compared in constant time,
and the body treated as data rather than as a prompt. `src-tauri/src/listen.rs`
does the same for a direct TCP connection: peer address checked against
configured CIDR ranges *before a byte of the request is read*, constant-time key
comparison, 16 KiB body cap, 180-second reply timeout. Both files state the rule
AXUM's link must inherit verbatim: **authentic is not authorised.** Passing every
check proves the message is genuine; anything that sends, spends or deletes still
needs confirming at the machine, and not through the same channel.

**Guardrails.** `src/guardrails/rules.ts` stores the standing rules as data with
an `enforcement` field of `code` | `structure` | `promise`, and renders it. A
rule nothing enforces stays labelled `promise` on screen until the code lands.
`untrusted.ts` scans text for instruction-shaped content and *flags* rather than
blocks. `src/outbound/outbound.ts` gates anything leaving the machine behind a
per-draft confirmation that goes stale and cannot be edited after approval.

## 5. How AXUM integrates without compromising Helix

Five rules. Each is checkable, and Phase 2 adds a test for each.

1. **Helix's public surface does not change.** AXUM may import from a shared
   package; it may not require a signature change in `HelixOrchestrator`,
   `HelixKernel` or `PlatformAdapter`. Where Helix needs a new capability to
   serve AXUM (the link endpoint), it arrives as a **new registered
   `HelixTool`** plus a new `KernelServices` field typed `| null` — the
   established pattern for `relay` and `listener`.
2. **The persona split is physical.** AXUM gets `packages/axum-persona/`.
   Helix's `src/persona/` is not edited. The one shared mechanism worth
   parameterising is `scoreVoice`, which takes a voice-preference argument
   instead of being forked — Helix passes its current preference, AXUM passes
   the opposite, and Helix's existing voice tests keep their current
   expectations.
3. **Storage namespaces cannot collide.** Helix's IndexedDB namespaces and
   `PathManager` directories stay as they are. AXUM's live under its own root
   and its own namespace prefix, and `archive.ts`'s `ARCHIVABLE` allowlist —
   which already refuses to restore into a namespace it does not own — is what
   proves it. A test asserts an AXUM archive cannot write into a Helix
   namespace and vice versa.
4. **Credentials are separate and scoped.** AXUM holds an AXUM key. It is not
   Helix's key, it cannot be used as Helix's key, and it authorises a *scope*
   (see §6.5) rather than "everything Helix can do". Revoking AXUM does not
   touch Helix's own relay secret.
5. **The test count only goes up.** 1195 is the floor. `npm run verify`
   (typecheck + test + build) passes at every commit.

## 6. Proposed AXUM architecture

### 6.1 Repository shape

```
helix/                          (this repository)
├── packages/
│   ├── core/          EventBus, Logger, HelixError, secrets, events
│   ├── storage/       PathManager, KeyValueStore, IndexedDbStore, budget, pressure
│   ├── platform/      PlatformAdapter + Browser/Tauri implementations
│   ├── settings/      the schema machinery (not the schema contents)
│   ├── guardrails/    untrusted.ts, rules machinery
│   ├── link/          ** NEW ** the AXUM <-> Helix protocol, pure and transport-free
│   └── axum-persona/  ** NEW ** the AXUM character
├── apps/
│   ├── helix/         today's src/ minus what moved to packages/
│   └── axum/          ** NEW ** AXUM's own kernel wiring, tools, settings, UI
└── services/
    └── axum-cloud/    ** NEW ** the backend, deployable or absent
```

The extraction is mechanical (move files, fix import paths, keep tests with
their modules) and should be its own commit, verified green, before any AXUM
code exists. If the extraction cannot be made green, AXUM is built as
`apps/axum/` importing from `src/` by relative path and the extraction is
deferred — worse, but not a reason to stall.

### 6.2 The USB client

Reuses `PathManager` unchanged. AXUM's root is resolved at runtime from the
executable's own location — never a drive letter, never an assumption about
mount point or filesystem. Layout under the AXUM root: `config/`, `profile/`
(encrypted), `conversations/`, `notes/`, `models/`, `skills/`, `sync/`,
`logs/`, `temp/`, `cache/`.

Startup, matching the brief's seven steps: resolve root → read `config/` (plain,
non-secret, so AXUM can report what it is before unlocking) → authenticate →
derive the profile key → decrypt and load the profile → start the interface →
initialise whichever AI engine the hardware and connectivity permit → on exit,
the Safe Eject sequence already specified in `docs/PORTABLE.md` (stop AI → flush
writes → close databases → release devices → release handles).

**What will not be claimed.** Inserting a USB drive does not autorun a program
on current Windows, macOS or Linux — AutoRun for removable media has been
disabled by default on Windows since 2011 and never existed on the others. The
portable experience is: plug in, open the drive, run the launcher. One
double-click, honestly described. Flash endurance and the write-reduction
measures in `docs/PORTABLE.md` apply to AXUM too, and matter more because AXUM
writes a conversation log.

**Host residue.** A desktop app cannot avoid leaving some trace on the host
(WebView2 cache, temp files, OS prefetch). AXUM minimises what it controls,
documents what it cannot, and cleans up on exit where it is safe to. It will not
be described as leaving no trace.

### 6.3 The web client

A responsive PWA under `apps/axum-web/`, sharing `packages/` where the code is
host-neutral and talking to the backend over HTTPS. It is a **client of the
profile, not a copy of it**: sign in, conversations, notes, memory, settings,
sync controls, Helix-link status, and an explicit indicator of where each piece
of data lives — on the drive, synchronised, or cloud-only.

iOS constraints, stated plainly: an iPhone cannot execute a desktop binary from
a USB drive, cannot run AXUM in place of iOS, and cannot read a drive that is
not connected to it. Safari supports installing a PWA to the home screen but
restricts background execution and push compared to a native app. On iPhone,
AXUM is a web client; local inference on the phone is out of scope.

### 6.4 The cloud backend

`services/axum-cloud/`, modular enough that the domain and host can change
without touching the clients. Responsibilities: authentication and sessions,
device registration and revocation, cloud inference brokering (so a provider key
lives only here), AXUM↔Helix relaying when the two are not on the same mesh
network, sync storage for the categories the user has authorised, and audit
logs.

Subdomains as in the brief — `app.`, `api.`, `sync.` — bound once a domain is
registered. No privileged key reaches the web client, the desktop bundle or the
drive; this is the same rule `docs/PROVIDERS.md` already states, applied to a
second host.

**This costs money and needs decisions that have not been made** — domain
registration, a hosting provider, a managed database, and per-request inference
billing. None of it is assumed. Until it exists, AXUM runs in portable-first
mode with sync disabled, which is a complete product.

### 6.5 The link: AXUM ↔ Helix

The piece the brief calls core, and the piece most worth getting right before
anything depends on it.

**Shape.** A signed envelope, not a prompt:

```
LinkEnvelope {
  v: 1                      protocol version; an unknown version is refused
  id: string                unique per message, for correlation and replay defence
  from / to: 'axum'|'helix' the two identities, named
  issued: number            unix ms, checked against a window
  nonce: string             random, remembered for the window's length
  scope: LinkScope          what this envelope is permitted to ask for
  kind: 'task'|'result'|'data'|'ping'|'error'
  body: unknown             data. never interpolated into a system prompt.
  mac: string               HMAC-SHA-256 over the canonical encoding of the above
}
```

**Authentication.** HMAC over a canonical serialisation of every field except
`mac`, with a pre-shared per-pair key, verified in constant time. This is
stronger than `listen.rs` does today — that compares a bare key carried in the
body, which authenticates the *sender* but does not bind the key to the
*message*, so a captured request can be replayed verbatim. `issued` plus
`nonce` plus a bounded replay window closes that, and the window is short
(60 seconds) because both ends are machines with clocks.

**Authorisation is separate from authentication**, and this is the rule the
whole design rests on. A valid MAC proves the envelope came from AXUM. It does
not entitle AXUM to anything. `scope` is a closed enumeration — `notes.read`,
`notes.write`, `memory.read`, `files.summarise`, `task.analyse`,
`settings.read` — each independently grantable and revocable in Helix's
settings, and defaulting to **none**. A scope AXUM was not granted is refused
with a reason, and the refusal is logged on Helix's side where a forger cannot
see it. Following `src/relay/command.ts`: rejections are never answered in a way
that turns the endpoint into an oracle.

**The body is data.** A `task` envelope does not become a prompt. It is matched
against Helix's registered tools exactly as a typed instruction is, through
`HelixOrchestrator.submit`. Text inside it is scanned by
`guardrails/untrusted.ts` and findings travel with it, reported and not obeyed.
AXUM presenting Helix's result in AXUM's own voice is a *rendering* step in
AXUM; AXUM never signs an envelope whose body a model composed, for the same
reason `relay/directives.ts` refuses to let a model write a phone directive.

**Nothing outward-facing crosses the link unattended.** The link may carry a
*request* to send, spend or delete; it may not carry the authorisation. That
confirmation happens at Helix, in front of the user, through
`src/outbound/outbound.ts`'s existing per-draft gate. A remote channel is the
wrong place for an irreversible action however well authenticated it is —
`relay/directives.ts` already argues this at length and the argument transfers
unchanged.

**Transport, in order of preference.** (1) Loopback, when both run on the same
machine. (2) The existing mesh-VPN listener — `listen.rs` already has the peer
check, the key, the size cap and the timeout; it gains an envelope-aware route.
(3) The cloud relay, for when the two are on different networks, carrying
envelopes it cannot read. (4) Nothing — and then AXUM says so and carries on
locally. Offline is a state to report, never to fake.

**Transfers are logged on both sides** with what was asked, what scope was
used, and what was returned. Anything that can act on your behalf owes you an
account of what it did — `guardrails/rules.ts` already says so.

### 6.6 AXUM's AI engine

Reuses `InferenceProvider`, `AIRouter`, `resources.ts` and `localModels.ts`
unchanged — they are already provider-agnostic and already refuse to offer a
model that will not fit. AXUM adds:

- A **`HavocDelegationTool`** registered in AXUM's own orchestrator. Delegation
  is a *tool*, not an inference provider: it is not "a bigger model", it is
  another system with its own tools, permissions and user, and modelling it as a
  provider would make a scope-checked cross-system call look like a model
  substitution in the routing table.
- Routing order unchanged from Helix's: native tools first, then local model,
  then cloud, then delegation. "Open my notes" never reaches an LLM.

**Model choice is deferred, deliberately.** The brief asks for an evaluation
rather than an assumption, and the machinery to do it honestly already exists.
What can be said now, from the hardware recorded in `docs/ARCHITECTURE.md`
(i5-1235U, 7.8 GB RAM, Iris Xe, no dedicated VRAM): a 4-bit 3–4B model is the
realistic ceiling on that machine, and the measurement already in the repo —
a 7B at 0.2 tokens/second against a 3B at 10.8, because the 7B was swapping —
is why no model will be named before it is run. A USB drive adds a second
constraint the dev machine cannot show: model load time is bounded by the
drive's read speed, so a model that fits in RAM may still take an unacceptable
time to start from flash. Qwen-family models are candidates with permissive
licences and genuine tool-calling, and so are others; the comparison belongs in
Phase 5 with measured numbers, on real removable hardware.

### 6.7 Storage, sync and the honest distinction

Two explicit modes, as the brief requires.

**Portable-first.** The drive is the source of truth. Nothing is copied to the
host beyond unavoidable runtime residue. Sync is off. AXUM works to the limits
of what it has locally.

**Connected.** Authorised categories — memories, notes, conversations, files,
settings, projects — sync independently, each with its own on/off. Conflicts are
detected (per-record version vector plus a content hash) and surfaced, never
silently resolved by timestamp. The interface states, per item, whether it is
local, synchronised, or cloud-only.

**The thing that must not be fudged:** a phone cannot read a drive that is not
plugged into it. Remote access to AXUM's data means a cloud copy of the
categories the user authorised. That will be said in those words in the
interface, with encryption, a stated retention period and a deletion path that
actually deletes. AXUM will never describe cloud-hosted data as living only on
the drive.

### 6.8 Security

Encryption at rest does not exist in Helix today and is new work, not reuse.
Proposed: a profile key derived from the user's passphrase with a memory-hard
KDF (Argon2id where available, scrypt otherwise), per-record AEAD
(AES-256-GCM via `crypto.subtle`, or the Rust side in the Tauri host), the salt
and KDF parameters stored beside the data and the **key never written there**.
A wrapped-key file protected by an OS keystore may be offered as a convenience
on a trusted machine, clearly labelled as a convenience, and never on the
portable drive by default.

What will not be claimed: that a flash drive is secure because the files are on
it. An unencrypted drive is readable by anyone holding it, and a drive encrypted
with a weak passphrase is readable by anyone patient. Both get said plainly, and
`guardrails/rules.ts` gets AXUM entries marked `promise` until the code lands.

## 7. Limitations and unresolved choices

**Blocking Phase 2's own proof:**

0. Three pre-existing typecheck errors on `main` (§1). `npm run verify` cannot
   be green until they are settled, and one of the three is a real rendering
   defect rather than a type complaint.

**Blocking a claim, not the work:**

1. The HAVOC/Helix identity question (**DECISION 1**). Everything in §6 is
   name-independent; only the rename is blocked.
2. Fork / mode / workspace (**DECISION 2**). Changes where files go, not what
   they contain.

**Technical limits that will not move:**

3. No USB drive is attached to the development machine, and `G:` is a FAT32
   Google Drive mount, not removable media. Drive-letter-change behaviour,
   flash write endurance, model load time from flash and Safe Eject are
   **unit-testable against a simulated root and not verifiable end-to-end**
   until real hardware exists. This is an outstanding item, not an assumed pass.
4. The Tauri toolchain (Rust, MSVC Build Tools, Windows SDK — 7–10 GB) is not
   installed on the development machine, which is why `docs/ARCHITECTURE.md`
   records phase 5b as blocked. Anything needing the native host — real
   filesystem, process spawn, a held API key, the link listener — is
   browser-untestable and must be written behind `PlatformAdapter` with an
   honest `unavailableReason`.
5. iOS cannot run a desktop binary, cannot be replaced by a USB device, and
   restricts PWA background execution. AXUM on iPhone is a web client.
6. 7.8 GB of RAM, no dedicated VRAM. Local inference is a 3–4B q4 ceiling on
   this machine; a different device may do better and AXUM must ask rather than
   assume.

**Unresolved, and needing the owner's decision when each phase is reached:**

7. Domain, hosting provider, database and inference billing (§6.4). All cost
   money. None is assumed.
8. Whether cloud copies are acceptable at all, which decides whether
   connected mode ships.
9. Production local model (§6.6) — measurement, not preference.
10. Authentication on the drive: passphrase only, or passphrase plus a hardware
    factor.
11. Retention: how long the cloud keeps a synchronised record after deletion.
12. Whether AXUM gets a voice *clone* or a selected system voice. A cloned
    voice of a real person is a consent question before it is a technical one.

## 8. Phase plan

Mapped to the brief's phases. Each row names what proves it, because a phase
without a check is a claim.

| Phase | Scope | Proof |
|---|---|---|
| 1 | This document | Inspection recorded; 1195 tests green at baseline |
| 2a | `packages/link` — the protocol, pure | MAC verify, tamper, replay, clock-skew, unknown-version and scope-refusal tests |
| 2b | Workspace extraction (**DECISION 2**) | `npm run verify` green, test count unchanged |
| 2c | AXUM core: kernel wiring, settings namespace, persona, tool registry | AXUM boots, says who it is, refuses what it cannot do |
| 3 | Portable profile: paths, encryption, notes, conversations | Wrong passphrase refuses; drive-letter change invisible; namespace isolation test |
| 4 | Web client and backend skeleton | Sign-in, a conversation, responsive on a real iPhone |
| 5 | AI engine: local model measured, cloud adapter | Measured tokens/second per candidate on real hardware, from flash |
| 6 | The link, end to end | A scoped task crosses it and a result comes back; an unscoped one is refused and logged |
| 7 | Selective sync, conflict handling | Two devices, divergent edits, conflict surfaced not silently lost |
| 8 | Security and portability testing | USB removal mid-write, offline behaviour, session lock, retention |
| 9 | Packaging and deployment | Portable distribution, documented platform limits |

No phase begins while the previous one is broken — the rule already in
`docs/ARCHITECTURE.md`.

## 9. Recommended first step

**Build `packages/link`: the AXUM↔Helix protocol as a pure, transport-free,
fully tested module. Nothing else.**

Why this one:

- It is **name-independent and shape-independent**. It is correct under all
  three readings of the HAVOC question and all three answers to the workspace
  question, so it does not wait on either decision.
- It is the **contract both sides must agree on**, and it is the piece that is
  dangerous to retrofit. Scope checking bolted on after a transport exists is
  how an endpoint ends up with one path that enforces it and one that does not —
  the exact failure `relay/command.ts` and `listen.rs` were written to avoid.
- It is **pure functions over data**: canonical encoding, HMAC sign and verify,
  replay window, scope grant and refusal. No network, no filesystem, no
  platform. Which means it is **fully testable in the browser host, today**,
  with no Rust toolchain and no USB drive — the two things blocking almost
  everything else.
- It **touches no existing Helix code**, so the 1195-test baseline cannot move.

Deliverable: a new module with its types, its canonical encoder, sign/verify, a
replay guard, the scope enumeration and its checker, and tests covering a good
envelope, a tampered field, a replayed nonce, a stale timestamp, a future
timestamp, an unknown version, a wrong key, and every scope refusal. Plus a
`guardrails/rules.ts` entry for the link marked `promise`, because at that point
nothing enforces it anywhere but in the tests.

Then, and only then, the extraction and the AXUM shell.
