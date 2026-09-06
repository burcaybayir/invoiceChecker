/**
 * Failure classes, split by what the caller should do about them.
 */

/** Timeout, 5xx, 429, connection reset. Retried inside the handler with backoff. */
export class RateSourceUnavailableError extends Error {
  override readonly name = 'RateSourceUnavailableError';
  constructor(
    message: string,
    readonly attempts: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * The feed parsed but did not look like what we expect. Deliberately fatal and
 * loud rather than a best-effort parse: a silently mis-parsed rate is a wrong
 * number with a clean audit trail, which is worse than an outage.
 */
export class RateSourceFormatError extends Error {
  override readonly name = 'RateSourceFormatError';
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

/** A non-retryable HTTP status (4xx other than 429). Retrying cannot fix a request that is wrong. */
export class FatalHttpError extends Error {
  override readonly name = 'FatalHttpError';
}
