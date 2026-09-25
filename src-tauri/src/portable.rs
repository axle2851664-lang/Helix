//! Taking Helix with you on a removable disk.
//!
//! The one thing this module refuses to do is decide what goes. It lists the
//! disks that are actually removable, copies exactly what it is handed, and
//! writes a manifest saying what arrived. Choosing is done on the other side,
//! in front of the user, because "what should leave this machine" is not a
//! question a file-copying routine is qualified to answer.
//!
//! Three refusals are enforced here rather than trusted from the caller:
//!
//!   - **Only a removable disk.** A copy aimed at `C:\` is a mistake with no
//!     good outcome: it would write a second Helix over the user's real one.
//!     The destination is checked against the list of removable mounts rather
//!     than against a pattern in the path.
//!   - **Only inside a folder Helix owns.** Everything is written under a
//!     single `Helix` directory on the disk, so nothing outside it is touched
//!     and removing the copy is deleting one folder.
//!   - **No credential, ever.** This module has no access to the token file
//!     and no parameter that could name it. That is not a rule it checks; it
//!     is a capability it does not have.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::Disks;

/// A disk the user could reasonably carry away.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovableDrive {
    /// What the OS calls it, or the mount point when it has no name.
    pub name: String,
    pub mount_point: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
    /// True when Helix appears to already be on this disk.
    pub has_helix: bool,
}

/// The folder Helix writes into. One name, in one place, used by every path
/// this module builds - so "where did it put things" has a single answer.
pub const FOLDER: &str = "Helix";

/// Where each piece goes on the disk.
///
/// Pure, so the layout is testable without a disk present. Every path is
/// built by joining onto the root rather than by formatting a string, which
/// is what keeps a mount point with a space or a trailing slash from
/// producing something that is not a path at all.
pub fn layout(mount: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let root = mount.join(FOLDER);
    let data = root.join("data.helix.json");
    let manifest = root.join("what-is-here.txt");
    (root, data, manifest)
}

/// List the disks worth offering.
///
/// Removable only. A fixed disk is not a thing you put in your pocket, and
/// offering one turns a portable copy into an accidental second install.
#[tauri::command]
pub fn portable_drives() -> Vec<RemovableDrive> {
    let disks = Disks::new_with_refreshed_list();

    disks
        .list()
        .iter()
        .filter(|disk| disk.is_removable())
        .map(|disk| {
            let mount = disk.mount_point().to_path_buf();
            let name = disk.name().to_string_lossy().to_string();
            let (root, _, _) = layout(&mount);

            RemovableDrive {
                name: if name.trim().is_empty() {
                    mount.to_string_lossy().to_string()
                } else {
                    name
                },
                mount_point: mount.to_string_lossy().to_string(),
                free_bytes: disk.available_space(),
                total_bytes: disk.total_space(),
                has_helix: root.exists(),
            }
        })
        .collect()
}

/// Is this mount point one of the disks we would offer?
///
/// Compared against the live list rather than sniffed from the path. A path
/// test would be a guess about drive letters, and a wrong guess here writes
/// Helix somewhere it was never meant to go.
fn is_removable(mount: &str) -> bool {
    portable_drives()
        .iter()
        .any(|drive| drive.mount_point.eq_ignore_ascii_case(mount))
}

/// Copy a directory, entry by entry.
///
/// Depth-first and explicit rather than recursive-with-symlink-following:
/// following a link out of the install directory would copy whatever it
/// points at onto a disk the user is about to carry out of the building.
fn copy_tree(from: &Path, to: &Path) -> Result<u64, String> {
    std::fs::create_dir_all(to).map_err(|error| format!("Cannot create {to:?}: {error}"))?;

    let mut written = 0u64;
    let entries =
        std::fs::read_dir(from).map_err(|error| format!("Cannot read {from:?}: {error}"))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Cannot read an entry: {error}"))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("Cannot inspect {:?}: {error}", entry.path()))?;

        // Symlinks are skipped, never followed. See above.
        if kind.is_symlink() {
            continue;
        }

        let source = entry.path();
        let target = to.join(entry.file_name());

        if kind.is_dir() {
            written += copy_tree(&source, &target)?;
        } else {
            written += std::fs::copy(&source, &target)
                .map_err(|error| format!("Cannot copy {source:?}: {error}"))?;
        }
    }

    Ok(written)
}

/// What was written, reported back so the interface can say so exactly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableResult {
    pub folder: String,
    pub bytes_written: u64,
    pub wrote_app: bool,
    pub wrote_data: bool,
}

/// Write the chosen things to the disk.
///
/// `data` is already-serialised text from the archive the user agreed to -
/// this command does not build it, read the store, or know what is in it. The
/// manifest is written last, so a folder containing one always contains a
/// finished copy.
#[tauri::command]
pub fn portable_write(
    mount_point: String,
    data: Option<String>,
    include_app: bool,
    manifest: String,
) -> Result<PortableResult, String> {
    if !is_removable(&mount_point) {
        return Err(format!(
            "{mount_point} is not a removable disk. Helix only writes a portable copy to a disk \
             you can take with you, so a copy can never be written over your real installation."
        ));
    }

    if data.is_none() && !include_app {
        return Err("Nothing was selected, so there is nothing to write.".into());
    }

    let mount = PathBuf::from(&mount_point);
    let (root, data_path, manifest_path) = layout(&mount);

    std::fs::create_dir_all(&root).map_err(|error| format!("Cannot create {root:?}: {error}"))?;

    let mut bytes_written = 0u64;
    let mut wrote_app = false;

    if include_app {
        let source = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the running program: {error}"))?
            .parent()
            .ok_or("The running program has no containing folder.")?
            .to_path_buf();

        bytes_written += copy_tree(&source, &root.join("app"))?;
        wrote_app = true;
    }

    let wrote_data = match &data {
        Some(text) => {
            std::fs::write(&data_path, text)
                .map_err(|error| format!("Cannot write {data_path:?}: {error}"))?;
            bytes_written += text.len() as u64;
            true
        }
        None => false,
    };

    // Last, deliberately: a folder with a manifest is a finished copy.
    std::fs::write(&manifest_path, manifest)
        .map_err(|error| format!("Cannot write {manifest_path:?}: {error}"))?;

    Ok(PortableResult {
        folder: root.to_string_lossy().to_string(),
        bytes_written,
        wrote_app,
        wrote_data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_lands_under_one_folder() {
        let (root, data, manifest) = layout(Path::new("E:\\"));

        assert!(root.ends_with(FOLDER));
        assert!(data.starts_with(&root));
        assert!(manifest.starts_with(&root));
    }

    /// A mount point with a space, or without a trailing separator, still
    /// produces a real path - which joining does and formatting does not.
    #[test]
    fn an_awkward_mount_point_still_produces_a_path() {
        for mount in ["/media/My Stick", "/media/My Stick/", "E:", "E:\\"] {
            let (root, data, _) = layout(Path::new(mount));
            assert!(root.ends_with(FOLDER), "{mount}");
            assert_eq!(data.file_name().unwrap(), "data.helix.json", "{mount}");
            assert!(data.starts_with(&root), "{mount}");
        }
    }

    #[test]
    fn the_data_file_is_never_written_outside_the_folder() {
        let (root, data, manifest) = layout(Path::new("/media/stick"));
        assert_eq!(data.parent().unwrap(), root);
        assert_eq!(manifest.parent().unwrap(), root);
    }
}
