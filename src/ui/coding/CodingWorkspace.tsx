import { useCallback, useMemo, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import { CodeWriter, type CodeResult } from '../../coding/CodeWriter.js';

/**
 * Writing code, on this machine and nowhere else.
 *
 * The local-only rule lives in `CodeWriter`, not here, so it holds for
 * anything else that ever calls it. What this screen adds is saying so: which
 * model answered, that it ran locally, and - when it cannot - why, before you
 * have typed anything rather than after.
 *
 * Nothing is run. Generated code is shown and copied, never executed: an
 * assistant that runs what a model just wrote is one bad completion away from
 * doing something irreversible on your machine.
 */

const LANGUAGES = [
  '',
  'python',
  'typescript',
  'javascript',
  'rust',
  'go',
  'c',
  'c++',
  'c#',
  'java',
  'bash',
  'powershell',
  'sql',
  'html',
  'css',
];

export function CodingWorkspace() {
  const { ai, logger } = useHelix();
  const writer = useMemo(() => new CodeWriter({ router: ai, logger }), [ai, logger]);

  const [instruction, setInstruction] = useState('');
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CodeResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const availability = writer.available();

  const write = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    setCopied(false);
    try {
      setResult(
        await writer.write({
          instruction,
          ...(language !== '' ? { language } : {}),
        }),
      );
    } catch (error) {
      setResult(null);
      setProblem(toUserMessage(error));
    } finally {
      setBusy(false);
    }
  }, [writer, instruction, language]);

  const copy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.code);
      setCopied(true);
    } catch {
      // Clipboard access can be refused. The code is on screen and selectable
      // either way, so this is not worth an error message.
      setCopied(false);
    }
  }, [result]);

  return (
    <div className="hx-page">
      {!availability.available && (
        <div className="hx-notice hx-notice--warn" role="alert">
          {availability.reason}
        </div>
      )}

      <section className="hx-panel">
        <label className="hx-field" htmlFor="hx-code-instruction">
          <span className="hx-field__label">What should it do?</span>
          <textarea
            id="hx-code-instruction"
            className="hx-input hx-code__prompt"
            rows={4}
            value={instruction}
            placeholder="read a csv and print the rows where the amount is over 100"
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>

        <div className="hx-field__actions">
          <select
            className="hx-select hx-select--inline"
            value={language}
            aria-label="Language"
            onChange={(event) => setLanguage(event.target.value)}
          >
            {LANGUAGES.map((entry) => (
              <option key={entry || 'auto'} value={entry}>
                {entry === '' ? 'Let it choose' : entry}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="hx-btn"
            disabled={busy || instruction.trim() === '' || !availability.available}
            onClick={() => void write()}
          >
            <Icon name="activity" size={15} />
            {busy ? 'Writing…' : 'Write it'}
          </button>
        </div>

        {problem && (
          <p className="hx-code__problem" role="alert">
            {problem}
          </p>
        )}
      </section>

      {result && (
        <section className="hx-panel">
          <div className="hx-code__head">
            <span className="hx-code__lang">{result.language || 'code'}</span>
            <span className="hx-code__where">
              <span className="hx-dot hx-dot--ok" />
              {result.modelId} on this machine
            </span>
            <button type="button" className="hx-btn hx-btn--quiet" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <pre className="hx-code__block">
            <code>{result.code}</code>
          </pre>

          {result.notes !== '' && <p className="hx-code__notes">{result.notes}</p>}

          <p className="hx-settings__note">
            Nothing here has been run. Read it before you do &mdash; it was written by a model, and
            Helix does not execute what a model writes.
          </p>
        </section>
      )}
    </div>
  );
}
