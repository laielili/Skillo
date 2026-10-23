/**
 * Error taxonomy and exit codes.
 *
 * Exit codes are part of the CLI contract — scripts and future GUI code branch
 * on them, so they must not be renumbered casually.
 */

export const EXIT = {
  OK: 0,
  /** Unclassified failure. */
  GENERIC: 1,
  /** Bad arguments or unknown command. */
  USAGE: 2,
  /** A human has to decide (adopt collision, occupied target). */
  CONFLICT: 3,
  /** Environment problem: anchor unreachable, path missing, no permission. */
  ENV: 4,
  /** Batch operation finished with some failures. */
  PARTIAL: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type ErrorCode = 'USAGE' | 'CONFLICT' | 'ENV' | 'GENERIC';

const CODE_TO_EXIT: Record<ErrorCode, ExitCode> = {
  USAGE: EXIT.USAGE,
  CONFLICT: EXIT.CONFLICT,
  ENV: EXIT.ENV,
  GENERIC: EXIT.GENERIC,
};

export interface SkilloErrorOptions {
  /** One actionable line telling the user what to do next. */
  hint?: string;
  /** Extra context printed indented under the message. */
  details?: string;
  cause?: unknown;
}

export class SkilloError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: string | undefined;

  constructor(code: ErrorCode, message: string, options: SkilloErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SkilloError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): ExitCode {
    return CODE_TO_EXIT[this.code];
  }
}

export function usageError(message: string, hint?: string): SkilloError {
  return new SkilloError('USAGE', message, { hint });
}

export function conflictError(message: string, hint?: string, details?: string): SkilloError {
  return new SkilloError('CONFLICT', message, { hint, details });
}

export function envError(message: string, hint?: string, details?: string): SkilloError {
  return new SkilloError('ENV', message, { hint, details });
}

/** Narrow an unknown thrown value into a SkilloError, defaulting to GENERIC. */
export function toSkilloError(err: unknown): SkilloError {
  if (err instanceof SkilloError) return err;
  if (err instanceof Error) {
    return new SkilloError('GENERIC', err.message, { cause: err });
  }
  return new SkilloError('GENERIC', String(err));
}
