//! Inference requests, made where the key can be held.
//!
//! This module exists for one reason: a web page cannot hold an API key. Any
//! value the page can read, anything else running in the page can read too,
//! and the build's content policy forbids reaching an outside origin in the
//! first place. So the web view never sees a credential and never makes the
//! request. It sends a provider id, a path and a body; the key is attached
//! here, on this side of the boundary, immediately before the request goes.
//!
//! Keys are read from the environment. Nothing writes them to disk, nothing
//! logs them, and no command returns one - `configured_inference_providers`
//! deliberately answers with ids alone, so the interface can say "Cerebras is
//! configured" without any part of the front end ever holding the means to
//! prove it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// How long any one inference request may take before it is abandoned.
///
/// Longer than the front end's own wait, deliberately: the interface should
/// be the thing that gives up first, because it is the thing that can explain
/// itself to the user.
const INFERENCE_TIMEOUT_SECS: u64 = 240;

/// A provider Helix knows how to reach.
struct ProviderSpec {
    id: &'static str,
    base_url: &'static str,
    env_var: &'static str,
    /// How the key is presented. They differ, and guessing wrong is a 401.
    auth: AuthStyle,
    /// The path prefix this provider's requests must start with.
    ///
    /// Per provider rather than derived from the auth style, because Google's
    /// generative API lives under /v1beta/ while the others are /v1/. Deriving
    /// it meant one provider could only be added by loosening the check for
    /// every provider, which is the wrong direction for a rule whose job is to
    /// stop a request going somewhere nobody intended.
    path_prefix: &'static str,
}

enum AuthStyle {
    Bearer,
    XApiKey,
    /// Google's generative API: the key rides in its own header.
    GoogleApiKey,
    /// A service on this machine. No credential exists and none is wanted.
    None,
}

/// The providers, and where their credentials come from.
const PROVIDERS: &[ProviderSpec] = &[
    // Local first. This is the one that is meant to answer ordinary
    // conversation, and it reaches nothing beyond this machine.
    ProviderSpec {
        id: "ollama",
        base_url: "http://127.0.0.1:11434",
        env_var: "",
        auth: AuthStyle::None,
        path_prefix: "/api/",
    },
    ProviderSpec {
        id: "cerebras",
        base_url: "https://api.cerebras.ai",
        env_var: "CEREBRAS_API_KEY",
        auth: AuthStyle::Bearer,
        path_prefix: "/v1/",
    },
    ProviderSpec {
        id: "gemini",
        base_url: "https://generativelanguage.googleapis.com",
        env_var: "GEMINI_API_KEY",
        auth: AuthStyle::GoogleApiKey,
        path_prefix: "/v1beta/",
    },
    ProviderSpec {
        id: "anthropic",
        base_url: "https://api.anthropic.com",
        env_var: "ANTHROPIC_API_KEY",
        auth: AuthStyle::XApiKey,
        path_prefix: "/v1/",
    },
];

fn spec(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|provider| provider.id == id)
}

fn key_for(provider: &ProviderSpec) -> Option<String> {
    if matches!(provider.auth, AuthStyle::None) {
        // Not a secret, and not absent either: there is simply nothing to
        // present. Returning a placeholder keeps the "is this usable" check
        // in one place rather than special-casing it at every call site.
        return Some(String::new());
    }
    std::env::var(provider.env_var).ok().filter(|value| !value.trim().is_empty())
}

/// Which providers have a key.
///
/// Ids only. The values never cross into the web view, not even in a form that
/// could be counted or compared - the front end has no business holding them
/// and this command gives it no way to.
#[tauri::command]
pub fn configured_inference_providers() -> Vec<String> {
    PROVIDERS
        .iter()
        .filter(|provider| key_for(provider).is_some())
        .map(|provider| provider.id.to_string())
        .collect()
}

