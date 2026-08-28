/**
 * Security & resilience — engine.
 *
 * Two guarantees:
 *
 *   1. **Redaction before storage.** `guardText()` runs an irreversible
 *      redaction pass and a defense-in-depth detector BEFORE any store
 *      decision, and `makeSecureStore()` only ever hands the underlying store
 *      the redacted record. Raw, secret-bearing input can never reach durable
 *      storage.
 *
 *   2. **Fail open under fault injection.** Every dependency call — redactor,
 *      detector, telemetry sink, and the store's own `write` — is wrapped so a
 *      thrown fault is caught and contained: the guard degrades to a
 *      conservative fallback instead of crashing the pipeline, and, critically,
 *      a fault never causes raw input to be stored. When the primary redactor
 *      cannot be trusted, the guard escalates to a conservative panic redactor
 *      and, if it still cannot prove the payload clean, blocks the write.
 *
 * Everything is pure and deterministic (the clock is injectable), decoupled via
 * ports, and inert until a caller explicitly wraps a store.
 */

import { HIGH_ENTROPY_RUN, SECURITY_GUARD_NAME, SECURITY_GUARD_VERSION, UNSAFE_PLACEHOLDER } from "./constants";
import type {
	DurableStorePort,
	RedactionPort,
	RedactionResult,
	ResilientResult,
	SecretDetectorPort,
	SecureOutcome,
	SecureStore,
	SecureStoreOptions,
	SecureStoreResult,
	SecurityEvent,
	SecurityMode,
	SecurityOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Built-in conservative redactor + detector (self-contained defaults).
//
// These deliberately cover only the highest-signal secret shapes, so the module
// has zero coupling to any concrete redactor. Callers who want richer coverage
// plug their own implementation in via `redactionPortFromRedactText`.
//
// Each pattern is hoisted to its own constant so that the `BUILTIN_PATTERNS`
// rows stay short, which keeps their formatting unambiguous.
// ---------------------------------------------------------------------------

/** Shared between the BEGIN and END markers of a PEM block. */
const PEM_TAIL = "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----";

const ANTHROPIC_KEY_RE = /sk-ant-[a-zA-Z0-9_-]{20,}/g;
const OPENAI_KEY_RE = /sk-(?:proj-)?[a-zA-Z0-9_-]{20,}/g;
const GITHUB_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]{20,}/g;
const NVIDIA_KEY_RE = /nvapi-[a-zA-Z0-9_-]{20,}/g;
const AWS_ACCESS_KEY_RE = /(?:AKIA|ASIA)[0-9A-Z]{16}/g;
const JWT_RE = /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
const BEARER_TOKEN_RE = /Bearer\s+[a-zA-Z0-9._-]{16,}/g;
const BASIC_AUTH_RE = /Basic\s+[a-zA-Z0-9+/=]{16,}/g;
const PRIVATE_KEY_RE = new RegExp(`-----BEGIN ${PEM_TAIL}[\\s\\S]*?-----END ${PEM_TAIL}`, "g");

interface NamedPattern {
	name: string;
	pattern: RegExp;
	replacement: string;
}

/**
 * High-signal, low-false-positive secret shapes (a safe subset).
 *
 * Order matters: the more specific prefix must come first. `sk-ant-…` is also
 * matched by the broader `sk-…` OpenAI pattern, so Anthropic is listed first to
 * keep the audit label truthful. Both orders redact — only the label differs.
 */
