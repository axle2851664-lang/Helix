/**
 * The shared primitive layer, as both AI identities see it.
 *
 * This file is the package boundary. Anything not exported here is internal to
 * `@hx/core`, which is the point of the boundary existing: an application
 * cannot reach past it into a module's private helpers, so the shared surface
 * is a decision rather than an accident of what happens to be importable.
 */

export { EventBus } from './EventBus.js';
export type { EventMap, EventHandler, EventBusLogger, EventBusOptions, Unsubscribe } from './EventBus.js';

export { Logger, ConsoleSink, MemorySink, redact, REDACTED, LOG_LEVELS } from './Logger.js';
export type { LogLevel, LogRecord, LogSink, LoggerOptions } from './Logger.js';

export { HelixError, toUserMessage } from './HelixError.js';
export type { HelixErrorCode, HelixErrorOptions } from './HelixError.js';

export {
  SENSITIVE_KEY_PATTERNS,
  secretValuePatterns,
  isSensitiveKey,
  findSecrets,
  containsSecret,
  looksLikeLabelledCredential,
} from './secrets.js';
export type { SecretFinding } from './secrets.js';
