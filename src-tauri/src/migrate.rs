//! Carrying the profile across the change of application identifier.
//!
//! WHY THIS IS THE DANGEROUS ONE. The identifier was `com.helix.assistant` and
//! is now `com.havoc.assistant`. Nobody ever sees it, but it is the name of the
//! directory the operating system gives this application - and the web view's
//! storage lives inside that directory. So renaming it does not rename the
//! profile; it hands Havoc a different, empty one, with settings, notes,
//! memory and projects all still on disk under the old name and none of them
//! reachable. The database rename in `IndexedDbStore` cannot help, because by
//! then it is looking in the wrong directory entirely.
//!
//! WHAT THIS GUARANTEES, AND WHY EACH ONE MATTERS.
//!
//! - **The old location is never written to, moved or deleted.** A copy that
//!   went wrong and a copy that went right are indistinguishable from in here.
//!   Only one of them is recoverable, so the original stays.
//!
//! - **It runs only when the new location does not exist.** Once Havoc has a
//!   profile of its own, copying into it could replace newer data with older.
//!
//! - **A failure cleans up after itself.** This is the subtle one. A half
//!   copied directory left in place would satisfy the check above on the next
//!   launch, so Havoc would start from a partial profile for ever and call it
//!   normal. On any error the partial copy is removed, which makes the next
//!   launch try again from a known state.
//!
//! - **It happens before the web view exists.** Called at the top of `run()`,
//!   for the same reason `env_file::load` is: afterwards is too late.
//!
//! WHAT IT CANNOT PROMISE. This has never been run on Windows by the author.
//! It reads one directory and writes another, deletes nothing, and undoes its
//! own partial work - so the failure modes are a wasted copy and a profile
//! that starts empty, both recoverable by putting the old identifier back. It
//! is still the one change here that deserves a backup first.

use std::path::{Path, PathBuf};

/// The identifier before the rename.
const LEGACY_ID: &str = "com.helix.assistant";
/// The identifier now, matching `tauri.conf.json`.
const CURRENT_ID: &str = "com.havoc.assistant";

/// What a migration attempt did, for the diagnostics report.
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMigration {
    /// Directory pairs that were copied, as "from -> to".
    pub copied: Vec<String>,
    /// Pairs that were skipped, with the reason.
    pub skipped: Vec<String>,
    /// Failures, with the reason. A partial copy was removed for each.
    pub failed: Vec<String>,
}

static REPORT: std::sync::Mutex<Option<ProfileMigration>> = std::sync::Mutex::new(None);

/// The roots an application's per-user data can sit under.
///
/// Windows uses both: roaming `APPDATA` for settings a profile follows the
/// user with, and `LOCALAPPDATA` for the web view's own store - which is where
/// IndexedDB actually is, and so the one that matters most here. On Linux and
/// macOS the equivalents are derived from `HOME`, which keeps this testable
/// and keeps a developer's own machine working.
fn roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    for variable in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(value) = std::env::var(variable) {
            if !value.trim().is_empty() {
                roots.push(PathBuf::from(value));
            }
        }
    }

    if roots.is_empty() {
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            roots.push(home.join(".local/share"));
            roots.push(home.join(".config"));
            roots.push(home.join("Library/Application Support"));
        }
    }

    roots
}

/// Copy a directory tree. Returns the first error, having copied what it could.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;

    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());

        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
        // Symlinks are skipped rather than followed. A link out of the profile
        // would make this copy something that is not the profile.
    }

    Ok(())
}

/// Bring the old profile across, once, if there is one and nothing newer.
pub fn profile() -> ProfileMigration {
    let mut report = ProfileMigration::default();

    for root in roots() {
        let legacy = root.join(LEGACY_ID);
        let current = root.join(CURRENT_ID);
        let pair = format!("{} -> {}", legacy.display(), current.display());

        if !legacy.is_dir() {
            continue;
        }
        if current.exists() {
            // Already has a profile of its own. Copying in could put older
            // data over newer, which is worse than leaving the old copy
            // unused.
            report.skipped.push(format!("{pair} (the new location already exists)"));
            continue;
        }

        match copy_tree(&legacy, &current) {
            Ok(()) => report.copied.push(pair),
            Err(error) => {
                // Remove the partial copy. Left in place it would satisfy the
                // check above next time, and Havoc would run from half a
                // profile and call it normal.
                let removed = std::fs::remove_dir_all(&current).is_ok();
                report.failed.push(format!(
                    "{pair} ({error}){}",
                    if removed {
                        "; the partial copy was removed, so the next start will try again"
                    } else {
                        "; the partial copy could NOT be removed - delete it by hand before restarting"
                    }
                ));
            }
        }
    }

    if let Ok(mut slot) = REPORT.lock() {
        *slot = Some(report.clone());
    }
    report
}

/// What the last migration attempt did. Empty when there was nothing to do.
#[tauri::command]
pub fn profile_migration() -> ProfileMigration {
    REPORT.lock().ok().and_then(|slot| slot.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "havoc-migrate-{label}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_a_tree_including_nested_files() {
        let base = temp("tree");
        let from = base.join("from");
        std::fs::create_dir_all(from.join("deep/deeper")).unwrap();
        std::fs::write(from.join("top.txt"), b"top").unwrap();
        std::fs::write(from.join("deep/deeper/leaf.txt"), b"leaf").unwrap();

        let to = base.join("to");
        copy_tree(&from, &to).unwrap();

        assert_eq!(std::fs::read_to_string(to.join("top.txt")).unwrap(), "top");
        assert_eq!(
            std::fs::read_to_string(to.join("deep/deeper/leaf.txt")).unwrap(),
            "leaf"
        );
        // And the original is untouched.
        assert!(from.join("top.txt").is_file());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn an_empty_directory_still_arrives() {
        let base = temp("empty");
        let from = base.join("from");
        std::fs::create_dir_all(from.join("hollow")).unwrap();

        let to = base.join("to");
        copy_tree(&from, &to).unwrap();
        assert!(to.join("hollow").is_dir());

        std::fs::remove_dir_all(&base).ok();
    }
}
