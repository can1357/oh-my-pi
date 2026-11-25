/** Attempts a request makes before giving up. */
export const MAX_RETRIES = 3;

/** Delay before the first retry; doubles on each later attempt. */
export const BASE_DELAY_MS = 250;
