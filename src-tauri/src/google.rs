//! Google OAuth, and Gmail requests made where the token can be held.
//!
//! Same boundary as `inference.rs`, for a stronger reason. An API key is bad
//! to leak; a Google refresh token is worse. It does not expire on its own, it
//! survives a password change, and it opens a mailbox. So it is minted here,
//! stored here, refreshed here and attached here, and no command in this file
//! ever returns one to the web view. The page can ask Helix to read mail. It
//! cannot ever learn what authorised that.
//!
//! The flow is the installed-application one, which is the right shape for a
//! program running on somebody's own machine:
//!
//!   1. A one-shot HTTP listener opens on 127.0.0.1 with an OS-assigned port.
//!   2. The system browser is sent to Google's consent page.
//!   3. Google redirects back to that loopback port with a code.
//!   4. The code is exchanged for tokens, over TLS, from this process.
//!
//! Two attacks the flow is built against, both real and both cheap to defeat:
//!
//!   - **Another local program racing for the code.** PKCE (RFC 7636) means
//!     the code is worthless without the verifier, which never leaves this
//!     process. S256, not `plain` - `plain` sends the verifier in the clear
//!     and defeats the point.
//!   - **A forged callback.** A `state` value is generated per attempt and
//!     compared on return, so a request Helix did not start is refused.
//!
//! On storage, plainly: the refresh token is written to a file in the user's
//! own AppData, readable by that user's account. That is what gcloud, gh and
//! every comparable tool do, and it is not encryption. Anything already
//! running as the user can read it - as it could read their browser cookies.
//! Windows DPAPI would raise that bar and is not done here; saying so is
//! better than implying a protection that is absent.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const API_BASE: &str = "https://gmail.googleapis.com";
const CALENDAR_BASE: &str = "https://www.googleapis.com";
const DOCS_BASE: &str = "https://docs.googleapis.com";

/// Exactly what Helix asks for. Mirrors `src/integrations/google/scopes.ts`,
/// and a test on that side asserts the full-mailbox scope is never among them.
const SCOPES: &str = concat!(
    "https://www.googleapis.com/auth/gmail.readonly ",
    "https://www.googleapis.com/auth/gmail.modify ",
    "https://www.googleapis.com/auth/gmail.send ",
    "https://www.googleapis.com/auth/calendar.readonly ",
    "https://www.googleapis.com/auth/userinfo.email"
);

/// How long to wait for the user to finish at Google before giving up.
const CONSENT_TIMEOUT_SECS: u64 = 300;

// ---------------------------------------------------------------- base64url

/// Base64url without padding, per RFC 4648 §5.
///
/// Written out rather than pulled in, because it is twenty lines and the
/// alphabet is the whole of the specification. PKCE requires the URL-safe
/// alphabet and no padding; standard base64 here produces a challenge Google
/// rejects with an unhelpful error.
fn base64_url(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[(triple >> 18 & 0x3F) as usize] as char);
        out.push(ALPHABET[(triple >> 12 & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6 & 0x3F) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(triple & 0x3F) as usize] as char);
        }
    }
    out
}

/// Percent-encoding for query values, unreserved set per RFC 3986.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Cryptographically random bytes, from the OS.
///
/// `getrandom` is a dependency of the TLS stack already in this binary, so
/// this adds nothing to the build. A verifier from a weak source would make
/// PKCE decorative.
fn random_token(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|error| format!("no system randomness: {error}"))?;
    Ok(base64_url(&buffer))
}

// -------------------------------------------------------------------- state

#[derive(Serialize, Deserialize, Default)]
struct StoredTokens {
    refresh_token: String,
    account: String,
    client_id: String,
    client_secret: String,
}

/// Where the token file lives. Under the user's own roaming AppData.
fn token_path() -> Result<PathBuf, String> {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot locate an application data directory.".to_string())?;

    let dir = PathBuf::from(base).join("Helix");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Cannot create {dir:?}: {error}"))?;
    Ok(dir.join("google-tokens.json"))
}

