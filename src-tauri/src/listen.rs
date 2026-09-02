//! Taking commands from the phone, over Tailscale.
//!
//! The opposite direction from everything else in this shell. `inference`,
//! `google` and `web` all reach *out*; this one listens, which makes it the
//! only part of Helix that anything else can start a conversation with. That
//! difference is the whole design.
//!
//! Three independent guards, and none of them is sufficient alone:
//!
//! **Only Tailscale peers and this machine may connect.** Checked on the TCP
//! peer address before a single byte of the request is read. Tailscale hands
//! out addresses in 100.64.0.0/10, so a listener bound to every interface is
//! still unreachable from the coffee-shop Wi-Fi the laptop happens to be on -
//! which is the scenario that makes "bind to 0.0.0.0 and require a password"
//! a bad plan on a portable machine.
//!
//! **A shared key must match**, compared in constant time. Unlike the mail
//! relay there is no sender to check here: a TCP connection has no From:
//! header, so the key is the only credential and it carries the whole weight.
//! The listener refuses to start without one.
//!
//! **The command is data.** It is handed to the same orchestrator the chat box
//! uses, so it gets the same tools, the same guardrails and the same refusals.
//! There is deliberately no second path with weaker rules.
//!
//! And, as with the relay: passing all of that makes a request authentic, not
//! authorised. Anything that sends, spends or deletes still needs confirming
//! at the machine.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

/// How long the phone waits for an answer.
///
/// Generous, because a local model on a modest machine genuinely takes this
/// long - measured at minutes when memory is tight. Shorter would time out on
/// a working system and look like a fault.
const REPLY_TIMEOUT_SECS: u64 = 180;

/// Largest request body accepted. A command is a sentence.
const MAX_BODY: usize = 16 * 1024;

/// Replies waiting to be filled in by the web view, keyed by request id.
static PENDING: OnceLock<Mutex<HashMap<String, Sender<String>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Sender<String>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether a listener is already running, so starting twice is harmless.
static RUNNING: OnceLock<Mutex<bool>> = OnceLock::new();

#[derive(Serialize, Clone)]
struct PhoneCommand {
    id: String,
    text: String,
}

#[derive(Deserialize)]
struct Body {
    key: String,
    text: String,
}

/// May this peer talk to Helix?
///
/// Loopback for testing on the machine itself, and the Tailscale range for the
/// phone. Everything else is refused before the request is read - a check on
/// the address costs nothing and removes the entire class of "someone else on
/// this network".
fn peer_allowed(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            // 100.64.0.0/10 - the carrier-grade NAT range Tailscale uses.
            v4.is_loopback() || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        // Tailscale's IPv6 range is fd7a:115c:a1e0::/48.
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] == 0xfd7a && v6.segments()[1] == 0x115c)
        }
    }
}

/// Constant-time comparison, so a wrong key reveals nothing about how wrong.
fn keys_match(given: &str, expected: &str) -> bool {
    if expected.is_empty() || given.len() != expected.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in given.bytes().zip(expected.bytes()) {
        difference |= a ^ b;
    }
    difference == 0
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let payload = serde_json::json!({ "reply": body }).to_string();
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        )
        .as_bytes(),
    );
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

fn handle(app: &tauri::AppHandle, mut stream: TcpStream, key: &str) {
    // Before anything is read. A refused peer never gets to send a request.
    let allowed = stream
        .peer_addr()
        .map(|address| peer_allowed(&address.ip()))
        .unwrap_or(false);

    if !allowed {
        // No body, and no explanation. Telling a stranger why they were
        // refused turns this into an oracle they can probe.
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }

    if !request_line.starts_with("POST") {
        respond(&mut stream, "405 Method Not Allowed", "Send a POST.");
        return;
    }

    // Headers, only to find the length.
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
            break;
        }
        if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }

    if length == 0 || length > MAX_BODY {
        respond(&mut stream, "400 Bad Request", "Send a JSON body.");
        return;
    }

    let mut raw = vec![0u8; length];
    if reader.read_exact(&mut raw).is_err() {
        return;
    }

    let body: Body = match serde_json::from_slice(&raw) {
        Ok(body) => body,
        Err(_) => {
            respond(&mut stream, "400 Bad Request", "That was not JSON I could read.");
            return;
        }
    };

    if !keys_match(&body.key, key) {
        // Same silence as a refused peer, and for the same reason.
        respond(&mut stream, "403 Forbidden", "No.");
        return;
    }

    let text = body.text.trim().to_string();
    if text.is_empty() {
        respond(&mut stream, "400 Bad Request", "There was no instruction in that.");
        return;
    }

    // Hand it to the web view, which owns the orchestrator, and wait for the
    // answer to come back through `phone_reply`.
    let id = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let (sender, receiver) = channel::<String>();

    if let Ok(mut map) = pending().lock() {
        map.insert(id.clone(), sender);
    }

    if app
        .emit("phone:command", PhoneCommand { id: id.clone(), text })
        .is_err()
    {
        if let Ok(mut map) = pending().lock() {
            map.remove(&id);
        }
        respond(&mut stream, "503 Service Unavailable", "Helix is not ready.");
        return;
    }

    match receiver.recv_timeout(Duration::from_secs(REPLY_TIMEOUT_SECS)) {
        Ok(reply) => respond(&mut stream, "200 OK", &reply),
        Err(_) => {
            if let Ok(mut map) = pending().lock() {
                map.remove(&id);
            }
            respond(
                &mut stream,
                "504 Gateway Timeout",
                "Helix took too long to answer. The instruction may still have run.",
            );
        }
    }
}

