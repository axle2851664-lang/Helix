# Helix Development

## Environment

- **Node.js 20+** — developed against v24.20.0, npm 11.19.0.
- On the current development machine Node is installed at `C:\Program Files\nodejs`
  but is **not on PATH**. Add it, or prefix commands in Git Bash:

  ```bash
  export PATH="/c/Program Files/nodejs:$PATH"
  ```

## Toolchain choices

| Choice | Reason |
|---|---|
| Vite 8 | Rolldown-based; removed all 5 advisories carried by the Vite 5 / esbuild tree and halved the dependency count |
| React 19 | Required by react-three-fiber v9, which phases 6–8 depend on. Chosen now to avoid a forced migration later |
| TypeScript 5.9.3 | Deliberately **not** 7.0. The 7.x native compiler is very new; the foundation stays on well-tested ground. Revisit once the ecosystem has settled |
| Vitest 4 | Shares Vite's transform pipeline — no second build config to maintain |

## TypeScript settings

Strictness is turned up beyond `strict` (spec §33):

`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
`verbatimModuleSyntax`, `isolatedModules`.

`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` in particular will
reject code that is merely *probably* correct. That is intentional — do not
loosen them to make something compile; fix the type.

Project references split app code (`tsconfig.app.json`) from build tooling
(`tsconfig.node.json`) so Node types never leak into browser code.

Path aliases (`@core/*`, `@platform/*`, `@ui/*`, `@types/*`) are declared in both
`tsconfig.app.json` and `vite.config.ts` — **update both together.**

## Verification

Run before every commit:

```bash
npm run verify
```

That is typecheck → tests → production build. All three must pass.

## Conventions

- **Small modules with clear interfaces.** HelixCore in particular must never
  become one large file.
- **Depend on interfaces, not hosts.** Never reference `window.__TAURI__` or a
  browser-only global outside `src/platform/`.
- **Dependency injection over globals.** `EventBus` takes its logger; it does not
  reach for one.
- **Cross-module communication goes through `EventBus`,** not direct imports.
- **Report unavailability; never stub a success.** A capability that cannot work
  must say so with a reason. This is the single most important convention in the
  codebase.
- **Never fabricate a value.** If the host cannot measure it, it is `null`.

## Testing

Tests sit next to their subject as `*.test.ts`. Cover the failure modes, not just
the happy path — the `EventBus` suite exists mostly to prove that a throwing
subscriber, mid-dispatch mutation, and duplicate unsubscribes all behave.

Scenarios the specification requires be tested as their subsystems land: fresh
install, portable install, drive-letter change, offline, missing model, missing
API key, missing camera, missing GPU, low storage, corrupt project, failed
generation.

## Troubleshooting

**`npm` not found** — Node is off PATH; see Environment above.

**Vite/esbuild postinstall warnings** — npm 11 blocks install scripts by default.
Vite 8 uses Rolldown and does not need esbuild's postinstall, so this should not
recur. If a dependency genuinely needs one, review it with
`npm install-scripts ls` before approving.

**Typecheck passes but the build fails** — `npm run build` runs `tsc --build`
first; a stale `dist/.tsbuildinfo-*` can mask changes. Use
`npm run typecheck` (which forces a rebuild) or delete `dist/`.

**Screenshot/render timeouts during browser verification** — the `PROCESSING`
state animates continuously, so a renderer may never report a settled frame.
Expected, not a bug.
