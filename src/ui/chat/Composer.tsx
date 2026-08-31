import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import type { VoiceSnapshot } from '../../voice/VoiceManager.js';

/**
 * The main Helix input.
 *
 * The microphone is wired to the real voice pipeline: pressing it opens the
 * device, and the indicator follows actual device state rather than an
 * optimistic flag. Attachment and image buttons remain unbuilt and say so
 * specifically rather than being no-ops that look like they worked.
 */

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  busy: boolean;
  autoFocus?: boolean;
}

export function Composer({ value, onChange, onSubmit, busy, autoFocus }: ComposerProps) {
  const { voice } = useHelix();
  const [notice, setNotice] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceSnapshot>(() => voice.snapshot);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => voice.subscribe(setVoiceState), [voice]);

  const listening = voiceState.state === 'listening';
  const voiceBlocker = voice.inputBlocker();

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (text === '' || busy) return;
    onSubmit(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter breaks the line.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const say = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 5000);
  };

  const toggleListening = async () => {
    if (listening) {
      voice.stopListening();
      return;
    }

    const blocker = voice.inputBlocker();
    if (blocker !== null) {
      say(blocker);
      return;
    }

    try {
      const transcript = await voice.listen();
      if (transcript.trim() === '') {
        say("I'm afraid I didn't catch that, sir.");
        return;
      }
      // Fills the composer rather than sending, so the user can correct a
      // misheard word before Helix acts on it.
      onChange(transcript);
      textareaRef.current?.focus();
    } catch (error) {
      say(toUserMessage(error));
    }
  };

  return (
    <div className="hx-composer-wrap">
      {notice && (
        <div className="hx-composer__notice" role="status">
          {notice}
        </div>
      )}

      {listening && (
        <div className="hx-listening" role="status">
          {/* Bars are driven by the real measured level, so a dead
              microphone is visibly dead rather than silently so. */}
          <span className="hx-bars" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((bar) => (
              <span
                key={bar}
                className="hx-bars__bar"
                style={{
                  transform: `scaleY(${Math.max(
                    0.12,
                    Math.min(1, voiceState.level * (6 + bar * 2)),
                  )})`,
                }}
              />
            ))}
          </span>
          <span>Listening&hellip;</span>
          {voiceState.transcript && (
            <span className="hx-listening__text">{voiceState.transcript}</span>
          )}
          <button type="button" className="hx-btn hx-btn--quiet" onClick={() => voice.stopListening()}>
            Stop
          </button>
        </div>
      )}

      <form className="hx-composer" onSubmit={submit}>
        <button
          type="button"
          className={`hx-iconbtn${listening ? ' hx-iconbtn--live' : ''}`}
          aria-label={listening ? 'Stop listening' : 'Speak to Helix'}
          aria-pressed={listening}
          title={voiceBlocker ?? 'Speak to Helix'}
          onClick={() => void toggleListening()}
        >
          <Icon name="microphone" size={19} />
        </button>

        <button
          type="button"
          className="hx-iconbtn"
          aria-label="Attach a file"
          onClick={() =>
            say("I'm afraid attachments aren't available here yet, sir. You may import files from Upload Project.")
          }
        >
          <Icon name="paperclip" size={19} />
        </button>

        <button
          type="button"
          className="hx-iconbtn"
          aria-label="Attach an image"
          onClick={() =>
            say("I'm afraid image understanding isn't configured yet, sir. It arrives with vision in phase 7.")
          }
        >
          <Icon name="image" size={19} />
        </button>

        <textarea
          ref={textareaRef}
          className="hx-composer__input"
          placeholder="Ask Helix anything..."
          value={value}
          rows={1}
          autoFocus={autoFocus ?? false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Ask Helix anything"
        />

        <button
          type="submit"
          className="hx-sendbtn"
          disabled={value.trim() === '' || busy}
          aria-label="Send"
        >
          <Icon name="send" size={18} />
        </button>
      </form>
    </div>
  );
}