#[derive(Deserialize)]
pub struct InferenceRequest {
    pub provider: String,
    pub path: String,
    /// Null for a GET, such as listing models.
    pub body: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub struct InferenceError {
    pub message: String,
}

impl From<String> for InferenceError {
    fn from(message: String) -> Self {
        InferenceError { message }
    }
}

/// Make the request, attaching the key here.
///
/// Errors are returned as plain messages rather than as opaque failures,
/// because the front end shows them to the user and "something went wrong" is
/// not a thing anyone can act on. The key is never included in one: an error
/// message is exactly the sort of place a credential leaks into a log.
#[tauri::command]
pub async fn inference_request(
    request: InferenceRequest,
) -> Result<serde_json::Value, InferenceError> {
    let provider = spec(&request.provider)
        .ok_or_else(|| InferenceError::from(format!("Unknown provider: {}", request.provider)))?;

    let key = key_for(provider).ok_or_else(|| {
        InferenceError::from(format!(
            "{} inference is not configured. Set {} in the environment.",
            provider.id, provider.env_var
        ))
    })?;

    // A local runtime that is not running is the commonest failure here, and
    // "connection refused" is not a sentence anyone can act on.
    let local = matches!(provider.auth, AuthStyle::None);

    // Only paths Helix constructs are allowed through. Joining an arbitrary
    // caller-supplied path onto a base URL is how a request ends up somewhere
    // nobody intended.
    let allowed_prefix = provider.path_prefix;
    if !request.path.starts_with(allowed_prefix) || request.path.contains("..") {
        return Err(InferenceError::from(format!(
            "Refused an unexpected inference path: {}",
            request.path
        )));
    }

    let url = format!("{}{}", provider.base_url, request.path);
    // A request with no timeout waits for ever, and the interface waiting on
    // it shows "Standing by" with nothing to read and nothing to do - which
    // is indistinguishable from a crash, and worse, because the user keeps
    // waiting. `web.rs` has had a timeout since it was written; this was
    // missed.
    //
    // Generous, because a local model legitimately takes minutes to load
    // several gigabytes of weights off disk on the first request after it is
    // chosen. The front end gives up a little sooner and says why; this is
    // the wall behind that, so an abandoned request cannot be left running
    // against the runtime for ever.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(INFERENCE_TIMEOUT_SECS))
        .build()
        .map_err(|error| InferenceError::from(format!("Could not build an HTTP client: {error}")))?;

    let builder = match request.body {
        Some(ref body) => client.post(&url).json(body),
        None => client.get(&url),
    };

    let mut headers = HashMap::new();
    match provider.auth {
        AuthStyle::Bearer => {
            headers.insert("authorization", format!("Bearer {key}"));
        }
        AuthStyle::XApiKey => {
            headers.insert("x-api-key", key.clone());
            headers.insert("anthropic-version", "2023-06-01".to_string());
        }
        AuthStyle::GoogleApiKey => {
            // In the header rather than as ?key=, so the credential never
            // appears in a URL that might be logged or reported back.
            headers.insert("x-goog-api-key", key.clone());
        }
        // Nothing to attach. A local service on the loopback interface is not
        // authenticated and should not be handed a credential it never asked
        // for.
        AuthStyle::None => {}
    }

    let mut builder = builder;
    for (name, value) in headers {
        builder = builder.header(name, value);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| {
            InferenceError::from(if local {
                "The local AI service is not running. Start it and try again.".to_string()
            } else {
                format!("Could not reach {}: {error}", provider.id)
            })
        })?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| InferenceError::from(format!("Unreadable response: {error}")))?;

    if !status.is_success() {
        // The provider's own message is the useful part; it says whether this
        // was a bad model id, an expired key or a rate limit, and those need
        // different fixes.
        return Err(InferenceError::from(format!(
            "{} returned {}: {}",
            provider.id,
            status.as_u16(),
            text.chars().take(400).collect::<String>()
        )));
    }

    serde_json::from_str(&text)
        .map_err(|error| InferenceError::from(format!("Response was not JSON: {error}")))
}

// ------------------------------------------------------------------ streaming

