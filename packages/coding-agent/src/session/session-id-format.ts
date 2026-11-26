/**
 * A session id in the canonical form omp mints: a lowercase UUID, 8-4-4-4-12 hex digits.
 * Test a value given by a person after lowercasing it. Imports nothing, so the CLI flag
 * table (which must stay free of runtime imports) can use it.
 */
export const CANONICAL_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
