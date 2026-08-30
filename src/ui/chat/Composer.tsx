import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Icon } from '../components/Icon.js';
import { useSettings } from '../HelixProvider.js';

/**
 * The main Helix input.
 *
 * Text submission is fully wired to the orchestrator. Microphone, attachment
 * and image buttons are rendered as the reference shows, but each is disabled
 * with a specific reason until its subsystem exists - they are never wired to a
 * no-op that looks like it worked.
 */

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  busy: boolean;
  autoFocus?: boolean;
}

export function Composer({ value, onChange, onSubmit, busy, autoFocus }: ComposerProps) {
  const settings = useSettings(['speechToTextProvider']);
  const [notice, setNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const voiceLocked = settings.speechToTextProvider === 'none';

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

  const unavailable = (what: string, reason: string) => {
    setNotice(`${what} ${reason}`);
    window.setTimeout(() => setNotice(null), 4000);
  };

  return (
    <div className="hx-composer-wrap">
      {notice && (
        <div className="hx-composer__notice" role="status">
          {notice}
        </div>
      )}

      <form className="hx-composer" onSubmit={submit}>
        <button
          type="button"
          className="hx-iconbtn"
          aria-label={voiceLocked ? 'Voice input unavailable' : 'Voice input'}
          onClick={() =>
            unavailable(
              'Voice input is unavailable:',
              voiceLocked
                ? 'no speech provider is configured. Choose one in Settings under Voice.'
                : 'the voice pipeline is built in phase 5.',
            )
          }
        >
          <Icon name="microphone" size={19} />
        </button>

        <button
          type="button"
          className="hx-iconbtn"
          aria-label="Attach a file"
          onClick={() => unavailable('Attachments are unavailable:', 'file handling is built in phase 4.')}
        >
          <Icon name="paperclip" size={19} />
        </button>

        <button
          type="button"
          className="hx-iconbtn"
          aria-label="Attach an image"
          onClick={() => unavailable('Images are unavailable:', 'vision is built in phase 7.')}
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
