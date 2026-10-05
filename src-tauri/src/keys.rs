//! Keys, stored by the shell on the user's behalf.
//!
//! WHY THIS EXISTS. Every credential is read on this side of the boundary and
//! that is right, but it left the user editing a dotfile by hand - and a
//! dotfile is a bad place to ask anyone to put a secret. It needs a terminal,
//! or an editor that silently appends `.txt` and writes a byte-order mark, and
//! every one of those failures looks identical from inside Helix: a key that
//! does nothing. An evening went on telling one from another.
//!
//! WHAT THIS DOES NOT CHANGE. The web view still never holds a credential. It
//! sends one, once, at the moment the user types it, and cannot read it back:
//! `key_status` answers with names and whether each is set, never values, the
//! same way `configured_inference_providers` answers with ids. There is no
//! command that returns a key, and that is deliberate - a page that can read a
//! secret is a page from which a secret can be read.
//!
//! WHY NOT `set_var`. Setting a process variable after startup races with
//! anything already reading the environment, which is precisely why
//! `env_file::load` runs first and once. So a key saved while Helix is running
//! goes into the overlay below instead, and `get` checks the overlay before
//! the environment. Nothing mutates the process environment after startup.
//!
//! WHY AN ALLOW-LIST. This writes lines into a file the shell reads at its
//! next start. Without a fixed list of names, the web view could write any
//! variable it liked - PATH among them - and have the shell apply it on the
//! next launch. The list is the whole guard, so it is exact names, not a
//! pattern.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// The only names that may be written. Exact, not a pattern - see above.
pub const ALLOWED: &[(&str, &str)] = &[
    ("ELEVENLABS_API_KEY", "ElevenLabs (voice)"),
    ("MISTRAL_API_KEY", "Mistral"),
    ("CEREBRAS_API_KEY", "Cerebras"),
    ("GEMINI_API_KEY", "Google Gemini"),
    ("ANTHROPIC_API_KEY", "Anthropic"),
    ("BRAVE_API_KEY", "Brave (web search)"),
    ("GOOGLE_SEARCH_API_KEY", "Google (web search)"),
    ("UNSPLASH_ACCESS_KEY", "Unsplash (images)"),
    ("PEXELS_API_KEY", "Pexels (images)"),
];

fn allowed(name: &str) -> bool {
    ALLOWED.iter().any(|(key, _)| *key == name)
}

/// Keys saved during this run, which have deliberately not been put into the
/// process environment. See the note on `set_var` above.
static OVERLAY: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// A credential, wherever it came from.
///
/// The overlay first, so a key saved a moment ago works without a restart,
/// then the environment, which is what `env_file` filled at startup. Empty is
/// the same as absent: a shell that exports `KEY=` has supplied nothing.
pub fn get(name: &str) -> Option<String> {
    if let Ok(slot) = OVERLAY.lock() {
        if let Some(value) = slot.as_ref().and_then(|map| map.get(name)) {
            if !value.trim().is_empty() {
                return Some(value.clone());
            }
        }
    }

    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

#[derive(Serialize)]
pub struct KeyError {
    pub message: String,
}

impl From<String> for KeyError {
    fn from(message: String) -> Self {
        KeyError { message }
    }
}

/// Whether a key is set, and where it came from. Never the value.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub name: String,
    /// What this key is for, in plain words.
    pub label: String,
    pub set: bool,
    /// "saved" for one stored here, "environment" for one that was already
    /// set - the distinction matters, because the second cannot be changed
    /// from inside Helix and saying otherwise would be a lie.
    pub source: &'static str,
}

#[tauri::command]
pub fn key_status() -> Vec<KeyStatus> {
    let saved: Vec<String> = OVERLAY
        .lock()
        .ok()
        .and_then(|slot| {
            slot.as_ref().map(|map| {
                map.iter()
                    .filter(|(_, value)| !value.trim().is_empty())
                    .map(|(name, _)| name.clone())
                    .collect()
            })
        })
        .unwrap_or_default();

    ALLOWED
        .iter()
        .map(|(name, label)| {
            let in_overlay = saved.iter().any(|entry| entry == name);
            let in_env = std::env::var(name)
                .ok()
                .is_some_and(|value| !value.trim().is_empty());
            KeyStatus {
                name: (*name).to_string(),
                label: (*label).to_string(),
                set: in_overlay || in_env,
                source: if in_overlay {
                    "saved"
                } else if in_env {
                    "environment"
                } else {
                    "none"
                },
            }
        })
        .collect()
}

/// Replace or add one assignment in the text of a `.env`.
///
/// Pure, and separated from the file because this is the part that can lose
/// someone's other keys. Every other line is preserved exactly, including
/// comments and blanks; a line assigning this name is replaced wherever it
/// sits - all of them, because a duplicate left behind would shadow the new
/// value at the next start.
fn rewrite(contents: &str, name: &str, value: &str) -> String {
    let assignment = format!("{name}={value}");
    let mut out: Vec<String> = Vec::new();
    let mut replaced = false;

    for line in contents.lines() {
        let trimmed = line.trim_start_matches('\u{feff}').trim_start();
        let stripped = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let is_this_key = stripped
            .split_once('=')
            .is_some_and(|(key, _)| key.trim() == name);

        if is_this_key {
            if !replaced {
                out.push(assignment.clone());
                replaced = true;
            }
            // Any later assignment of the same name is dropped rather than
            // kept: two lines for one key is how a saved value silently
            // fails to take effect.
            continue;
        }
        out.push(line.to_string());
    }

    if !replaced {
        out.push(assignment);
    }

    let mut text = out.join("\n");
    text.push('\n');
    text
}

