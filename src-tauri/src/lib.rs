//! The Helix desktop shell.
//!
//! This exists to provide the three things a browser genuinely cannot, and
//! deliberately nothing else. Every command below is a capability the web
//! build reports as unavailable, with a reason naming this shell.
//!
//! 1. **Real volume statistics.** A browser reports an origin quota, which is
//!    an allowance the browser may revise and is not free disk space. The
//!    storage screen has been careful never to present one as the other; this
//!    is what lets it finally report the real thing.
//!
//! 2. **Requests to outside origins.** A page with `connect-src 'self'`
//!    cannot reach a mail server, a tile server or a model provider. Requests
//!    made here happen outside the page.
//!
//! 3. **Somewhere to hold a credential.** A token in a web build sits in the
//!    page where anyone can read it. Held here, it never reaches the browser
//!    context at all.
//!
//! What this shell must not become is a general escape hatch. It exposes named
//! commands with narrow shapes, not a filesystem or a shell. The standing rule
//! that Helix never writes outside its own folders survives the move only if
//! this file refuses to offer the means.

mod google;
mod inference;

use serde::Serialize;
use sysinfo::Disks;

/// Volume figures for the disk Helix lives on.
///
/// Mirrors the `VolumeStats` shape the TypeScript side already uses, including
/// `source`, which tells the interface whether it is looking at a real volume
/// or a browser's quota. That field existed long before this shell did,
/// precisely so this day would not require the storage screen to change.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeStats {
    pub free_bytes: u64,
    pub total_bytes: u64,
    pub used_by_helix_bytes: u64,
    /// Always "volume" from here. A browser answers "origin-quota".
    pub source: String,
}

/// The volume containing a given path.
///
/// Picks the mount point with the longest match, because on Windows several
/// disks can be listed and a naive first match reports the wrong one. Returns
/// `None` rather than guessing when nothing matches - an invented figure here
/// would be worse than no figure, since the whole point of this command is to
/// stop reporting a quota as a disk.
#[tauri::command]
fn volume_stats(path: String) -> Option<VolumeStats> {
    let disks = Disks::new_with_refreshed_list();

    let mut best: Option<(&sysinfo::Disk, usize)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point().to_string_lossy().to_string();
        if path.to_lowercase().starts_with(&mount.to_lowercase()) {
            let length = mount.len();
            if best.map_or(true, |(_, current)| length > current) {
                best = Some((disk, length));
            }
        }
    }

    best.map(|(disk, _)| VolumeStats {
        free_bytes: disk.available_space(),
        total_bytes: disk.total_space(),
        // Helix's own footprint is measured on the TypeScript side, which
        // knows what belongs to it. Reporting the disk's used space here would
        // answer a different question than the one being asked.
        used_by_helix_bytes: 0,
        source: "volume".to_string(),
    })
}

/// Total physical memory, in bytes.
///
/// A browser can offer at best a coarse, capped hint, which is why the
/// hardware profile carries `memory_is_approximate`. From here it is a real
/// reading.
#[tauri::command]
fn total_memory() -> u64 {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.total_memory()
}

/// Memory actually free right now, in bytes.
///
/// This is the figure that decides whether a model will run, and it is not the
/// same question as how much the machine has. A 7B needing five gigabytes on a
/// machine with under three free does not fail - it swaps, and appears to have
/// hung. Measured here rather than assumed from a fixed reserve, because the
/// reserve was wrong: on this machine it guessed 4.8 GB usable where 2.3 GB
/// was actually free.
#[tauri::command]
fn available_memory() -> u64 {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.available_memory()
}

/// Confirms to the front end that it is genuinely running inside the shell.
///
/// The web build detects Tauri by probing for its globals, and a probe can be
/// wrong. This makes the answer something the shell states rather than
/// something the page infers.
#[tauri::command]
fn shell_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            volume_stats,
            total_memory,
            available_memory,
            shell_version,
            inference::configured_inference_providers,
            inference::inference_request,
            google::google_status,
            google::google_connect,
            google::google_disconnect,
            google::google_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helix");
}
