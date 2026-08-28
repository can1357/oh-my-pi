/**
 * Security & resilience — stable identifiers and tuning constants.
 *
 * Split out of `types.ts` so that file can stay purely type-level and be
 * consumed with `import type`, which `verbatimModuleSyntax` erases entirely.
 */

/** Stable identity for telemetry and audit trails. */
export const SECURITY_GUARD_NAME = "acf-security-resilience-guard";
export const SECURITY_GUARD_VERSION = "ch12-1";

/** Placeholder emitted when even the conservative fallback redactor throws. */
export const UNSAFE_PLACEHOLDER = "[REDACTED:UNSAFE_CONTENT]";

/**
 * Minimum length of a contiguous high-entropy token run that the conservative
 * fallback redactor treats as a probable secret. Deliberately aggressive —
 * over-redaction is an acceptable price for a last-resort safety net.
 */
export const HIGH_ENTROPY_RUN = 20;
