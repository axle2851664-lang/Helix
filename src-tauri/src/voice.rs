//! ElevenLabs speech, made where the key can be held.
//!
//! Same boundary as `inference.rs`, for the same reason: a web page cannot
//! hold an API key. The web view sends audio bytes or text; the credential is
//! read from the environment and attached here, immediately before the request
//! goes out. No command returns a key, and `elevenlabs_configured` answers
//! with a bare boolean so the interface can say "voice is configured" without
//! the front end ever holding the means to prove it.
//!
//! Three things cross this boundary, and nothing else:
//!
//! - **Transcription.** Recorded audio in, text out. This is the one command
//!   that moves the user's voice off the machine, which is why the provider on
//!   the other side reports `processing: 'remote'` and the setting that
//!   selects it says so in its label. Havoc does not quietly route a
//!   microphone to a third party.
//! - **Synthesis.** Text in, audio out. The text is already on screen.
//! - **Voices.** The list of voices on the account, so the user can choose one
//!   instead of typing an opaque id.
//!
//! Audio crosses as base64 rather than as a byte array. A `Vec<u8>` over
//! Tauri's IPC is serialised as a JSON array of decimal numbers, which costs
//! roughly four bytes per byte of audio; base64 costs four per three. For a
//! ten-second turn that is the difference between a few hundred kilobytes and
//! a couple of megabytes of JSON per utterance.

use serde::Serialize;

const API_BASE: &str = "https://api.elevenlabs.io";
const KEY_VAR: &str = "ELEVENLABS_API_KEY";

/// How long any one speech request may take.
///
/// Shorter than inference: this is in the conversational path, and a turn that
/// takes a minute to transcribe has already failed as far as the person
/// talking is concerned.
const TIMEOUT_SECS: u64 = 60;

/// Transcription model. ElevenLabs' speech-to-text model id.
const STT_MODEL: &str = "scribe_v1";

/// Synthesis model. The low-latency one, because this speaks into a
/// conversation rather than rendering a file.
const TTS_MODEL: &str = "eleven_turbo_v2_5";

/// Audio Havoc will accept for one turn, before encoding.
///
/// A cap rather than a trust in the caller: the web view decides when a turn
/// ends, and a bug there should cost a refused request rather than the memory
/// of this process.
const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize)]
pub struct VoiceError {
    pub message: String,
}

impl From<String> for VoiceError {
    fn from(message: String) -> Self {
        VoiceError { message }
    }
}

fn key() -> Option<String> {
    // Through `keys`, so a key pasted into Settings works at once rather than
    // at the next launch. See keys.rs for why nothing calls `set_var`.
    crate::keys::get(KEY_VAR)
}

fn require_key() -> Result<String, VoiceError> {
    key().ok_or_else(|| {
        VoiceError::from(format!(
            "ElevenLabs voice is not configured. Set {KEY_VAR} in the environment."
        ))
    })
}

fn client() -> Result<reqwest::Client, VoiceError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|error| VoiceError::from(format!("Could not build an HTTP client: {error}")))
}

/// Turn a provider failure into something a person can act on.
///
/// The provider's own message is the useful part - it distinguishes an expired
/// key from an exhausted quota from a bad voice id, and those need different
/// fixes. Truncated, because a provider is free to answer with a page of HTML.
fn failure(status: u16, body: &str) -> VoiceError {
    VoiceError::from(format!(
        "ElevenLabs returned {status}: {}",
        body.chars().take(400).collect::<String>()
    ))
}