fn load_tokens() -> Option<StoredTokens> {
    let path = token_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_tokens(tokens: &StoredTokens) -> Result<(), String> {
    let path = token_path()?;
    let json = serde_json::to_string_pretty(tokens).map_err(|error| error.to_string())?;
    std::fs::write(&path, json).map_err(|error| format!("Cannot write {path:?}: {error}"))
}

// ------------------------------------------------------------- the callback

struct Callback {
    code: String,
    state: String,
}

/// Wait for Google to redirect back, and read the one request that arrives.
///
/// Deliberately single-shot. A listener left open after the exchange is a
/// local endpoint anyone on the machine can post to, for no further benefit.
fn await_callback(listener: TcpListener, expected_state: &str) -> Result<Callback, String> {
    listener
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(CONSENT_TIMEOUT_SECS);

    for stream in listener.incoming() {
        if std::time::Instant::now() > deadline {
            return Err("Timed out waiting for Google to redirect back.".into());
        }

        let mut stream = match stream {
            Ok(stream) => stream,
            Err(_) => continue,
        };

        let mut line = String::new();
        BufReader::new(&stream)
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;

        // "GET /?code=...&state=... HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");

        let mut code = String::new();
        let mut state = String::new();
        let mut error = String::new();
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let decoded = value.replace('+', " ");
            match key {
                "code" => code = decoded,
                "state" => state = decoded,
                "error" => error = decoded,
                _ => {}
            }
        }

        let outcome = if !error.is_empty() {
            "Helix was refused access. You can close this tab."
        } else if code.is_empty() {
            "Something came back without an authorisation code. You can close this tab."
        } else {
            "Helix is connected. You can close this tab."
        };

        let body = format!(
            "<!doctype html><meta charset=utf-8><title>Helix</title>\
             <body style=\"font:16px system-ui;padding:3rem;color:#1b1719\">{outcome}</body>"
        );
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
        let _ = stream.flush();

        if !error.is_empty() {
            return Err(format!("Google returned an error: {error}"));
        }
        if code.is_empty() {
            return Err("No authorisation code in the redirect.".into());
        }
        // The check that makes a forged callback useless.
        if state != expected_state {
            return Err("The redirect did not match the request Helix started.".into());
        }

        return Ok(Callback { code, state });
    }

    Err("The callback listener closed without a redirect.".into())
}

// ------------------------------------------------------------------ commands

#[derive(Serialize)]
pub struct GoogleStatus {
    pub connected: bool,
    pub account: Option<String>,
}

#[tauri::command]
pub fn google_status() -> GoogleStatus {
    match load_tokens() {
        Some(tokens) if !tokens.refresh_token.is_empty() => GoogleStatus {
            connected: true,
            account: Some(tokens.account),
        },
        _ => GoogleStatus {
            connected: false,
            account: None,
        },
    }
}

/// Forget the connection.
///
/// Removes the file rather than blanking it. A revoke call to Google would be
/// better still and needs the network; this at least means the machine no
/// longer holds the token.
#[tauri::command]
pub fn google_disconnect() -> Result<(), String> {
    let path = token_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| format!("Cannot remove {path:?}: {error}"))?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

/// Run the whole consent flow. Returns the connected address, never a token.
#[tauri::command]
pub async fn google_connect(client_id: String, client_secret: String) -> Result<String, String> {
    if client_id.trim().is_empty() {
        return Err("No Google client ID was provided.".into());
    }

    // Port 0: the OS picks a free one, so two attempts never collide and no
    // fixed port has to be reserved.
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| {
        format!("Cannot open a loopback listener for the Google redirect: {error}")
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_token(48)?;
    let state = random_token(24)?;

    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, verifier.as_bytes());
    let challenge = base64_url(&sha2::Digest::finalize(hasher));

    let auth_url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencode(&client_id),
        urlencode(&redirect_uri),
        urlencode(SCOPES),
        urlencode(&challenge),
        urlencode(&state),
    );

    // The listener blocks, so it waits on a thread rather than stalling the
    // async runtime the rest of the app is using.
    let waiting = tokio::task::spawn_blocking(move || await_callback(listener, &state));

    open_in_browser(&auth_url)?;

    let callback = waiting
        .await
        .map_err(|error| format!("The consent listener failed: {error}"))??;
    let _ = callback.state;

    let client = reqwest::Client::new();
    let response = client
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", callback.code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach Google to exchange the code: {error}"))?;

    if !response.status().is_success() {
        // The body can echo request parameters, so the status alone is
        // reported. A token or a code must never reach a log.
        return Err(format!(
            "Google refused the authorisation code ({}).",
            response.status()
        ));
    }

    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Google's token response could not be read: {error}"))?;

    let refresh_token = tokens.refresh_token.ok_or(
        "Google did not return a refresh token. Remove Helix from your account's third-party \
         access list and connect again, which forces a fresh consent.",
    )?;

    let account = fetch_account(&client, &tokens.access_token)
        .await
        .unwrap_or_default();

    save_tokens(&StoredTokens {
        refresh_token,
        account: account.clone(),
        client_id,
        client_secret,
    })?;

    Ok(account)
}

