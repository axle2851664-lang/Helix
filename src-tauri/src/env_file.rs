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
fn candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            paths.push(parent.join(".env"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join(".env"));
        if let Some(parent) = cwd.parent() {
            paths.push(parent.join(".env"));
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
    let trimmed = line.trim();
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

/// Apply one file. Returns how many variables it set.
fn apply(path: &Path) -> usize {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return 0;
    };

    let mut applied = 0;
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
        applied += 1;
    }

    applied
}

/// Load the first `.env` found, if any.
///
/// Only the first: two files in scope at once is ambiguous, and a user
/// debugging a key would have no way to tell which had won.
pub fn load() -> Option<PathBuf> {
    for path in candidates() {
        if !path.is_file() {
            continue;
        }
        apply(&path);
        return Some(path);
    }
    None
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