/// Where to write. The first candidate that exists, so an existing file is
/// edited rather than a second one created somewhere else - two files of keys
/// is the ambiguity this is meant to remove.
fn target() -> Option<std::path::PathBuf> {
    let candidates = crate::env_file::candidate_paths();
    if let Some(existing) = candidates.iter().find(|path| path.is_file()) {
        return Some(existing.clone());
    }
    // Nothing exists yet: create beside the executable, which is the installed
    // case and is searched first at startup.
    candidates.into_iter().next()
}

/// Save a key: to the file, so it survives a restart, and to the overlay, so
/// it works now.
#[tauri::command]
pub fn save_key(name: String, value: String) -> Result<String, KeyError> {
    if !allowed(&name) {
        return Err(KeyError::from(format!("Helix does not store a key called {name}.")));
    }

    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(KeyError::from("That key is empty.".to_string()));
    }
    // A newline would write a second assignment into the file, which is how a
    // field for one value becomes a field for any value.
    if value.contains(['\n', '\r']) {
        return Err(KeyError::from("A key cannot contain a line break.".to_string()));
    }

    let path = target().ok_or_else(|| {
        KeyError::from("Helix could not work out where to save this.".to_string())
    })?;

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, rewrite(&existing, &name, &value))
        .map_err(|error| KeyError::from(format!("The key could not be saved: {error}")))?;

    if let Ok(mut slot) = OVERLAY.lock() {
        slot.get_or_insert_with(HashMap::new).insert(name, value);
    }

    Ok(path.display().to_string())
}

/// Forget a key: removed from the file and from the overlay.
///
/// Cannot remove one that came from the real environment. Saying it had been
/// removed when the next request would still use it is exactly the kind of
/// false report this module exists to stop, so it says so instead.
#[tauri::command]
pub fn forget_key(name: String) -> Result<(), KeyError> {
    if !allowed(&name) {
        return Err(KeyError::from(format!("Helix does not store a key called {name}.")));
    }

    if let Ok(mut slot) = OVERLAY.lock() {
        if let Some(map) = slot.as_mut() {
            map.remove(&name);
        }
    }

    if let Some(path) = target() {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            // An empty assignment rather than a deleted line, so the file
            // keeps its shape and still documents which keys exist.
            let _ = std::fs::write(&path, rewrite(&existing, &name, ""));
        }
    }

    if std::env::var(&name).is_ok_and(|value| !value.trim().is_empty()) {
        return Err(KeyError::from(format!(
            "{name} is also set in this machine's environment, so it is still in use. Remove it there to stop that."
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_line_in_place_and_keeps_everything_else() {
        let before = "# comment\nMISTRAL_API_KEY=abc\n\nELEVENLABS_API_KEY=\n# tail\n";
        let after = rewrite(before, "ELEVENLABS_API_KEY", "sk_new");
        assert_eq!(
            after,
            "# comment\nMISTRAL_API_KEY=abc\n\nELEVENLABS_API_KEY=sk_new\n# tail\n"
        );
    }

    #[test]
    fn appends_when_the_key_is_not_there() {
        let after = rewrite("# only a comment\n", "BRAVE_API_KEY", "xyz");
        assert_eq!(after, "# only a comment\nBRAVE_API_KEY=xyz\n");
    }

    /// Two assignments of one name means the first wins at startup, so a
    /// saved value would silently not take effect.
    #[test]
    fn collapses_duplicates_to_one() {
        let before = "K=old\nOTHER=keep\nK=older\n";
        assert_eq!(rewrite(before, "K", "new"), "K=new\nOTHER=keep\n");
    }

    #[test]
    fn matches_a_line_written_with_export_or_spaces_or_a_mark() {
        for before in [
            "export ELEVENLABS_API_KEY=old\n",
            "ELEVENLABS_API_KEY = old\n",
            "\u{feff}ELEVENLABS_API_KEY=old\n",
        ] {
            assert_eq!(
                rewrite(before, "ELEVENLABS_API_KEY", "new"),
                "ELEVENLABS_API_KEY=new\n",
                "{before:?}"
            );
        }
    }

    #[test]
    fn writes_an_empty_assignment_when_forgetting() {
        assert_eq!(rewrite("K=secret\n", "K", ""), "K=\n");
    }

    /// The whole guard. Without it the web view could write PATH into a file
    /// the shell applies at its next start.
    #[test]
    fn only_known_names_are_allowed() {
        assert!(allowed("ELEVENLABS_API_KEY"));
        assert!(!allowed("PATH"));
        assert!(!allowed("ELEVENLABS_API_KEY_"));
        assert!(!allowed(""));
    }

    #[test]
    fn a_file_with_no_trailing_newline_still_ends_with_one() {
        assert_eq!(rewrite("A=1", "B", "2"), "A=1\nB=2\n");
    }
}
