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

/// A provider Helix knows how to reach.
struct ProviderSpec {
    id: &'static str,
    base_url: &'static str,
    env_var: &'static str,
    /// How the key is presented. They differ, and guessing wrong is a 401.
    auth: AuthStyle,
}

enum AuthStyle {
    Bearer,
    XApiKey,
}

/// The providers, and where their credentials come from.
const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "cerebras",
        base_url: "https://api.cerebras.ai",
        env_var: "CEREBRAS_API_KEY",
        auth: AuthStyle::Bearer,
    },
    ProviderSpec {
        id: "anthropic",
        base_url: "https://api.anthropic.com",
        env_var: "ANTHROPIC_API_KEY",
        auth: AuthStyle::XApiKey,
    },
];

fn spec(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|provider| provider.id == id)
}

fn key_for(provider: &ProviderSpec) -> Option<String> {
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

    // Only paths Helix constructs are allowed through. Joining an arbitrary
    // caller-supplied path onto a base URL is how a request ends up somewhere
    // nobody intended.
    if !request.path.starts_with("/v1/") || request.path.contains("..") {
        return Err(InferenceError::from(format!(
            "Refused an unexpected inference path: {}",
            request.path
        )));
    }

    let url = format!("{}{}", provider.base_url, request.path);
    let client = reqwest::Client::new();

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
    }

    let mut builder = builder;
    for (name, value) in headers {
        builder = builder.header(name, value);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| InferenceError::from(format!("Could not reach {}: {error}", provider.id)))?;

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
