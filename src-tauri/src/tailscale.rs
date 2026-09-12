//! Where this machine is on the tailnet.
//!
//! Pairing asked the user to type their own address, because a web view cannot
//! see a VPN interface. It can be found out here, and asking someone to copy a
//! hostname out of another app to paste into this one is exactly the kind of
//! step that gets copied wrong.
//!
//! Three decisions worth stating:
//!
//! - **The MagicDNS name is preferred over the IP.** A tailnet address can
//!   change; the name does not. A pairing code is scanned once and expected to
//!   keep working, so the value baked into it must be the stable one.
//!
//! - **It only asks where *this* machine is.** `tailscale status` reports the
//!   whole tailnet - every other machine, and who owns them. None of that is
//!   needed to pair a phone, so only `Self` is read and nothing else leaves
//!   this function.
//!
//! - **"Not installed" and "not running" are kept apart.** They need different
//!   things done about them, and a single "could not find Tailscale" would
//!   send someone looking for a download they already have.

use std::process::Command;

use serde::Serialize;

/// Where to look for the CLI when it is not on PATH.
///
/// The Windows installer does not add itself to PATH, which is the case that
/// matters here; the macOS app keeps its binary inside the bundle.
const FALLBACK_PATHS: &[&str] = &[
    r"C:\Program Files\Tailscale\tailscale.exe",
    r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
];

#[derive(Serialize)]
pub struct TailscaleLookup {
    /// The address to give the phone, or null when it could not be found.
    pub address: Option<String>,
    /// Why not, in words the user can act on. Null when `address` is set.
    pub reason: Option<String>,
}

impl TailscaleLookup {
    fn found(address: String) -> Self {
        Self { address: Some(address), reason: None }
    }

    fn missing(reason: &str) -> Self {
        Self { address: None, reason: Some(reason.to_string()) }
    }
}

/// Pull this machine's own name out of `tailscale status --json`.
///
/// Separated from running the command so it can be tested against real output
/// without Tailscale being installed.
fn parse_status(json: &str) -> Result<String, String> {
    let root: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| "Tailscale replied with something Helix could not read.".to_string())?;

    // A backend that is not running still answers, and its answer contains no
    // usable address. Reporting that as "not found" would send someone looking
    // for a problem that is one click away in the Tailscale app.
    if let Some(state) = root.get("BackendState").and_then(|value| value.as_str()) {
        match state {
            "Running" => {}
            "NeedsLogin" | "NoState" => {
                return Err("Tailscale is installed but not signed in. Open it and log in.".into());
            }
            "Stopped" => {
                return Err("Tailscale is installed but switched off. Turn it on and try again.".into());
            }
            other => {
                return Err(format!("Tailscale is not connected right now (it reports \"{other}\")."));
            }
        }
    }

    let self_node = root
        .get("Self")
        .ok_or_else(|| "Tailscale did not say which machine this is.".to_string())?;

    // MagicDNS name first: it survives an address change, and a pairing code is
    // scanned once and expected to keep working.
    if let Some(name) = self_node.get("DNSName").and_then(|value| value.as_str()) {
        let trimmed = name.trim_end_matches('.').trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    // Falling back to the IP is better than failing, but it is the value that
    // can go stale, so it is second.
    if let Some(first) = self_node
        .get("TailscaleIPs")
        .and_then(|value| value.as_array())
        .and_then(|list| list.first())
        .and_then(|value| value.as_str())
    {
        if !first.trim().is_empty() {
            return Ok(first.trim().to_string());
        }
    }

    Err("Tailscale is running but gave this machine no address.".into())
}

fn run_tailscale() -> Option<String> {
    let mut candidates: Vec<String> = vec!["tailscale".to_string()];
    candidates.extend(FALLBACK_PATHS.iter().map(|path| (*path).to_string()));

    for candidate in candidates {
        let output = Command::new(&candidate).args(["status", "--json"]).output();
        if let Ok(output) = output {
            // A non-zero exit still prints JSON for a backend that is merely
            // stopped, so the body is worth parsing either way.
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

#[tauri::command]
pub fn tailscale_address() -> TailscaleLookup {
    match run_tailscale() {
        None => TailscaleLookup::missing(
            "Helix could not find Tailscale on this machine. Install it, sign in on this computer and on your phone, then try again.",
        ),
        Some(json) => match parse_status(&json) {
            Ok(address) => TailscaleLookup::found(address),
            Err(reason) => TailscaleLookup::missing(&reason),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    const RUNNING: &str = r#"{
        "BackendState": "Running",
        "Self": {
            "DNSName": "helix-desktop.tail1234.ts.net.",
            "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"]
        },
        "Peer": { "other": { "DNSName": "someone-else.tail1234.ts.net." } }
    }"#;

    #[test]
    fn prefers_the_name_that_does_not_change() {
        assert_eq!(parse_status(RUNNING).unwrap(), "helix-desktop.tail1234.ts.net");
    }

    #[test]
    fn falls_back_to_the_address_when_magic_dns_is_off() {
        let json = r#"{"BackendState":"Running","Self":{"DNSName":"","TailscaleIPs":["100.101.102.103"]}}"#;
        assert_eq!(parse_status(json).unwrap(), "100.101.102.103");
    }

    #[test]
    fn never_reports_another_machine_on_the_tailnet() {
        // Only Self is read. A peer's name must not be able to end up in a
        // pairing code, which would point the phone at somebody else's machine.
        let found = parse_status(RUNNING).unwrap();
        assert!(!found.contains("someone-else"));
    }

    #[test]
    fn tells_signed_out_apart_from_switched_off() {
        let needs_login = r#"{"BackendState":"NeedsLogin","Self":null}"#;
        let stopped = r#"{"BackendState":"Stopped","Self":null}"#;
        assert!(parse_status(needs_login).unwrap_err().contains("log in"));
        assert!(parse_status(stopped).unwrap_err().contains("Turn it on"));
    }

    #[test]
    fn refuses_output_it_cannot_read_rather_than_guessing() {
        assert!(parse_status("not json at all").is_err());
        assert!(parse_status(r#"{"BackendState":"Running"}"#).is_err());
    }

    #[test]
    fn refuses_a_running_backend_with_no_address() {
        let json = r#"{"BackendState":"Running","Self":{"DNSName":"","TailscaleIPs":[]}}"#;
        assert!(parse_status(json).unwrap_err().contains("no address"));
    }
}