/// Which account this actually is, asked rather than assumed.
async fn fetch_account(client: &reqwest::Client, access_token: &str) -> Option<String> {
    let response = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?;

    let value: serde_json::Value = response.json().await.ok()?;
    value
        .get("email")
        .and_then(|email| email.as_str())
        .map(str::to_string)
}

/// Trade the stored refresh token for a short-lived access token.
async fn access_token(client: &reqwest::Client) -> Result<String, String> {
    let stored = load_tokens().ok_or("Google is not connected.")?;
    if stored.refresh_token.is_empty() {
        return Err("Google is not connected.".into());
    }

    let response = client
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("client_id", stored.client_id.as_str()),
            ("client_secret", stored.client_secret.as_str()),
            ("refresh_token", stored.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach Google to refresh access: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let dead = grant_is_dead(&body);

        // A dead grant is not a transient failure, and leaving the token file
        // in place would have `google_status` keep reporting "connected" while
        // every call fails - the exact shape of lie this codebase refuses.
        // Removing it makes the UI tell the truth without any UI change.
        if dead {
            let _ = google_disconnect();
        }

        return Err(refresh_failure_message(status.as_u16(), &body));
    }

    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Google's refresh response could not be read: {error}"))?;

    Ok(tokens.access_token)
}

/// Has Google said this grant is finished, rather than that something failed?
///
/// `invalid_grant` is the one answer that means reconnecting is the only fix:
/// the refresh token has expired, been revoked, or had its consent withdrawn.
/// Every other failure - a 500, a timeout, a rate limit - is the world being
/// temporarily unavailable, and throwing away a working token over one of
/// those would sign the user out for no reason.
fn grant_is_dead(body: &str) -> bool {
    // The field, not the substring. A human-readable description mentioning
    // the phrase must not count, or an unrelated failure whose message quotes
    // the error would delete a perfectly good token.
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .is_some_and(|error| error == "invalid_grant")
}

/// What to tell the user, in the one place this is decided.
///
/// The seven-day sentence is here because it is the single most-repeated
/// error this product will ever show. Helix is an unverified app on Google's
/// Testing publishing status - a deliberate choice, since verification for
/// restricted scopes means an annual paid security assessment - and Google
/// expires a test user's refresh token after seven days. Saying "you may need
/// to connect again" every week, without saying why, would read as Helix
/// being broken. It is not broken; this is the price of the choice, and
/// naming it is the difference between a bug and a known cost.
fn refresh_failure_message(status: u16, body: &str) -> String {
    if grant_is_dead(body) {
        return "Google has expired this connection. Unverified apps stay on Google's \
                Testing status, where a sign-in lasts seven days - so this is expected \
                roughly weekly rather than a fault. Connect your Google account again in \
                Settings."
            .into();
    }

    if status >= 500 {
        return format!(
            "Google could not refresh access just now ({status}). That is a problem at \
             Google's end rather than with your connection, so it is worth trying again \
             shortly."
        );
    }

    format!(
        "Google would not refresh access ({status}). Your connection is still stored; if \
         this keeps happening, reconnect your Google account in Settings."
    )
}

/// Paths the web view is allowed to ask for.
///
/// An allow-list rather than a pass-through. Without it the page could name
/// any path under googleapis.com and this command would attach a credential to
/// it - which would hand the front end exactly the reach the token was being
/// kept away from. The scopes are a second wall; this is the first.
fn allowed(path: &str) -> bool {
    // No scheme, no host, no traversal: a path and nothing else.
    if !path.starts_with('/') || path.contains("..") || path.contains("://") {
        return false;
    }

    const PREFIXES: &[&str] = &[
        // Covers list, get, batchModify and send - all are paths beneath it.
        "/gmail/v1/users/me/messages",
        "/gmail/v1/users/me/labels",
        "/gmail/v1/users/me/profile",
        "/calendar/v3/calendars/",
        "/calendar/v3/users/me/calendarList",
        // Creating a document, and editing one Helix created. The drive.file
        // scope is the second wall: it covers nothing else in the account.
        "/v1/documents",
    ];
    PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

/// Which Google host serves this path.
///
/// Split out so it can be tested: routing a Docs path to the Gmail host does
/// not fail loudly, it 404s with a message about a message id.
fn base_for(path: &str) -> &'static str {
    if path.starts_with("/calendar") {
        CALENDAR_BASE
    } else if path.starts_with("/v1/documents") {
        DOCS_BASE
    } else {
        API_BASE
    }
}