const BUILTIN_PATTERNS: NamedPattern[] = [
	{ name: "anthropic-key", pattern: ANTHROPIC_KEY_RE, replacement: "[REDACTED:ANTHROPIC_KEY]" },
	{ name: "openai-key", pattern: OPENAI_KEY_RE, replacement: "[REDACTED:OPENAI_KEY]" },
	{ name: "github-token", pattern: GITHUB_TOKEN_RE, replacement: "[REDACTED:GITHUB_TOKEN]" },
	{ name: "nvidia-key", pattern: NVIDIA_KEY_RE, replacement: "[REDACTED:NVIDIA_KEY]" },
	{ name: "aws-access-key", pattern: AWS_ACCESS_KEY_RE, replacement: "[REDACTED:AWS_ACCESS_KEY]" },
	{ name: "jwt", pattern: JWT_RE, replacement: "[REDACTED:JWT]" },
	{ name: "bearer-token", pattern: BEARER_TOKEN_RE, replacement: "[REDACTED:BEARER_TOKEN]" },
	{ name: "basic-auth", pattern: BASIC_AUTH_RE, replacement: "[REDACTED:BASIC_AUTH]" },
	{ name: "private-key", pattern: PRIVATE_KEY_RE, replacement: "[REDACTED:PRIVATE_KEY]" },
];

/** Matches any run of `HIGH_ENTROPY_RUN`+ token characters. */
const HIGH_ENTROPY_RE = new RegExp(`[A-Za-z0-9+/_=-]{${HIGH_ENTROPY_RUN},}`, "g");

/** True when a token run is mixed enough to look like a key rather than prose. */
function looksHighEntropy(run: string): boolean {
	// Require at least one letter AND one digit so we do not nuke prose words or
	// long underscore identifiers, while still catching keys, hashes and base64.
	return /[A-Za-z]/.test(run) && /[0-9]/.test(run);
}

/** Conservative built-in redaction pass (the default `RedactionPort`). */
export function builtinRedact(text: string): RedactionResult {
	let redacted = text;
	let hadSecrets = false;
	for (const { pattern, replacement } of BUILTIN_PATTERNS) {
		// Global `String.replace` resets `lastIndex` internally, so comparing
		// before/after avoids the stateful `RegExp.test` pitfall on shared /g
		// patterns.
		const before = redacted;
		redacted = redacted.replace(pattern, replacement);
		if (redacted !== before) hadSecrets = true;
	}
	return { redacted, hadSecrets };
}

/** Default detector: the built-in patterns plus the high-entropy heuristic. */
export function builtinContainsSecrets(text: string): boolean {
	// `String.search` saves and restores `lastIndex`, and `String.matchAll`
	// operates on an internal clone, so neither mutates these shared module-scope
	// /g patterns. `RegExp.test` would advance `lastIndex` and leak state across
	// calls, which is why it is deliberately not used here.
	for (const { pattern } of BUILTIN_PATTERNS) {
		if (text.search(pattern) !== -1) return true;
	}
	for (const match of text.matchAll(HIGH_ENTROPY_RE)) {
		if (looksHighEntropy(match[0])) return true;
	}
	return false;
}

/**
 * Last-resort conservative redactor, applied when the primary redactor faults
 * OR leaves residual secrets. Over-redacts on purpose: it strips every known
 * secret shape AND every high-entropy token run. Pure, and never throws for
 * string input — callers still wrap it defensively.
 */
export function panicRedact(text: string): string {
	const base = builtinRedact(text).redacted;
	return base.replace(HIGH_ENTROPY_RE, run => {
		return looksHighEntropy(run) ? "[REDACTED:HIGH_ENTROPY]" : run;
	});
}

export const builtinRedactionPort: RedactionPort = { redact: builtinRedact };
export const builtinDetector: SecretDetectorPort = { containsSecrets: builtinContainsSecrets };

/**
 * Adapt a concrete `redactText(text) => { redacted, hasSecrets }` implementation
 * into a `RedactionPort` without a hard import.
 */
export function redactionPortFromRedactText(
	redactText: (text: string) => { redacted: string; hasSecrets?: boolean },
): RedactionPort {
	return {
		redact(text: string) {
			const result = redactText(text);
			return { redacted: result.redacted, hadSecrets: Boolean(result.hasSecrets) };
		},
	};
}

/** Adapt a `containsSecrets(text) => boolean` function into a `SecretDetectorPort`. */
export function detectorFromContainsSecrets(fn: (text: string) => boolean): SecretDetectorPort {
	return { containsSecrets: fn };
}

