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
/// The ranges allowed when the user has not named any.
///
/// Tailscale's, because that is what the setup guide describes. It is a
/// default and not an assumption: this was hard-coded to Tailscale, which
/// quietly made the whole feature Tailscale-only, and the first question asked
/// of it was whether a different VPN would work.
pub const DEFAULT_RANGES: &str = "100.64.0.0/10, fd7a:115c::/32";

/// One allowed range: an address and how many leading bits must match.
struct Cidr {
    base: IpAddr,
    bits: u32,
}

/// Parse "100.64.0.0/10" and friends. A bare address means an exact match.
fn parse_ranges(spec: &str) -> Vec<Cidr> {
    spec.split(',')
        .filter_map(|entry| {
            let entry = entry.trim();
            if entry.is_empty() {
                return None;
            }

            let (address, bits) = match entry.split_once('/') {
                Some((address, bits)) => (address, bits.trim().parse::<u32>().ok()?),
                // No prefix given: one address, matched exactly.
                None => (entry, if entry.contains(':') { 128 } else { 32 }),
            };

            let base: IpAddr = address.trim().parse().ok()?;
            let width = if base.is_ipv4() { 32 } else { 128 };
            if bits > width {
                return None;
            }

            Some(Cidr { base, bits })
        })
        .collect()
}

/// Do the first `bits` bits of these two addresses agree?
fn within(address: &IpAddr, range: &Cidr) -> bool {
    fn compare(address: &[u8], base: &[u8], bits: u32) -> bool {
        let whole = (bits / 8) as usize;
        if address[..whole] != base[..whole] {
            return false;
        }

        let remainder = bits % 8;
        if remainder == 0 {
            return true;
        }

        let mask = 0xffu8 << (8 - remainder);
        (address[whole] & mask) == (base[whole] & mask)
    }

    match (address, &range.base) {
        (IpAddr::V4(a), IpAddr::V4(b)) => compare(&a.octets(), &b.octets(), range.bits),
        (IpAddr::V6(a), IpAddr::V6(b)) => compare(&a.octets(), &b.octets(), range.bits),
        // A v4 peer never matches a v6 range, or the other way round.
        _ => false,
    }
}