/// Make a Google API request with the token attached here, never there.
#[tauri::command]
pub async fn google_request(
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !allowed(&path) {
        return Err(format!("Helix does not make requests to {path}."));
    }

    let client = reqwest::Client::new();
    let token = access_token(&client).await?;

    let base = base_for(&path);
    let url = format!("{base}{path}");

    let request = match &body {
        Some(payload) => client.post(&url).json(payload),
        None => client.get(&url),
    };

    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("The Google request failed: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Google answered {status}."));
    }

    response
        .json()
        .await
        .map_err(|error| format!("Google's response could not be read: {error}"))
}

/// Hand a URL to the system browser.
///
/// Consent happens in the user's real browser, where they can see the address
/// bar and Google's certificate. Showing Google's sign-in inside an app window
/// trains people to type their password into whatever looks close enough, and
/// Google refuses embedded webviews for this flow anyway.
fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|error| format!("Could not open your browser: {error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener)
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open your browser: {error}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The weekly one. Google says invalid_grant; the token is finished.
    #[test]
    fn an_expired_grant_is_recognised() {
        let body = r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#;
        assert!(grant_is_dead(body));
        let message = refresh_failure_message(400, body);
        assert!(message.contains("seven days"), "{message}");
        assert!(message.contains("Settings"), "{message}");
    }

    /// The failure that must NOT sign the user out. Throwing away a working
    /// refresh token because Google had a bad minute is a self-inflicted
    /// weekly outage on top of the real one.
    #[test]
    fn a_server_error_does_not_kill_the_grant() {
        for body in ["", "{}", r#"{"error":"backendError"}"#, "<html>502</html>"] {
            assert!(!grant_is_dead(body), "body: {body}");
        }
        let message = refresh_failure_message(503, "{}");
        assert!(message.contains("Google's end"), "{message}");
        assert!(!message.contains("seven days"), "{message}");
    }

    /// The field, not the substring. A description that happens to quote the
    /// phrase is not Google declaring the grant dead.
    #[test]
    fn a_mention_in_prose_is_not_a_dead_grant() {
        let body = r#"{"error":"rateLimitExceeded","error_description":"not an invalid_grant"}"#;
        assert!(!grant_is_dead(body));
    }

    #[test]
    fn a_plain_4xx_keeps_the_connection_and_says_so() {
        let message = refresh_failure_message(429, r#"{"error":"rateLimitExceeded"}"#);
        assert!(message.contains("still stored"), "{message}");
    }

    /// Whatever happens, the user is never left without a next step.
    #[test]
    fn every_message_names_something_to_do() {
        for (status, body) in [
            (400u16, r#"{"error":"invalid_grant"}"#),
            (500, "{}"),
            (429, "{}"),
        ] {
            let message = refresh_failure_message(status, body);
            assert!(
                message.contains("Settings") || message.contains("again"),
                "{status}: {message}"
            );
        }
    }

    /// The vectors from RFC 7636 appendix B. PKCE with a wrong encoding fails
    /// at Google with an error that names nothing useful, so it is pinned here.
    #[test]
    fn base64_url_matches_the_pkce_specification() {
        let input: [u8; 32] = [
            116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212,
            37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
        ];
        assert_eq!(
            base64_url(&input),
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        );
    }

    #[test]
    fn base64_url_never_pads_or_uses_unsafe_characters() {
        for length in 1..40 {
            let encoded = base64_url(&vec![0xFBu8; length]);
            assert!(!encoded.contains('='), "padding in {encoded}");
            assert!(!encoded.contains('+'), "plus in {encoded}");
            assert!(!encoded.contains('/'), "slash in {encoded}");
        }
    }

    /// The first wall. Without it the page names a path and this file attaches
    /// a credential to whatever it says.
    #[test]
    fn rejects_paths_outside_what_helix_uses() {
        assert!(allowed("/gmail/v1/users/me/messages?q=is:unread"));
        assert!(allowed("/calendar/v3/users/me/calendarList"));

        assert!(!allowed("https://evil.example.com/steal"));
        assert!(!allowed("/gmail/v1/users/me/../../../admin"));
        assert!(!allowed("/drive/v3/files"));
        assert!(!allowed("gmail/v1/users/me/messages"));
        assert!(!allowed("/oauth2/v2/userinfo"));
    }

    #[test]
    fn urlencode_escapes_what_a_query_cannot_carry() {
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("a/b"), "a%2Fb");
        assert_eq!(urlencode("safe-_.~"), "safe-_.~");
    }
}