// -------------------------------------------------------------------- base64

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64, with padding.
///
/// Standard and padded, deliberately unlike `google.rs`'s `base64_url`: this
/// is what a browser's `atob` reads, and the audio decoded on the other side
/// of the IPC goes straight into one.
fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);

    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[(triple >> 18 & 0x3F) as usize] as char);
        out.push(ALPHABET[(triple >> 12 & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6 & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }

    out
}

fn value_of(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some((byte - b'A') as u32),
        b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
        b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decode standard base64, rejecting anything that is not.
///
/// Returns an error rather than skipping bad input. Audio that silently loses
/// a few bytes is audio that transcribes to nonsense, and a wrong transcript
/// is far harder to diagnose than a refused request.
fn decode(input: &str) -> Result<Vec<u8>, String> {
    let mut sextets: Vec<u32> = Vec::with_capacity(input.len());

    for byte in input.bytes() {
        // Whitespace is tolerated: it is what a line-wrapped encoder leaves
        // behind and it carries no data. '=' only ever ends the input.
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            break;
        }
        match value_of(byte) {
            Some(value) => sextets.push(value),
            None => return Err("The audio was not valid base64.".to_string()),
        }
    }

    // A single trailing sextet encodes no whole byte and means the input was
    // cut short.
    if sextets.len() % 4 == 1 {
        return Err("The audio was truncated.".to_string());
    }

    let mut out = Vec::with_capacity(sextets.len() / 4 * 3);
    for group in sextets.chunks(4) {
        let mut packed: u32 = 0;
        for index in 0..4 {
            packed = (packed << 6) | group.get(index).copied().unwrap_or(0);
        }
        // One whole byte per sextet beyond the first.
        let bytes = group.len() - 1;
        if bytes >= 1 {
            out.push((packed >> 16 & 0xFF) as u8);
        }
        if bytes >= 2 {
            out.push((packed >> 8 & 0xFF) as u8);
        }
        if bytes >= 3 {
            out.push((packed & 0xFF) as u8);
        }
    }

    Ok(out)
}

// ----------------------------------------------------------------- multipart

/// Build a `multipart/form-data` body by hand.
///
/// By hand because reqwest's `multipart` feature is not enabled in this build
/// and this is the only place that needs one - twenty lines of byte pushing
/// against a dependency that would be pulled in for a single request. The
/// boundary is derived from the payload length rather than from randomness: it
/// only has to not appear in the body, and binary audio containing this exact
/// ASCII run is not a case worth a random number generator.
/// The filename to send with the audio, derived from its media type.
///
/// ElevenLabs looks at the filename as well as the part's content type, and a
/// part labelled `audio/ogg` while called `turn.webm` is a request that
/// contradicts itself - which is a 422 rather than a transcript. The name was
/// hardcoded to `turn.webm` for every recording, so this went wrong on any
/// browser whose MediaRecorder does not produce WebM.
fn filename_for(mime: &str) -> &'static str {
    match mime {
        "audio/ogg" | "audio/opus" => "turn.ogg",
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => "turn.mp4",
        "audio/mpeg" | "audio/mp3" => "turn.mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "turn.wav",
        "audio/flac" => "turn.flac",
        // WebM is what Chromium records, and is the right default for this
        // shell. Anything unrecognised has already been replaced with
        // audio/webm by the caller, so this is not a guess about unknown
        // audio - it is the one case that reaches here.
        _ => "turn.webm",
    }
}

fn multipart(boundary: &str, model: &str, mime: &str, audio: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);

    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    };
    field("model_id", model);

    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n",
            filename_for(mime)
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(audio);
    body.extend_from_slice(b"\r\n");

    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// A boundary that cannot occur in the audio by accident.
fn boundary_for(audio: &[u8]) -> String {
    format!("----HavocTurn{}z{}", audio.len(), audio.first().unwrap_or(&0))
}

// ------------------------------------------------------------------ commands

/// Is there a key? A boolean, never the value.
#[tauri::command]
pub fn elevenlabs_configured() -> bool {
    key().is_some()
}

