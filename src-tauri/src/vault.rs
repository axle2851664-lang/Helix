//! Reading the user's own notes off disk.
//!
//! The web view is given no filesystem. This module is the whole of what the
//! shell will do with real paths, and it is deliberately shaped as one narrow
//! command rather than a general file API:
//!
//! - **Read only.** There is no write, move or delete command here, and adding
//!   one should be argued for separately. Helix indexing your notes must not
//!   become Helix able to alter them.
//! - **Only where you pointed it.** Every file is resolved and checked to sit
//!   inside a configured root before it is opened, so a symlink out of the
//!   vault reaches nothing.
//! - **Text only, and bounded.** Anything over the caller's size limit, and
//!   anything that is not valid UTF-8, is skipped rather than guessed at.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One note, shaped to match the `VaultDocument` the graph builder already takes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub path: String,
    pub file_name: String,
    pub content: String,
    pub size_bytes: u64,
}

/// Extensions worth indexing. Deliberately short: these are the formats the
/// graph can actually read links and prose out of.
const TEXT_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

fn is_indexable(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| TEXT_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Is `candidate` genuinely inside `root`?
///
/// Both sides are canonicalised first, so `..` segments and symlinks are
/// resolved before the comparison rather than after. Without this a link
/// inside the vault pointing at the rest of the disk would be followed and
/// read, which is exactly the failure this module exists to prevent.
fn within_root(candidate: &Path, root: &Path) -> bool {
    match (candidate.canonicalize(), root.canonicalize()) {
        (Ok(candidate), Ok(root)) => candidate.starts_with(root),
        // If either side cannot be resolved, refuse. An unreadable path is not
        // evidence that it is safe to open.
        _ => false,
    }
}

fn is_ignored(name: &str, ignored: &[String]) -> bool {
    // Hidden directories are skipped whatever the caller says: .git holds a
    // copy of every file it tracks, and indexing it would double the vault.
    name.starts_with('.') || ignored.iter().any(|entry| entry == name)
}

fn walk(
    directory: &Path,
    root: &Path,
    max_file_bytes: u64,
    ignored: &[String],
    found: &mut Vec<VaultFile>,
) {
    // A directory that cannot be read is skipped rather than failing the whole
    // scan: one unreadable folder should not cost the user every other note.
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            if is_ignored(&name, ignored) {
                continue;
            }
            if !within_root(&path, root) {
                continue;
            }
            walk(&path, root, max_file_bytes, ignored, found);
            continue;
        }

        if !is_indexable(&path) || name.starts_with('.') {
            continue;
        }

        let size = match entry.metadata() {
            Ok(metadata) => metadata.len(),
            Err(_) => continue,
        };
        if size > max_file_bytes {
            continue;
        }

        if !within_root(&path, root) {
            continue;
        }

        // Non-UTF-8 files are skipped: the graph reads prose, and a lossy
        // conversion would put mojibake into the user's note titles.
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        found.push(VaultFile {
            path: path.to_string_lossy().to_string(),
            file_name: name,
            content,
            size_bytes: size,
        });
    }
}

/// Every indexable note under the given roots.
///
/// Returns what it could read rather than failing on the first problem: a
/// vault with one unreadable file should still produce a graph. Roots that do
/// not exist are skipped, which is the ordinary case before the user has
/// created the folder.
#[tauri::command]
pub fn vault_documents(roots: Vec<String>, max_file_bytes: u64, ignored_directories: Vec<String>) -> Vec<VaultFile> {
    let mut found = Vec::new();

    for root in roots {
        let path = PathBuf::from(&root);
        if !path.is_dir() {
            continue;
        }
        walk(&path, &path, max_file_bytes, &ignored_directories, &mut found);
    }

    // Sorted by path so the graph's node order - and therefore its layout - is
    // the same on every run, rather than following directory order.
    found.sort_by(|left, right| left.path.cmp(&right.path));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_only_text_note_extensions() {
        assert!(is_indexable(Path::new("a/b/note.md")));
        assert!(is_indexable(Path::new("a/b/note.MARKDOWN")));
        assert!(is_indexable(Path::new("a/b/note.txt")));
        assert!(!is_indexable(Path::new("a/b/photo.png")));
        assert!(!is_indexable(Path::new("a/b/archive.zip")));
        assert!(!is_indexable(Path::new("a/b/no-extension")));
    }

    #[test]
    fn skips_hidden_and_configured_directories() {
        let ignored = vec!["node_modules".to_string()];
        assert!(is_ignored(".git", &ignored));
        assert!(is_ignored(".cache", &ignored));
        assert!(is_ignored("node_modules", &ignored));
        assert!(!is_ignored("projects", &ignored));
    }

    #[test]
    fn refuses_paths_outside_the_root() {
        let root = std::env::temp_dir();
        // The parent of a root is never inside it, however it is spelled.
        assert!(!within_root(Path::new("/"), &root) || root == Path::new("/"));
        assert!(within_root(&root, &root));
    }

    /// Builds a small vault on disk and returns its root.
    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("helix-vault-test-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("projects")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();

        fs::write(root.join("first.md"), "# First\n\nLinks to [[Second]].").unwrap();
        fs::write(root.join("projects/second.md"), "# Second").unwrap();
        fs::write(root.join("notes.txt"), "plain text counts").unwrap();
        fs::write(root.join(".hidden/secret.md"), "must not be read").unwrap();
        fs::write(root.join("node_modules/dep.md"), "must not be read").unwrap();
        fs::write(root.join("photo.png"), "not text").unwrap();
        fs::write(root.join("huge.md"), "x".repeat(4096)).unwrap();
        root
    }

    fn names(files: &[VaultFile]) -> Vec<String> {
        let mut names: Vec<String> = files.iter().map(|f| f.file_name.clone()).collect();
        names.sort();
        names
    }

    #[test]
    fn reads_notes_and_leaves_everything_else_alone() {
        let root = fixture("basic");
        let files = vault_documents(
            vec![root.to_string_lossy().to_string()],
            1024,
            vec!["node_modules".to_string()],
        );

        // Present: markdown and text, at any depth. Absent: hidden folders,
        // ignored folders, non-text files, and anything over the size cap.
        assert_eq!(names(&files), vec!["first.md", "notes.txt", "second.md"]);
        assert!(files.iter().any(|f| f.content.contains("[[Second]]")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_root_yields_nothing_rather_than_failing() {
        let files = vault_documents(
            vec![std::env::temp_dir().join("helix-no-such-vault").to_string_lossy().to_string()],
            1024,
            vec![],
        );
        assert!(files.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_out_of_the_vault_is_not_followed() {
        let root = fixture("symlink");
        let outside = std::env::temp_dir().join("helix-outside-the-vault");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("private.md"), "not part of the vault").unwrap();

        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        let files = vault_documents(vec![root.to_string_lossy().to_string()], 1024, vec![]);
        assert!(
            !files.iter().any(|f| f.file_name == "private.md"),
            "a symlink out of the vault was followed"
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn unresolvable_paths_are_refused_rather_than_allowed() {
        let root = std::env::temp_dir();
        let missing = root.join("helix-does-not-exist-9d15e56");
        assert!(!within_root(&missing, &root));
    }
}
