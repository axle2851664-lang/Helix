# Helix Storage

> **Phase 1 status:** `StorageManager` is **not yet implemented** (phase 2). This
> document records the design and, importantly, the measured constraints it must
> respect.

## The ceiling, and what it really means here

The specification sets an absolute limit of **500 GB**, with a preferred Helix
Core footprint under 150 GB.

**No volume on the development machine can approach that figure.**

```
C:  237.1 GB total / 87.1 GB free   (NTFS)
G:   15.0 GB total /  8.3 GB free   (FAT32 — Google Drive mount)
```

A hard-coded 500 GB constant would therefore be fiction. The design instead
treats 500 GB as the *configured ceiling* and free space as the *binding
constraint*:

```
effectiveLimit = min(configuredLimit, currentFreeSpace - safetyMargin)
```

Both numbers are surfaced separately in the UI so the user always sees the real
one. Reporting "437 GB available" on a disk with 87 GB free would be exactly the
kind of fabricated result the specification forbids.

## Why browser storage figures cannot be trusted for this

`navigator.storage.estimate()` returns an **origin quota**, not disk free space.
The two are unrelated, and a quota figure presented as free space would mislead
badly. `VolumeStats` therefore carries a `source` discriminant:

- `'volume'` — real volume statistics (Tauri shell)
- `'origin-quota'` — a browser sandbox quota (current browser host)

`StorageManager` must refuse to enforce a real ceiling from an `'origin-quota'`
reading, and say so, rather than pretend.

## Categories

Storage is accounted separately so that models remain independently removable
and user data is never confused with cache:

```
Core · Models · Projects · Generated · Memory · Knowledge · Cache · Temp · Backups
```

## Thresholds

| Usage | Behaviour |
|---|---|
| 75% | Storage usage getting high |
| 85% | Storage usage is high |
| 95% | Storage critically low |
| 99% | Storage limit almost reached |
| 100% | Block storage-intensive operations |

Each crossing emits `STORAGE_WARNING` with a severity, so the UI is driven by
events rather than polling.

## Rules

- **Never silently delete user data to stay under the limit.** Cache and temp may
  be reclaimed automatically; projects, memory, generated assets and knowledge
  may not. Anything else requires explicit user action.
- **Model installation is checked before it starts:** current usage + model size
  + required temporary space. If the total exceeds the effective limit, the
  install is blocked with the numbers shown.
- **Models are never downloaded automatically** or without user awareness.

## FAT32 caution

`G:` reports as FAT32, which imposes a **4 GB maximum file size**. Most GGUF
model files exceed that, and SQLite behaves poorly there. Helix must detect the
filesystem of its data volume and refuse to install oversized models onto FAT32
with a clear explanation, rather than failing mid-write. Portable deployments
should use NTFS or exFAT.
