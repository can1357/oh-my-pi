/**
 * Security & resilience — types and ports.
 *
 * This subsystem hardens two invariants for anything that is about to be
 * persisted durably:
 *
 *   1. **Redaction before storage.** Secret redaction is irreversible and
 *      happens before any durable write, and before any later distillation
 *      pass can copy the text somewhere else.
 *   2. **Fail open, never leak.** Every transform may fail; on any error the
 *      guard emits the safe original — where "safe original" always means the
 *      *redacted* original, never raw secret-bearing input.
 *
 * The module is decoupled from any concrete redactor by injectable ports. The
 * defaults are a small, self-contained conservative redactor and detector so
 * the guard works standalone, and the adapter factories
 * (`redactionPortFromRedactText`, `detectorFromContainsSecrets`) let callers
 * plug in a richer implementation without a hard import.
 */

import type { SECURITY_GUARD_NAME, SECURITY_GUARD_VERSION } from "./constants";

/**
 * Enforcement posture. Redaction-before-storage is ALWAYS applied regardless of
 * mode — it is a hard invariant, not a tunable. The mode only governs how the
 * guard reacts to the unrecoverable or untrusted cases:
 *
 *   • `observe` (the default): measure and record, never block a write. Even
 *     here the guard only ever persists the redacted payload — raw input is
 *     never stored. When the primary redactor faults, the conservative fallback
 *     output is stored and the outcome is marked `failedOpen`.
 *   • `enforce`: additionally BLOCK the write when the redactor faults, because
 *     a redactor that throws is not trusted to have cleaned the payload, even
 *     if the fallback output looks clean.
 *
 * In BOTH modes the guard NEVER emits `action: "store"` for text in which the
 * detector still finds a secret. A detectably-secret payload is always blocked.
 */
export type SecurityMode = "observe" | "enforce";

/** What the guard decided to do with a single payload. */
export type SecurityAction = "store" | "block";

/** What a single redaction pass produced. */
export interface RedactionResult {
	redacted: string;
	hadSecrets: boolean;
}

/**
 * Redaction port (dependency inversion over the concrete redactor).
 * Implementations MUST be irreversible and SHOULD be pure.
 */
export interface RedactionPort {
	/**
	 * Redact secrets from `text`. May throw — the guard treats a throw as a
	 * fault and applies its conservative fallback rather than propagating.
	 */
	redact(text: string): RedactionResult;
}

/** Secret detector port — defense-in-depth verification after redaction. */
export interface SecretDetectorPort {
	/** True if `text` still appears to contain a secret. May throw. */
	containsSecrets(text: string): boolean;
}

/**
 * Minimal duck-typed durable store. The guard introduces no new source of
 * truth; it only ever hands this an already-redacted record.
 */
export interface DurableStorePort<T> {
	write(record: T): void;
}

/** Telemetry event emitted per guarded payload. */
export interface SecurityEvent {
	name: typeof SECURITY_GUARD_NAME;
	version: typeof SECURITY_GUARD_VERSION;
	mode: SecurityMode;
	action: SecurityAction;
	/** A redaction transform ran before any store decision. */
	redactedApplied: boolean;
	/** The primary redactor reported it removed at least one secret. */
	hadSecrets: boolean;
	/** The detector flagged residual secrets after the primary pass. */
	residualSuspected: boolean;
	/** A fault was caught and contained. */
	failedOpen: boolean;
	/** The fault originated from an injected or faulting dependency. */
	faultInjected: boolean;
	reason: string;
	timestamp: number;
}

/** Pure decision about one payload — no storage side effects. */
export interface SecureOutcome {
	action: SecurityAction;
	/**
	 * The redacted text that is safe to persist. Populated for every outcome
	 * (including blocks, for audit) but only written when `action === "store"`.
	 * Guaranteed never to contain a detector-visible secret when the action is
	 * `"store"`.
	 */
	safeText: string;
	redactedApplied: boolean;
	hadSecrets: boolean;
	residualSuspected: boolean;
	failedOpen: boolean;
	faultInjected: boolean;
	reason: string;
	mode: SecurityMode;
}

/** Result of a guarded store write. */
export interface SecureStoreResult<T> {
	/** True only if the redacted record was handed to the underlying store. */
	stored: boolean;
	/** True if the guard refused to store (unrecoverable secret, or an enforce-mode fault). */
	blocked: boolean;
	/** True if a dependency fault was caught and contained. */
	failedOpen: boolean;
	/** The redacted record actually passed to the store (absent when blocked). */
	storedRecord?: T;
	outcome: SecureOutcome;
	/** Present when the underlying store threw (contained, not propagated). */
	error?: string;
}

/** Options common to the guard and the secure store. */
export interface SecurityOptions {
	mode?: SecurityMode;
	redactionPort?: RedactionPort;
	detector?: SecretDetectorPort;
	/** Best-effort telemetry sink; never allowed to break the guard. */
	telemetrySink?: (event: SecurityEvent) => void;
	/** Injectable clock for deterministic tests. Defaults to `Date.now`. */
	now?: () => number;
}

/** Options for `makeSecureStore` — how to read and replace the record's text. */
export interface SecureStoreOptions<T> extends SecurityOptions {
	/** Extract the redactable text from a record. Defaults to `{content}` or a bare string. */
	getText?: (record: T) => string;
	/** Return a copy of the record with its text replaced by the redacted text. */
	withText?: (record: T, redacted: string) => T;
}

/**
 * A durable store wrapped by `makeSecureStore`. Named so callers never need
 * `ReturnType<typeof makeSecureStore>`.
 */
export interface SecureStore<T> {
	write(record: T): SecureStoreResult<T>;
}

/** Generic fail-open wrapper result. */
export interface ResilientResult<T> {
	ok: boolean;
	value: T;
	failedOpen: boolean;
	error?: string;
}
