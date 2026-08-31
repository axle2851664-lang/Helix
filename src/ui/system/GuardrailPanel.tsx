import { GUARDRAILS, tallyEnforcement, type Enforcement } from '../../guardrails/rules.js';

/**
 * The standing rules, on screen.
 *
 * A rule that lives only in a conversation is a rule nobody can check, and one
 * nobody can check is indistinguishable from one that was quietly dropped. So
 * they are rendered from the same data the tests assert against.
 *
 * The column that matters is enforcement. Three states, and the difference
 * between them is the whole point:
 *
 *   enforced   - something refuses the violation, and a test proves it.
 *   by absence - the violation is not expressible in this build. Nothing is
 *                holding the line; there is simply no line to cross yet.
 *   promised   - nothing stops it.
 *
 * "By absence" is the honest one, and it is deliberately not shown in the same
 * colour as enforced. A rule kept by a missing feature is kept only until that
 * feature arrives, which is why each of those says what will weaken it.
 */

const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  code: 'enforced',
  structure: 'by absence',
  promise: 'promised',
};

export function GuardrailPanel() {
  const tally = tallyEnforcement();

  return (
    <section className="helix-panel">
      <h2 className="helix-panel__title">Standing rules</h2>

      <p className="helix-settings__note">
        {tally.code} enforced in code, {tally.structure} kept by absence, {tally.promise}{' '}
        promised. Not summed into a score: a rule held up by a missing feature is kept only
        until that feature arrives, and those are usually the ones that matter most.
      </p>

      <ul className="hx-rules">
        {GUARDRAILS.map((rule) => (
          <li className={`hx-rules__item hx-rules__item--${rule.enforcement}`} key={rule.id}>
            <div className="hx-rules__head">
              <span className="hx-rules__title">{rule.title}</span>
              <span className={`hx-rules__tag hx-rules__tag--${rule.enforcement}`}>
                {ENFORCEMENT_LABEL[rule.enforcement]}
              </span>
            </div>

            <p className="hx-rules__rule">{rule.rule}</p>
            <p className="hx-rules__why">{rule.why}</p>
            <p className="hx-rules__evidence">
              <span className="hx-rules__evidence-label">What holds it</span>
              {rule.evidence}
            </p>

            {rule.atRisk && (
              <p className="hx-rules__risk">
                <span className="hx-rules__evidence-label">What weakens it</span>
                {rule.atRisk}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