/// The web view hands back an answer for one waiting request.
#[tauri::command]
pub fn phone_reply(id: String, text: String) {
    let sender = pending().lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(text);
    }
}

#[derive(Serialize)]
pub struct ListenerStatus {
    pub running: bool,
    pub port: u16,
    /// Addresses the phone can use. Empty when Tailscale is not up.
    pub addresses: Vec<String>,
    pub message: String,
}

/// Start listening, if a key is set and nothing is listening already.
#[tauri::command]
pub fn start_phone_listener(
    app: tauri::AppHandle,
    port: u16,
    key: String,
) -> Result<ListenerStatus, String> {
    if key.trim().len() < 12 {
        // The only credential here, so it carries the whole weight - there is
        // no sender address to check as well, the way the mail relay has.
        return Err(
            "The shared key is the only thing protecting this, so it needs to be a real passphrase - at least twelve characters.".into(),
        );
    }

    let already = RUNNING.get_or_init(|| Mutex::new(false));
    {
        let mut running = already.lock().map_err(|_| "listener state is poisoned")?;
        if *running {
            return Ok(ListenerStatus {
                running: true,
                port,
                addresses: tailscale_addresses(),
                message: "Already listening.".into(),
            });
        }
        *running = true;
    }

    // Bound to every interface, which is safe only because `peer_allowed`
    // refuses anything that is not Tailscale or this machine. Binding to the
    // Tailscale address specifically would need interface enumeration and
    // would break every time Tailscale reassigned it.
    let listener = TcpListener::bind(("0.0.0.0", port))
        .map_err(|error| format!("Could not listen on port {port}: {error}"))?;

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let key = key.clone();
            std::thread::spawn(move || handle(&app, stream, &key));
        }
    });

    Ok(ListenerStatus {
        running: true,
        port,
        addresses: tailscale_addresses(),
        message: "Listening for your phone.".into(),
    })
}

/// This machine's Tailscale addresses, asked of Tailscale itself.
///
/// Empty is a real answer and means Tailscale is not running or not installed,
/// which the interface should say rather than showing a port and letting the
/// user wonder why nothing connects.
fn tailscale_addresses() -> Vec<String> {
    let output = std::process::Command::new("tailscale").args(["ip", "-4"]).output();

    match output {
        Ok(result) if result.status.success() => String::from_utf8_lossy(&result.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard that makes binding to every interface acceptable. A laptop
    /// joins networks it does not control; this is what keeps a command
    /// endpoint off them.
    #[test]
    fn allows_only_tailscale_and_this_machine() {
        assert!(peer_allowed(&"100.101.102.103".parse().unwrap()));
        assert!(peer_allowed(&"127.0.0.1".parse().unwrap()));

        for outsider in ["192.168.1.50", "10.0.0.7", "8.8.8.8", "172.16.0.1"] {
            assert!(!peer_allowed(&outsider.parse().unwrap()), "{outsider} allowed");
        }
    }

    #[test]
    fn allows_the_tailscale_ipv6_range() {
        assert!(peer_allowed(&"fd7a:115c:a1e0::1".parse().unwrap()));
        assert!(!peer_allowed(&"2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn compares_keys_without_leaking_where_they_differ() {
        assert!(keys_match("correct horse battery", "correct horse battery"));
        assert!(!keys_match("correct horse batterz", "correct horse battery"));
        assert!(!keys_match("short", "correct horse battery"));
        // An unset key must never match, least of all an empty attempt.
        assert!(!keys_match("", ""));
    }
}
