/**
 * Secret detection, shared by every subsystem that must not retain credentials
 * (spec 8, 18, 24).
 *
 * Two consumers depend on this list, for different reasons:
 *
 * - `Logger` redacts matches on the way into a sink, so a secret never reaches
 *   a log at all.
 * - `MemoryManager` refuses to store a match, so a credential pasted into a
 *   "remember this" request is rejected rather than persisted.
 *
 * They must agree, which is why the patterns live here rather than being
 * duplicated. Adding a pattern hardens both at once.
 *
 * This is deliberately conservative: it errs towards flagging. A false positive
 * costs the user one rephrase; a false negative writes a live credential to
 * disk.
 */

/**
 * Field names whose value is sensitive regardless of its shape. Matched as a
 * substring after stripping non-letters, so `openaiApiKey`, `API_KEY` and
 * `refresh-token` all match.
 */
export const SENSITIVE_KEY_PATTERNS = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key',
  'accesskey', 'access_key', 'authorization', 'auth', 'credential',
  'privatekey', 'private_key', 'sessionid', 'session_id', 'cookie',
] as const;

/**
 * Value shapes that are secrets wherever they appear, even under an innocuous
 * field name or in free text.
 *
 * Declared as factory functions rather than shared RegExp objects: these carry
 * the `g` flag, and a global regex keeps mutable `lastIndex` state between
 * calls. Sharing one instance across `test()` and `replace()` produces
 * intermittent misses - exactly the failure mode that must never happen here.
 */
const VALUE_PATTERN_SOURCES: ReadonlyArray<{ label: string; source: string; flags: string }> = [
  // Excludes sk-ant- so an Anthropic key is not also reported as an OpenAI one.
  // Both still redact; this only keeps the reason accurate.
  { label: 'OpenAI-style key', source: String.raw`\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b`, flags: 'g' },
  { label: 'Anthropic key', source: String.raw`\bsk-ant-[A-Za-z0-9_-]{16,}\b`, flags: 'g' },
  { label: 'GitHub token', source: String.raw`\bgh[pousr]_[A-Za-z0-9]{16,}\b`, flags: 'g' },
  { label: 'AWS access key id', source: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, flags: 'g' },
  // {30,} rather than the exact {35} of a real key: an exact length means a
  // near-miss passes the check, and under-flagging is the failure that matters.
  { label: 'Google API key', source: String.raw`\bAIza[A-Za-z0-9_-]{30,}`, flags: 'g' },
  { label: 'Slack token', source: String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}\b`, flags: 'g' },
  { label: 'bearer header', source: String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*`, flags: 'gi' },
  {
    label: 'JSON web token',
    source: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+`,
    flags: 'g',
  },
  {
    label: 'private key block',
    source: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
    flags: 'g',
  },
];

/** Fresh regex instances, so `lastIndex` is never carried between calls. */
export function secretValuePatterns(): RegExp[] {
  return VALUE_PATTERN_SOURCES.map(({ source, flags }) => new RegExp(source, flags));
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) =>
    normalized.includes(pattern.replace(/[^a-z_]/g, '')),
  );
}

export interface SecretFinding {
  /** What kind of secret was recognised, for telling the user what to remove. */
  label: string;
}

/**
 * Inspect free text for credential-shaped content.
 * Returns every distinct kind found, or an empty array when the text is clean.
 */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { label, source, flags } of VALUE_PATTERN_SOURCES) {
    if (new RegExp(source, flags.replace('g', '')).test(text)) {
      findings.push({ label });
    }
  }
  return findings;
}

/**
 * True when the text contains something credential-shaped.
 * Callers that persist user content must check this first.
 */
export function containsSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}

/**
 * Also catches "my password is hunter2" - a labelled credential in prose that
 * no value pattern would match. Used only where the cost of a false positive is
 * a rephrase, never for redacting machine output.
 */
export function looksLikeLabelledCredential(text: string): boolean {
  return /\b(?:my |the )?(?:password|passphrase|api[ _-]?key|secret|access[ _-]?token|private[ _-]?key)\b\s*(?:is|=|:)\s*\S+/i.test(
    text,
  );
}