/// One piece of a streamed reply, as it arrives.
///
/// Tagged rather than a bare string, because "a token arrived", "the reply
/// finished" and "it failed part-way" are three different things and the
/// front end has to tell them apart. A stream that ends without saying which
/// it was leaves the interface guessing whether the answer is complete.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StreamEvent {
    /// Text to append. Never the whole reply so far - only what is new.
    Chunk { text: String },
    /// The reply is complete. Carries the model, which can differ from the
    /// one asked for if the runtime substituted.
    Done { model: String },
    /// It stopped early. The message is safe to show.
    Failed { message: String },
}


/// Take every complete line out of the buffer and turn it into events.
///
/// Pure, and separated from the socket on purpose: this is the part with the
/// bug in it if there is one. A chunk boundary can land in the middle of a
/// JSON line, so a reader that assumes whole lines drops tokens silently -
/// which looks like a stupid model rather than a broken parser. An incomplete
/// trailing line is left in the buffer for the next chunk to finish.
fn drain_events(buffer: &mut String, model: &mut String) -> Vec<StreamEvent> {
    let mut events = Vec::new();

    while let Some(newline) = buffer.find('\n') {
        let line: String = buffer.drain(..=newline).collect();
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            // A line that will not parse is skipped rather than fatal: the
            // rest of the stream is usually fine, and ending a reply over one
            // malformed line loses an answer that was arriving.
            Err(_) => continue,
        };

        if let Some(name) = parsed.get("model").and_then(serde_json::Value::as_str) {
            *model = name.to_string();
        }

        if let Some(text) = parsed
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(serde_json::Value::as_str)
        {
            if !text.is_empty() {
                events.push(StreamEvent::Chunk {
                    text: text.to_string(),
                });
            }
        }

        if parsed.get("done").and_then(serde_json::Value::as_bool) == Some(true) {
            events.push(StreamEvent::Done {
                model: model.clone(),
            });
            return events;
        }
    }

    events
}

