# Portable Mode

> **Phase 1 status:** `PathManager` is **not yet implemented** (phase 2). The
> build is already configured for portability; the path layer follows.

## The requirement

Helix must run from a portable SSD or fast USB drive, and must keep working when
the drive letter changes — `E:\Helix` today, `F:\Helix` tomorrow.

**No drive letter may ever be hard-coded.** Not `C:\Users\...`, not `E:\`, not
anywhere in source, config or documentation as a functional path.

## Already in place

`vite.config.ts` sets `base: './'`. This is load-bearing, not cosmetic: absolute
asset paths would break both a moved portable drive and the Tauri WebView. Do not
change it without understanding both consequences.

## PathManager (phase 2)

A single module owns every path resolution:

```
getAppPath()      getDataPath()     getModelPath()
getProjectPath()  getMemoryPath()   getCachePath()
getTempPath()     getConfigPath()   getLogPath()
```

Rules:

- All paths derive from the application's own resolved location at runtime.
- Nothing is stored as an absolute path in any persisted file. Project
  references, model registrations and memory records store **paths relative to
  the Helix root**, so relocation is transparent.
- Portable Mode is explicitly configurable, not inferred silently.

## Target layout

```
Helix/
├── Helix.exe
├── Core/       ├── Models/    ├── Memory/
├── Projects/   ├── Knowledge/ ├── Generated/
├── Cache/      ├── Temp/      ├── Config/
├── Logs/       └── Backups/
```

## Removable-media handling (phase 2 / phase 10)

Flash storage has limited write endurance and is slower than an internal SSD, so
when Helix detects it is running from removable media it must reduce write
volume: batched writes, controlled caching, log rotation, and temp cleanup.

**Safe Eject** must, in order: stop AI processes → finish pending writes → close
databases → stop camera and microphone → release file handles → flush.

## Not yet verifiable

No removable drive is currently attached to the development machine. `G:` is a
Google Drive mount, not removable media — and being FAT32, it is unsuitable for
Helix data regardless (see [STORAGE.md](STORAGE.md)).

Portable Mode will therefore be built and unit-tested against a simulated root,
but **drive-letter-change behaviour cannot be verified end-to-end until real
removable hardware is available.** That verification is an explicit outstanding
item, not an assumed pass.