// ---------------------------------------------------------------------------
// Generic fail-open wrapper.
// ---------------------------------------------------------------------------

/**
 * Run `op`; if it throws, contain the fault and return `fallback` with
 * `failedOpen: true`. Never rethrows. This is the primitive that every guarded
 * dependency call is built on.
 */
export function withResilience<T>(op: () => T, fallback: T): ResilientResult<T> {
	try {
		return { ok: true, value: op(), failedOpen: false };
	} catch (err) {
		return { ok: false, value: fallback, failedOpen: true, error: errorMessage(err) };
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function safeContainsSecrets(detector: SecretDetectorPort, text: string): boolean {
	// A faulting detector must fail SAFE: assume the payload is dirty so the
	// guard escalates or blocks rather than optimistically storing it.
	return withResilience(() => detector.containsSecrets(text), true).value;
}

// ---------------------------------------------------------------------------
// Core decision: guardText().
// ---------------------------------------------------------------------------

type OutcomeRest = Omit<SecureOutcome, "action" | "safeText" | "mode">;

function storeOutcome(mode: SecurityMode, safeText: string, rest: OutcomeRest): SecureOutcome {
	return { action: "store", safeText, mode, ...rest };
}

function blockOutcome(mode: SecurityMode, safeText: string, rest: OutcomeRest): SecureOutcome {
	return { action: "block", safeText, mode, ...rest };
}

const EMPTY_OPTIONS: SecurityOptions = {};

/**
 * Decide what to do with a single payload — pure, no storage side effects.
 *
 * Invariant: the returned outcome NEVER has `action: "store"` for a `safeText`
 * that the detector still flags. A detectably-secret payload is always blocked,
 * in every mode, even under fault injection.
 */
export function guardText(text: string, options: SecurityOptions = EMPTY_OPTIONS): SecureOutcome {
	const mode: SecurityMode = options.mode ?? "observe";
	const redactionPort = options.redactionPort ?? builtinRedactionPort;
	const detector = options.detector ?? builtinDetector;

	let outcome: SecureOutcome;
	const primary = withResilience(() => redactionPort.redact(text), null as RedactionResult | null);

	if (primary.ok && primary.value) {
		// --- Happy path: the primary redactor succeeded. ---
		let safeText = primary.value.redacted;
		const hadSecrets = primary.value.hadSecrets;

		if (safeContainsSecrets(detector, safeText)) {
			// The primary left something behind — escalate to the conservative pass.
			safeText = withResilience(() => panicRedact(safeText), UNSAFE_PLACEHOLDER).value;
			if (safeContainsSecrets(detector, safeText)) {
				// Still dirty, so never store it, regardless of mode.
				outcome = blockOutcome(mode, safeText, {
					redactedApplied: true,
					hadSecrets,
					residualSuspected: true,
					failedOpen: false,
					faultInjected: false,
					reason: "residual-secret-after-fallback",
				});
			} else {
				outcome = storeOutcome(mode, safeText, {
					redactedApplied: true,
					hadSecrets,
					residualSuspected: true,
					failedOpen: false,
					faultInjected: false,
					reason: "primary-residual-cleaned-by-fallback",
				});
			}
		} else {
			outcome = storeOutcome(mode, safeText, {
				redactedApplied: true,
				hadSecrets,
				residualSuspected: false,
				failedOpen: false,
				faultInjected: false,
				reason: hadSecrets ? "redacted-clean" : "no-secrets-detected",
			});
		}
	} else {
		// --- Fault path: the primary redactor threw. Contain it. ---
		const fallbackText = withResilience(() => panicRedact(text), UNSAFE_PLACEHOLDER).value;

		if (safeContainsSecrets(detector, fallbackText)) {
			// The fallback could not prove it clean, so block rather than leak.
			outcome = blockOutcome(mode, fallbackText, {
				redactedApplied: true,
				hadSecrets: false,
				residualSuspected: true,
				failedOpen: true,
				faultInjected: true,
				reason: "redactor-fault-residual-blocked",
			});
		} else if (mode === "enforce") {
			// enforce: a redactor that throws is not trusted even when the
			// fallback output looks clean.
			outcome = blockOutcome(mode, fallbackText, {
				redactedApplied: true,
				hadSecrets: false,
				residualSuspected: false,
				failedOpen: true,
				faultInjected: true,
				reason: "redactor-fault-fail-closed",
			});
		} else {
			// observe: store the conservative fallback output, contained.
			outcome = storeOutcome(mode, fallbackText, {
				redactedApplied: true,
				hadSecrets: false,
				residualSuspected: false,
				failedOpen: true,
				faultInjected: true,
				reason: "redactor-fault-panic-redacted",
			});
		}
	}

	emitEvent(options, outcome);
	return outcome;
}

function emitEvent(options: SecurityOptions, outcome: SecureOutcome): void {
	const sink = options.telemetrySink;
	if (!sink) return;

	const now = options.now ?? Date.now;
	const event: SecurityEvent = {
		name: SECURITY_GUARD_NAME,
		version: SECURITY_GUARD_VERSION,
		mode: outcome.mode,
		action: outcome.action,
		redactedApplied: outcome.redactedApplied,
		hadSecrets: outcome.hadSecrets,
		residualSuspected: outcome.residualSuspected,
		failedOpen: outcome.failedOpen,
		faultInjected: outcome.faultInjected,
		reason: outcome.reason,
		timestamp: withResilience(() => now(), 0).value,
	};
	// Telemetry is best-effort; a sink fault must never break the guard.
	withResilience<void>(() => sink(event), undefined);
}

// ---------------------------------------------------------------------------
// Secure store wrapper — redaction before storage.
// ---------------------------------------------------------------------------

function defaultGetText<T>(record: T): string {
	if (typeof record === "string") return record;
	if (record && typeof record === "object" && "content" in record) {
		const content = (record as { content: unknown }).content;
		if (typeof content === "string") return content;
	}
	return "";
}

function defaultWithText<T>(record: T, redacted: string): T {
	if (typeof record === "string") return redacted as unknown as T;
	if (record && typeof record === "object") {
		return { ...(record as object), content: redacted } as T;
	}
	return record;
}

/**
 * Wrap a durable store so every write is redacted first. The underlying store
 * only ever receives the redacted record; a blocked or faulting write never
 * reaches it. The returned writer never throws.
 */
export function makeSecureStore<T>(store: DurableStorePort<T>, options: SecureStoreOptions<T> = {}): SecureStore<T> {
	const getText = options.getText ?? defaultGetText<T>;
	const withText = options.withText ?? defaultWithText<T>;

	return {
		write(record: T): SecureStoreResult<T> {
			const text = withResilience(() => getText(record), "").value;
			const outcome = guardText(text, options);

			if (outcome.action === "block") {
				return { stored: false, blocked: true, failedOpen: outcome.failedOpen, outcome };
			}

			const rebuilt = withResilience(() => withText(record, outcome.safeText), undefined as T | undefined);
			const safeRecord = rebuilt.value;
			if (safeRecord === undefined) {
				// Could not build a redacted record, so refuse to store. Never store raw.
				return {
					stored: false,
					blocked: true,
					failedOpen: true,
					outcome: { ...outcome, action: "block", reason: "record-rebuild-failed" },
				};
			}

			const written = withResilience(() => {
				store.write(safeRecord);
				return true;
			}, false);

			if (!written.ok) {
				// The store faulted, and the fault is contained. No raw data was persisted.
				return {
					stored: false,
					blocked: false,
					failedOpen: true,
					storedRecord: safeRecord,
					outcome,
					error: written.error,
				};
			}

			return { stored: true, blocked: false, failedOpen: outcome.failedOpen, storedRecord: safeRecord, outcome };
		},
	};
}

/** One-shot convenience: redact and store a single record. */
export function secureWrite<T>(
	store: DurableStorePort<T>,
	record: T,
	options: SecureStoreOptions<T> = {},
): SecureStoreResult<T> {
	return makeSecureStore(store, options).write(record);
}
