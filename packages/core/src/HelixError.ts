/**
 * Helix error type (spec 17).
 *
 * Errors carry two separate messages on purpose:
 *
 * - `userMessage` is what a person sees. It must be plain, actionable, and free
 *   of hostnames, ports, stack frames and error codes.
 * - `technical` is what goes to the log. It may contain anything useful for
 *   debugging except secrets.
 *
 * The specification's own example is the contract:
 *   not  "ECONNREFUSED 127.0.0.1:11434"
 *   but  "Helix couldn't connect to the configured vision provider.
 *         Check Vision Settings."
 */

export type HelixErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_UNREACHABLE'
  | 'CAPABILITY_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_LIMIT'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INTERNAL';

export interface HelixErrorOptions {
  /** Where the user should go to fix it, e.g. 'settings:vision'. */
  remedy?: string;
  technical?: string;
  cause?: unknown;
}

export class HelixError extends Error {
  readonly code: HelixErrorCode;
  readonly userMessage: string;
  readonly technical: string | undefined;
  readonly remedy: string | undefined;

  constructor(code: HelixErrorCode, userMessage: string, options: HelixErrorOptions = {}) {
    // `message` mirrors userMessage so an accidental `${err}` is still safe to show.
    super(userMessage);
    this.name = 'HelixError';
    this.code = code;
    this.userMessage = userMessage;
    this.technical = options.technical;
    this.remedy = options.remedy;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /**
   * Wrap an unknown thrown value without leaking its raw text to the user.
   * The original message is preserved for the log only.
   */
  static from(error: unknown, userMessage: string, code: HelixErrorCode = 'INTERNAL'): HelixError {
    if (error instanceof HelixError) return error;
    const technical = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new HelixError(code, userMessage, { technical, cause: error });
  }
}

/** Narrow an unknown catch binding to something safe to display. */
export function toUserMessage(error: unknown): string {
  if (error instanceof HelixError) return error.userMessage;
  return 'Helix hit an unexpected problem. Details are in the log.';
}