/// Stream a chat completion, a token at a time.
///
/// The non-streaming command waits for the whole reply before anything can be
/// shown, which on a CPU means tens of seconds of nothing. This exists so the
/// first words appear in about a second - the reply takes exactly as long
/// either way, but only one of them feels like the machine is working.
///
/// Local providers only, and that is not an arbitrary restriction. Streaming
/// keeps a connection open for the length of a generation, and the loopback
/// interface is the one place where that carries no credential and reaches
/// nothing outside this machine.
///
/// Errors go down the channel rather than being returned, because a stream
/// can fail after it has begun - by which point the command has already
/// resolved and there is nothing left to return an error to.
#[tauri::command]
pub async fn inference_stream(
    request: InferenceRequest,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), InferenceError> {
    let provider = spec(&request.provider)
        .ok_or_else(|| InferenceError::from(format!("Unknown provider: {}", request.provider)))?;

    if !matches!(provider.auth, AuthStyle::None) {
        return Err(InferenceError::from(
            "Streaming is only available from a local runtime on this machine.".to_string(),
        ));
    }

    if !request.path.starts_with(provider.path_prefix) || request.path.contains("..") {
        return Err(InferenceError::from(format!(
            "Refused an unexpected inference path: {}",
            request.path
        )));
    }

    let url = format!("{}{}", provider.base_url, request.path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(INFERENCE_TIMEOUT_SECS))
        .build()
        .map_err(|error| InferenceError::from(format!("Could not build an HTTP client: {error}")))?;

    let body = request.body.unwrap_or(serde_json::Value::Null);
    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|error| InferenceError::from(format!("Could not reach the local AI service: {error}")))?;

    if !response.status().is_success() {
        return Err(InferenceError::from(format!(
            "The local AI service answered {}.",
            response.status()
        )));
    }

    // Ollama streams newline-delimited JSON, and a chunk boundary can land in
    // the middle of a line - so lines are assembled from the buffer rather
    // than assumed to arrive whole. Parsing a half-line would drop tokens
    // silently, which is the kind of bug that looks like a bad model.
    let mut stream = response;
    let mut buffer = String::new();
    let mut model = String::new();

    loop {
        let chunk = match stream.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                let _ = on_event.send(StreamEvent::Failed {
                    message: format!("The reply stopped early: {error}"),
                });
                return Ok(());
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        for event in drain_events(&mut buffer, &mut model) {
            let finished = matches!(event, StreamEvent::Done { .. });
            let _ = on_event.send(event);
            if finished {
                return Ok(());
            }
        }
    }

    // The connection closed without a done flag. The text that arrived is
    // real and already shown, so this completes rather than failing - but it
    // says the model it saw, never a guess.
    let _ = on_event.send(StreamEvent::Done { model });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(events: &[StreamEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::Chunk { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn done(events: &[StreamEvent]) -> Option<String> {
        events.iter().find_map(|event| match event {
            StreamEvent::Done { model } => Some(model.clone()),
            _ => None,
        })
    }

    const LINE_A: &str = r#"{"model":"qwen2.5:3b","message":{"content":"Good "},"done":false}"#;
    const LINE_B: &str = r#"{"model":"qwen2.5:3b","message":{"content":"evening."},"done":false}"#;
    const LAST: &str = r#"{"model":"qwen2.5:3b","message":{"content":""},"done":true}"#;

    #[test]
    fn whole_lines_become_chunks_in_order() {
        let mut buffer = format!("{LINE_A}\n{LINE_B}\n");
        let mut model = String::new();

        let events = drain_events(&mut buffer, &mut model);
        assert_eq!(texts(&events), vec!["Good ", "evening."]);
        assert_eq!(model, "qwen2.5:3b");
    }

    /// The bug this function exists to prevent. A chunk boundary can fall
    /// anywhere, and a reader that assumes whole lines loses tokens silently.
    #[test]
    fn a_line_split_across_chunks_is_not_lost() {
        let mut buffer = String::new();
        let mut model = String::new();
        let whole = format!("{LINE_A}\n{LINE_B}\n");

        // Feed it one byte at a time, the worst case.
        let mut seen = Vec::new();
        for character in whole.chars() {
            buffer.push(character);
            seen.extend(drain_events(&mut buffer, &mut model));
        }

        assert_eq!(texts(&seen), vec!["Good ", "evening."]);
        assert!(buffer.is_empty(), "nothing should be left over");
    }

    #[test]
    fn an_incomplete_trailing_line_waits_for_the_rest() {
        let mut buffer = format!("{LINE_A}\n{{\"message\":{{\"content\":\"half");
        let mut model = String::new();

        let events = drain_events(&mut buffer, &mut model);
        assert_eq!(texts(&events), vec!["Good "]);
        assert!(buffer.starts_with('{'), "the half line is kept: {buffer}");
    }

    #[test]
    fn the_done_flag_ends_the_stream_and_names_the_model() {
        let mut buffer = format!("{LINE_A}\n{LAST}\n{LINE_B}\n");
        let mut model = String::new();

        let events = drain_events(&mut buffer, &mut model);
        assert_eq!(done(&events).as_deref(), Some("qwen2.5:3b"));
        // Nothing after done is emitted.
        assert_eq!(texts(&events), vec!["Good "]);
    }

    /// One bad line must not end an answer that is arriving.
    #[test]
    fn a_malformed_line_is_skipped_rather_than_fatal() {
        let mut buffer = format!("not json at all\n{LINE_A}\n");
        let mut model = String::new();

        assert_eq!(texts(&drain_events(&mut buffer, &mut model)), vec!["Good "]);
    }

    #[test]
    fn empty_content_produces_no_chunk() {
        let mut buffer = String::from("{\"message\":{\"content\":\"\"},\"done\":false}\n");
        let mut model = String::new();

        assert!(texts(&drain_events(&mut buffer, &mut model)).is_empty());
    }

    #[test]
    fn blank_lines_are_ignored() {
        let mut buffer = format!("\n\n{LINE_A}\n\n");
        let mut model = String::new();

        assert_eq!(texts(&drain_events(&mut buffer, &mut model)), vec!["Good "]);
    }
}
