//! Reading keys out of a `.env` file, once, at startup.
//!
//! WHY THIS EXISTS. Every credential Helix uses is read with `std::env::var`
//! on this side of the boundary - that is the arrangement `inference.rs` and
//! `web.rs` both describe, and it is a good one. But nothing ever put anything
//! *into* the environment. `.gitignore` has listed `.env` and `!.env.example`
//! since the beginning, which says plainly that a file was meant to work, and
//! no code had ever read one. Keys placed there did nothing, silently, which
//! is the worst way for a credential to fail.
//!
//! WHY IT IS HAND-WRITTEN. `.env` is a tiny format and this is forty lines of
//! parsing with no edge cases that matter. The project already draws this line
//! in `Cargo.toml`: `sha2` is a dependency because a hand-rolled hash would be
//! a different matter entirely, while base64url is written out in `google.rs`
//! because it is twenty lines. This is the second kind.
//!
//! THE RULE THAT MATTERS. A variable already present in the environment always
//! wins. A `.env` file is a convenience for a machine that has none set; it
//! must never quietly override a key someone exported on purpose, because then
//! the value in use is not the one they can see.

use std::path::{Path, PathBuf};

/// Where a `.env` may sit, in the order they are tried.
///
/// Beside the executable first, because that is the installed case and the one
/// a user who has never seen a terminal will reach for. Then the working
/// directory and its parent, which between them cover `npm run tauri:dev` -
/// where the process runs in `src-tauri/` and most people put the file at the
/// repository root.
/// The names a file of keys may have.
///
/// `.env.txt` is here because Notepad puts it there. Its save dialog defaults
/// to "Text Documents (*.txt)" and appends the extension without saying so, so
/// a user who followed the instruction to the letter ends up with a file this
/// would never have looked at - and the failure is a key that does nothing,
/// with no way to tell that from a key that was rejected. Accepting the name
/// costs one line; not accepting it cost an evening.
const NAMES: &[&str] = &[".env", ".env.txt"];

fn candidates() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
            // Under `tauri dev` the executable sits in
            // src-tauri/target/debug/, three levels below the repository
            // root where the file usually is. Walking up covers that without
            // depending on how the process was launched.
            for extra in parent.ancestors().skip(1).take(3) {
                dirs.push(extra.to_path_buf());
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            dirs.push(parent.to_path_buf());
        }
    }

    let mut paths = Vec::new();
    for dir in dirs {
        for name in NAMES {
            let path = dir.join(name);
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

/// One `KEY=value` line, or None for a blank line or a comment.
///
/// Quotes are stripped when they wrap the whole value, because every example
/// of a `.env` anywhere shows both quoted and bare forms and a user should not
/// have to know which this accepts. `export KEY=value` is accepted for the
/// same reason: it is what shell documentation tells people to write.
fn parse_line(line: &str) -> Option<(String, String)> {
    // The byte-order mark, stripped before anything else.
    //
    // Notepad writes UTF-8 with a BOM, and `read_to_string` keeps it. It
    // lands on the first character of the first line, so the name parses as
    // "\u{feff}ELEVENLABS_API_KEY", fails the character check, and the line is
    // skipped - which means a file whose first line is the key reads as a file
    // with no keys in it, silently.
    let trimmed = line.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim_start();
    let (name, value) = trimmed.split_once('=')?;

    let name = name.trim();
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }

    let value = value.trim();
    let value = if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    };

    Some((name.to_string(), value.to_string()))
}

/// Apply one file. Returns the names of the variables it set.
fn apply(path: &Path) -> Vec<String> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    let mut applied = Vec::new();
    for line in contents.lines() {
        let Some((name, value)) = parse_line(line) else {
            continue;
        };

        // Already set wins, always. A file must not override a value someone
        // exported deliberately - the key in use would then not be the one
        // they can see.
        if std::env::var_os(&name).is_some() {
            continue;
        }

        // Called once, from `run()`, before any thread that might read the
        // environment has started. That ordering is the whole safety argument:
        // `setenv` is unsound alongside a concurrent reader, which is why this
        // happens here and nowhere else. (Rust 2024 marks the call `unsafe`
        // for that reason; this crate is on 2021, where it is not.)
        std::env::set_var(&name, &value);
        applied.push(name);
    }

    applied
}

