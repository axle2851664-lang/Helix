/**
 * Structured logging with redaction (spec 18, 22).
 *
 * The redaction pass is the point of this module. Helix handles API keys, tokens
 * and file paths, and the specification forbids any of them reaching a log.
 * Redaction happens on the way *in*, so a secret is never written to a sink at
 * all rather than being filtered when the log is read.
 *
 * Never logged, by construction:
 *   passwords, API keys, tokens, private key material,
 *   camera frames, microphone audio, private file contents.
 */

export const LOG_LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

export interface LogRecord {
  timestamp: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail?: unknown;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export const REDACTED = '[redacted]';

/**
 * Keys whose values are replaced wholesale. Matched case-insensitively as a
 * substring, so `openaiApiKey`, `API_KEY` and `refresh_token` all match.
 */
const SENSITIVE_KEY_PATTERNS = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key',
  'accesskey', 'access_key', 'authorization', 'auth', 'credential',
  'privatekey', 'private_key', 'sessionid', 'session_id', 'cookie',
];

/** Value-shaped secrets that can appear even under an innocuous key. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,           // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,       // Anthropic-style keys
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,      // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // bearer headers
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // JWTs
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((p) => normalized.includes(p.replace(/[^a-z_]/g, '')));
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redact a value for logging. Cycles are handled, depth is capped, and
 * anything unrecognised degrades to a type marker rather than being stringified
 * blindly (a Blob of camera pixels must never become log text).
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
      return '[function]';
    case 'symbol':
      return '[symbol]';
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  // Binary and media payloads are never expanded into log text.
  if (typeof Blob !== 'undefined' && value instanceof Blob) return '[blob]';
  if (value instanceof ArrayBuffer) return '[arraybuffer]';
  if (ArrayBuffer.isView(value)) return '[binary]';
  if (typeof MediaStream !== 'undefined' && value instanceof MediaStream) return '[mediastream]';

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return output;
}

export interface LoggerOptions {
  level?: LogLevel;
  sinks?: LogSink[];
}

export class Logger {
  #level: LogLevel;
  readonly #sinks: LogSink[];
  readonly #scope: string;

  constructor(scope = 'helix', options: LoggerOptions = {}) {
    this.#scope = scope;
    this.#level = options.level ?? 'INFO';
    this.#sinks = options.sinks ?? [];
  }

  /** A logger sharing this one's level and sinks, tagged with a new scope. */
  child(scope: string): Logger {
    const child = new Logger(`${this.#scope}:${scope}`, { level: this.#level, sinks: this.#sinks });
    return child;
  }

  setLevel(level: LogLevel): void {
    this.#level = level;
  }

  get level(): LogLevel {
    return this.#level;
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.#level];
  }

  error(message: string, detail?: unknown): void { this.#log('ERROR', message, detail); }
  warn(message: string, detail?: unknown): void { this.#log('WARN', message, detail); }
  info(message: string, detail?: unknown): void { this.#log('INFO', message, detail); }
  debug(message: string, detail?: unknown): void { this.#log('DEBUG', message, detail); }

  #log(level: LogLevel, message: string, detail?: unknown): void {
    if (!this.isEnabled(level)) return;

    const record: LogRecord = {
      timestamp: Date.now(),
      level,
      scope: this.#scope,
      message: redactString(message),
    };
    if (detail !== undefined) record.detail = redact(detail);

    for (const sink of this.#sinks) {
      try {
        sink.write(record);
      } catch {
        // A failing sink must never break the caller. Deliberately silent:
        // logging the failure through the same sink would recurse.
      }
    }
  }
}

/** Console sink for development. */
export class ConsoleSink implements LogSink {
  write(record: LogRecord): void {
    const time = new Date(record.timestamp).toISOString().slice(11, 23);
    const line = `${time} ${record.level.padEnd(5)} [${record.scope}] ${record.message}`;
    const method = record.level === 'ERROR' ? 'error' : record.level === 'WARN' ? 'warn' : 'log';
    if (record.detail === undefined) console[method](line);
    else console[method](line, record.detail);
  }
}

/** Bounded in-memory sink backing the UI log view; oldest records drop first. */
export class MemorySink implements LogSink {
  readonly #records: LogRecord[] = [];
  readonly #capacity: number;

  constructor(capacity = 500) {
    this.#capacity = capacity;
  }

  write(record: LogRecord): void {
    this.#records.push(record);
    if (this.#records.length > this.#capacity) {
      this.#records.splice(0, this.#records.length - this.#capacity);
    }
  }

  get records(): readonly LogRecord[] {
    return this.#records;
  }

  clear(): void {
    this.#records.length = 0;
  }
}