/// May this peer talk to Helix?
///
/// Loopback always, so the machine can test itself. Otherwise only the ranges
/// the user configured - whichever mesh VPN they run. What must never happen
/// is a fallback to "allow everything" when the setting is empty or malformed:
/// a typo in a settings field is not consent to accept the whole internet, so
/// an unparseable list falls back to the default rather than to nothing.
fn peer_allowed(address: &IpAddr, ranges: &[Cidr]) -> bool {
    if address.is_loopback() {
        return true;
    }
    ranges.iter().any(|range| within(address, range))
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

fn handle(app: &tauri::AppHandle, mut stream: TcpStream, key: &str, ranges: &[Cidr]) {
    // Before anything is read. A refused peer never gets to send a request.
    let peer = stream.peer_addr().map(|address| address.ip()).ok();
    let allowed = peer.map(|address| peer_allowed(&address, ranges)).unwrap_or(false);

    if !allowed {
        // Logged locally, where only the user can see it, so a peer refused by
        // a range that does not cover their VPN is a diagnosable problem
        // rather than a silent one. Nothing goes back down the socket: telling
        // a stranger why they were refused turns this into an oracle.
        if let Some(address) = peer {
            eprintln!("helix: refused a connection from {address} - not in the allowed ranges");
        }
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
    ranges: Option<String>,
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

    // An empty or unparseable list falls back to the default rather than to an
    // empty allow-list. Neither extreme is right: allowing everything on a
    // typo would be catastrophic, and allowing nothing would look like a
    // broken listener. The default is a working configuration.
    //
    // Resolved once, here, rather than per connection - resolving it inside
    // the loop meant an empty setting parsed to an empty list every time and
    // the fallback never ran, so only loopback would ever have been let in.
    let requested = ranges.unwrap_or_default();
    let spec = if parse_ranges(&requested).is_empty() {
        DEFAULT_RANGES.to_string()
    } else {
        requested
    };

    // Bound to every interface, which is safe only because `peer_allowed`
    // refuses anything outside those ranges. Binding to the VPN's own address
    // instead would need interface enumeration and would break every time the
    // VPN reassigned it.
    let listener = TcpListener::bind(("0.0.0.0", port))
        .map_err(|error| format!("Could not listen on port {port}: {error}"))?;

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let key = key.clone();
            // Re-parsed per connection rather than shared behind a lock. It is
            // a handful of integers and this is not a hot path.
            let ranges = parse_ranges(&spec);
            std::thread::spawn(move || handle(&app, stream, &key, &ranges));
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
        let ranges = parse_ranges(DEFAULT_RANGES);

        assert!(peer_allowed(&"100.101.102.103".parse().unwrap(), &ranges));
        assert!(peer_allowed(&"127.0.0.1".parse().unwrap(), &ranges));

        for outsider in ["192.168.1.50", "10.0.0.7", "8.8.8.8", "172.16.0.1"] {
            assert!(!peer_allowed(&outsider.parse().unwrap(), &ranges), "{outsider} allowed");
        }
    }

    #[test]
    fn allows_the_tailscale_ipv6_range() {
        let ranges = parse_ranges(DEFAULT_RANGES);
        assert!(peer_allowed(&"fd7a:115c:a1e0::1".parse().unwrap(), &ranges));
        assert!(!peer_allowed(&"2001:4860:4860::8888".parse().unwrap(), &ranges));
    }

    /**
     * The point of making this configurable: any mesh VPN, not just Tailscale.
     * ZeroTier and a hand-rolled WireGuard both hand out ordinary private
     * addresses, which the hard-coded version refused outright.
     */
    #[test]
    fn honours_a_range_from_another_vpn() {
        let zerotier = parse_ranges("10.147.17.0/24");

        assert!(peer_allowed(&"10.147.17.42".parse().unwrap(), &zerotier));
        // Neighbouring private space is still refused - the range is a range.
        assert!(!peer_allowed(&"10.147.18.42".parse().unwrap(), &zerotier));
        // And naming one VPN does not implicitly allow another.
        assert!(!peer_allowed(&"100.101.102.103".parse().unwrap(), &zerotier));
    }

    #[test]
    fn accepts_several_ranges_and_a_bare_address() {
        let ranges = parse_ranges("10.147.17.0/24, 192.168.1.50, 100.64.0.0/10");

        assert!(peer_allowed(&"10.147.17.1".parse().unwrap(), &ranges));
        assert!(peer_allowed(&"192.168.1.50".parse().unwrap(), &ranges));
        assert!(peer_allowed(&"100.90.1.1".parse().unwrap(), &ranges));
        // A bare address is exactly that address, not its neighbours.
        assert!(!peer_allowed(&"192.168.1.51".parse().unwrap(), &ranges));
    }

    /**
     * Loopback is allowed whatever the configuration says, so the machine can
     * always test itself - and, more importantly, so a user who empties the
     * field cannot lock themselves out of diagnosing it.
     */
    #[test]
    fn loopback_survives_any_configuration() {
        assert!(peer_allowed(&"127.0.0.1".parse().unwrap(), &[]));
        assert!(peer_allowed(&"::1".parse().unwrap(), &parse_ranges("10.0.0.0/8")));
    }

    /**
     * The failure mode worth being certain about. A typo in a settings field
     * must never widen the allow-list, and an empty list must never mean
     * "everything".
     */
    #[test]
    fn rubbish_ranges_allow_nothing_rather_than_everything() {
        for spec in ["", "not an address", "10.0.0.0/99", "  ,  ,  "] {
            let ranges = parse_ranges(spec);
            assert!(
                !peer_allowed(&"8.8.8.8".parse().unwrap(), &ranges),
                "{spec:?} allowed a public address",
            );
        }
    }

    // A v4 peer must not match a v6 range by some accident of byte comparison.
    #[test]
    fn does_not_mix_address_families() {
        let v6 = parse_ranges("fd7a:115c::/32");
        assert!(!peer_allowed(&"100.101.102.103".parse().unwrap(), &v6));
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