/// What loading did, so a key that does nothing can be diagnosed.
///
/// Names only, never values. A variable name is not a secret and this is the
/// one thing that answers "did my key arrive"; the value stays on this side of
/// the boundary exactly as `configured_inference_providers` keeps it.
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    /// Every path tried, in order.
    pub searched: Vec<String>,
    /// The ones that existed and were read.
    pub loaded: Vec<String>,
    /// Names of the variables the files set, sorted.
    pub names: Vec<String>,
}

static REPORT: std::sync::Mutex<Option<EnvReport>> = std::sync::Mutex::new(None);

/// Load every file of keys that exists.
///
/// Every one, not just the first. Stopping at the first was meant to avoid the
/// ambiguity of two files in scope, but it created a worse failure: a stale or
/// empty `.env` beside the executable silently won over the real one at the
/// repository root, and nothing said which had been read. Earlier files still
/// take precedence per variable - the first value for a name wins, and so does
/// a variable already in the environment - so the ordering still means
/// something. What has gone is the chance of the right file never being
/// opened.
pub fn load() -> EnvReport {
    let mut report = EnvReport::default();

    for path in candidates() {
        report.searched.push(path.display().to_string());
        if !path.is_file() {
            continue;
        }
        let names = apply(&path);
        if !names.is_empty() {
            report.names.extend(names);
        }
        report.loaded.push(path.display().to_string());
    }

    report.names.sort();
    report.names.dedup();

    if let Ok(mut slot) = REPORT.lock() {
        *slot = Some(report.clone());
    }
    report
}

/// What the last load did. Empty before `load` has run.
#[tauri::command]
pub fn env_file_report() -> EnvReport {
    REPORT.lock().ok().and_then(|slot| slot.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::parse_line;

    #[test]
    fn reads_an_ordinary_line() {
        assert_eq!(
            parse_line("MISTRAL_API_KEY=abc123"),
            Some(("MISTRAL_API_KEY".into(), "abc123".into()))
        );
    }

    #[test]
    fn tolerates_the_forms_people_actually_write() {
        // Spaces around the equals, `export`, and quotes - all of which turn
        // up in the instructions people copy from.
        for line in [
            "MISTRAL_API_KEY = abc123",
            "export MISTRAL_API_KEY=abc123",
            "MISTRAL_API_KEY=\"abc123\"",
            "MISTRAL_API_KEY='abc123'",
            "  MISTRAL_API_KEY=abc123  ",
        ] {
            assert_eq!(
                parse_line(line),
                Some(("MISTRAL_API_KEY".into(), "abc123".into())),
                "{line}"
            );
        }
    }

    #[test]
    fn ignores_blanks_and_comments() {
        for line in ["", "   ", "# MISTRAL_API_KEY=abc", "#comment"] {
            assert_eq!(parse_line(line), None, "{line}");
        }
    }

    #[test]
    fn refuses_a_line_that_is_not_an_assignment() {
        for line in ["just some words", "=novalue", "BAD NAME=value", "KEY-WITH-DASH=v"] {
            assert_eq!(parse_line(line), None, "{line}");
        }
    }

    /// Notepad writes UTF-8 with a BOM, and it lands on the first character
    /// of the first line - so without this the key on line one is skipped and
    /// the file reads as empty.
    #[test]
    fn a_byte_order_mark_does_not_hide_the_first_key() {
        assert_eq!(
            parse_line("\u{feff}ELEVENLABS_API_KEY=abc123"),
            Some(("ELEVENLABS_API_KEY".into(), "abc123".into()))
        );
    }

    /// A key may contain anything, including '=' and '#'. Splitting on the
    /// first '=' only, and never treating a later '#' as a comment, is what
    /// keeps a real key intact.
    #[test]
    fn keeps_a_value_whole() {
        assert_eq!(
            parse_line("K=a=b#c"),
            Some(("K".into(), "a=b#c".into()))
        );
    }
}