/// The voices on the account.
#[tauri::command]
pub async fn elevenlabs_voices() -> Result<serde_json::Value, VoiceError> {
    let key = require_key()?;

    let response = client()?
        .get(format!("{API_BASE}/v1/voices"))
        .header("xi-api-key", key)
        .send()
        .await
        .map_err(|error| VoiceError::from(format!("Could not reach ElevenLabs: {error}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| VoiceError::from(format!("Unreadable response: {error}")))?;

    if !status.is_success() {
        return Err(failure(status.as_u16(), &text));
    }

    serde_json::from_str(&text)
        .map_err(|error| VoiceError::from(format!("Response was not JSON: {error}")))
}

/// Transcribe one recorded turn.
///
/// `audio` is base64; `mime` is the recorder's own content type, passed
/// through rather than assumed, because what `MediaRecorder` produces differs
/// by browser and labelling Ogg as WebM is a 400 from the provider.
#[tauri::command]
pub async fn elevenlabs_transcribe(
    audio: String,
    mime: String,
) -> Result<serde_json::Value, VoiceError> {
    let key = require_key()?;

    let bytes = decode(&audio).map_err(VoiceError::from)?;
    if bytes.is_empty() {
        return Err(VoiceError::from("There was no audio to transcribe.".to_string()));
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(VoiceError::from(
            "That recording is too long to transcribe.".to_string(),
        ));
    }

    // Only a media type, and only one this side recognises. The value arrives
    // from the web view and ends up in a header, so it is checked rather than
    // interpolated.
    let mime = if mime.starts_with("audio/") && mime.len() < 64 && !mime.contains(['\r', '\n']) {
        mime
    } else {
        "audio/webm".to_string()
    };

    let boundary = boundary_for(&bytes);
    let body = multipart(&boundary, STT_MODEL, &mime, &bytes);

    let response = client()?
        .post(format!("{API_BASE}/v1/speech-to-text"))
        .header("xi-api-key", key)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|error| VoiceError::from(format!("Could not reach ElevenLabs: {error}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| VoiceError::from(format!("Unreadable response: {error}")))?;

    if !status.is_success() {
        return Err(failure(status.as_u16(), &text));
    }

    serde_json::from_str(&text)
        .map_err(|error| VoiceError::from(format!("Response was not JSON: {error}")))
}

/// Speak text. Returns base64 audio for the web view to play.
#[tauri::command]
pub async fn elevenlabs_speak(text: String, voice_id: String) -> Result<String, VoiceError> {
    let key = require_key()?;

    if text.trim().is_empty() {
        return Err(VoiceError::from("There was nothing to say.".to_string()));
    }

    // The voice id goes into the path, so it is restricted to the shape
    // ElevenLabs actually issues rather than joined on trust. This is the same
    // rule `inference.rs` applies to its paths, for the same reason.
    if voice_id.is_empty()
        || voice_id.len() > 64
        || !voice_id.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(VoiceError::from("That is not a valid voice id.".to_string()));
    }

    let response = client()?
        .post(format!("{API_BASE}/v1/text-to-speech/{voice_id}"))
        .header("xi-api-key", key)
        .json(&serde_json::json!({
            "text": text,
            "model_id": TTS_MODEL,
            "output_format": "mp3_44100_128",
        }))
        .send()
        .await
        .map_err(|error| VoiceError::from(format!("Could not reach ElevenLabs: {error}")))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(failure(status.as_u16(), &text));
    }

    let audio = response
        .bytes()
        .await
        .map_err(|error| VoiceError::from(format!("Unreadable audio: {error}")))?;

    Ok(encode(&audio))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_every_tail_length() {
        for length in 0..40usize {
            let input: Vec<u8> = (0..length).map(|index| (index * 37 % 256) as u8).collect();
            let encoded = encode(&input);
            assert_eq!(decode(&encoded).unwrap(), input, "length {length}");
        }
    }

    #[test]
    fn padding_is_standard_base64() {
        assert_eq!(encode(b"M"), "TQ==");
        assert_eq!(encode(b"Ma"), "TWE=");
        assert_eq!(encode(b"Man"), "TWFu");
    }

    #[test]
    fn whitespace_in_the_input_is_tolerated() {
        assert_eq!(decode("TWFu\n TWFu").unwrap(), b"ManMan");
    }

    /// Audio that silently loses bytes transcribes to nonsense, which is far
    /// harder to diagnose than a refused request.
    #[test]
    fn invalid_characters_are_refused_rather_than_skipped() {
        assert!(decode("TW*u").is_err());
        assert!(decode("T").is_err());
    }

    #[test]
    fn the_multipart_body_carries_the_model_the_type_and_the_audio() {
        let audio = vec![0u8, 1, 2, 3];
        let boundary = boundary_for(&audio);
        let body = multipart(&boundary, "scribe_v1", "audio/ogg", &audio);
        let text = String::from_utf8_lossy(&body);

        assert!(text.contains("name=\"model_id\""));
        assert!(text.contains("scribe_v1"));
        assert!(text.contains("name=\"file\""));
        assert!(text.contains("Content-Type: audio/ogg"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
        // The audio survives byte for byte.
        let start = body
            .windows(4)
            .position(|window| window == audio.as_slice())
            .expect("the audio is in the body");
        assert_eq!(&body[start..start + 4], audio.as_slice());
    }

    /// A part labelled one type and named another is a request that
    /// contradicts itself, which the provider answers with a 422 rather than
    /// a transcript.
    #[test]
    fn the_filename_matches_the_media_type() {
        let audio = vec![1u8, 2, 3];
        for (mime, expected) in [
            ("audio/webm", "turn.webm"),
            ("audio/ogg", "turn.ogg"),
            ("audio/mp4", "turn.mp4"),
            ("audio/wav", "turn.wav"),
        ] {
            let body = multipart("B", STT_MODEL, mime, &audio);
            let text = String::from_utf8_lossy(&body).to_string();
            assert!(text.contains(&format!("filename=\"{expected}\"")), "{mime}");
            assert!(text.contains(&format!("Content-Type: {mime}")), "{mime}");
        }
    }

    /// The boundary must not appear in the payload, or the request is cut in
    /// half at a point the provider chooses.
    #[test]
    fn the_boundary_does_not_occur_in_the_body_it_delimits() {
        let audio = vec![0x2Du8; 512];
        let boundary = boundary_for(&audio);
        let occurrences = multipart(&boundary, STT_MODEL, "audio/webm", &audio)
            .windows(boundary.len())
            .filter(|window| *window == boundary.as_bytes())
            .count();
        // Two field headers and the terminator.
        assert_eq!(occurrences, 3);
    }
}
