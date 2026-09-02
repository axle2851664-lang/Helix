//! Reaching the open web, carefully.
//!
//! The third thing this shell does that a page cannot, and the one with the
//! widest blast radius. Inference talks to a fixed set of providers; Google
//! talks to an allow-list of paths on one host. This talks to *whatever the
//! user asked about*, which means the destination is influenced by text Helix
//! did not write - a search result, a link in a page, eventually a suggestion
//! from a language model.
//!
//! So the guards here are about where a request may go, not what it carries.
//!
//! **Private addresses are refused.** Without that check, "fetch
//! http://127.0.0.1:11434/api/tags" reaches the model runtime, and
//! "http://169.254.169.254/" is the cloud metadata endpoint - the classic
//! server-side request forgery pair. Neither is a hypothetical once a page or
//! a model can propose a URL. Loopback, link-local, and the RFC 1918 ranges
//! are all refused, on the resolved address rather than on the text of the
//! host, because `http://127.0.0.1.nip.io/` is a public name for a private
//! address.
//!
//! **Redirects are followed by hand, not by the client.** A public host that
//! redirects to `127.0.0.1` defeats a check performed only on the URL the user
//! supplied, so every hop is re-checked.
//!
//! **Responses are capped.** A fetch with no size limit is a way to exhaust
//! the memory of a machine this project has spent a great deal of effort
//! measuring.

use serde::Serialize;
use std::net::IpAddr;

/// Bytes of a response Helix will hold. Beyond this the body is truncated.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// How long any single request may take.
const TIMEOUT_SECS: u64 = 15;

/// How many redirects to follow, checking each.
const MAX_REDIRECTS: usize = 5;

#[derive(Serialize)]
pub struct WebResponse {
    /// The URL that actually answered, after any redirects.
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub body: String,
    /// True when the body was cut off at the size cap.
    pub truncated: bool,
}

/// Is this address one Helix must never be steered into?
///
/// Checked on the resolved IP rather than the hostname. A name is not an
/// address, and `127.0.0.1.nip.io` is a public name that resolves to loopback
/// precisely so that host-string checks can be walked past.
fn is_private(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                // 100.64.0.0/10, carrier-grade NAT and Tailscale's range.
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // Unique local (fc00::/7) and link-local (fe80::/10).
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Refuse anything that is not a plain http(s) request to a public address.
fn check_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| format!("{raw} is not a URL I can read."))?;

    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("I only fetch http and https, not {scheme}.")),
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "That URL has no host.".to_string())?;

    // Resolution is what turns a name into the thing actually contacted, so
    // that is what gets judged. A name that resolves nowhere fails here too,
    // which is the right answer.
    let port = parsed.port_or_known_default().unwrap_or(80);
    let resolved = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
        .map_err(|_| format!("I could not resolve {host}."))?;

    let mut any = false;
    for socket in resolved {
        any = true;
        if is_private(&socket.ip()) {
            return Err(format!(
                "{host} resolves to a private address. I do not fetch from inside this machine or network."
            ));
        }
    }

    if !any {
        return Err(format!("{host} did not resolve to any address."));
    }

    Ok(parsed)
}

/// Hosts whose requests need a key, and where that key comes from.
///
/// Read from the environment and attached here, never handed to the web view -
/// the same arrangement as `inference.rs`, and for the same reason. The
/// project's settings schema says in its own header that secrets are not
/// settings; a Brave key briefly went in there anyway, which would have put it
/// in the web view's storage where everything in the page can read it.
const KEYED_HOSTS: &[(&str, &str, &str)] = &[
    // host, header name, environment variable
    ("api.search.brave.com", "X-Subscription-Token", "BRAVE_API_KEY"),
];

/// Which keyed providers actually have a key. Ids only, never values.
#[tauri::command]
pub fn configured_web_providers() -> Vec<String> {
    KEYED_HOSTS
        .iter()
        .filter(|(_, _, var)| std::env::var(var).map(|v| !v.trim().is_empty()).unwrap_or(false))
        .map(|(host, _, _)| (*host).to_string())
        .collect()
}

/// Fetch one URL, following redirects by hand so each hop is checked.
#[tauri::command]
pub async fn web_fetch(url: String) -> Result<WebResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        // Manual, because the client's own redirect following would jump to a
        // private address without consulting `check_url` again.
        .redirect(reqwest::redirect::Policy::none())
        // Identifying rather than impersonating. A server that would rather
        // not serve a tool can say so.
        .user_agent("Helix/0.1 (personal assistant; +https://github.com/)")
        .build()
        .map_err(|error| format!("Could not build an HTTP client: {error}"))?;

    let mut current = check_url(&url)?;

    for _ in 0..=MAX_REDIRECTS {
        let mut request = client.get(current.clone());

        // The key is attached only for the host it belongs to, and only at the
        // moment of the request. A redirect to another host re-enters this
        // loop and does not carry it - which is the whole reason the match is
        // inside the loop rather than outside it.
        if let Some(host) = current.host_str() {
            for (keyed_host, header, var) in KEYED_HOSTS {
                if host == *keyed_host {
                    if let Ok(key) = std::env::var(var) {
                        if !key.trim().is_empty() {
                            request = request.header(*header, key);
                        }
                    }
                }
            }
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Could not reach {current}: {error}"))?;

        let status = response.status();

        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| format!("{current} redirected without saying where."))?;

            let next = current
                .join(location)
                .map_err(|_| format!("{current} redirected somewhere I cannot read."))?;

            // The check that makes manual following worth the trouble.
            current = check_url(next.as_str())?;
            continue;
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();

        let final_url = response.url().to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Could not read the response from {current}: {error}"))?;

        let truncated = bytes.len() > MAX_BYTES;
        let slice = if truncated { &bytes[..MAX_BYTES] } else { &bytes[..] };

        return Ok(WebResponse {
            url: final_url,
            status: status.as_u16(),
            content_type,
            body: String::from_utf8_lossy(slice).to_string(),
            truncated,
        });
    }

    Err(format!("{url} redirected more than {MAX_REDIRECTS} times."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pair that makes this a security boundary rather than a convenience.
    /// Loopback reaches the model runtime on this machine; link-local reaches
    /// the cloud metadata endpoint on a great many others.
    #[test]
    fn refuses_loopback_and_link_local() {
        assert!(is_private(&"127.0.0.1".parse().unwrap()));
        assert!(is_private(&"::1".parse().unwrap()));
        assert!(is_private(&"169.254.169.254".parse().unwrap()));
    }

    #[test]
    fn refuses_the_private_ranges() {
        for address in ["10.0.0.1", "172.16.5.4", "192.168.1.1", "100.100.0.1"] {
            assert!(is_private(&address.parse().unwrap()), "{address} allowed");
        }
    }

    #[test]
    fn allows_ordinary_public_addresses() {
        for address in ["1.1.1.1", "8.8.8.8", "93.184.216.34"] {
            assert!(!is_private(&address.parse().unwrap()), "{address} refused");
        }
    }

    #[test]
    fn refuses_schemes_that_are_not_the_web() {
        for raw in ["file:///C:/Windows/win.ini", "ftp://example.com/x", "data:text/html,x"] {
            assert!(check_url(raw).is_err(), "{raw} allowed");
        }
    }

    #[test]
    fn refuses_a_url_it_cannot_read() {
        assert!(check_url("not a url").is_err());
    }
}
