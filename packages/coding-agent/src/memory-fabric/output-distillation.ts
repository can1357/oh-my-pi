/**
 * Output Distillation (OD1).
 *
 * OD1 compresses noisy tool output (test runs, compiler diagnostics, build
 * logs, git output) into a compact, high-signal summary while archiving the
 * full raw output as *redacted-at-rest* evidence. Distillation is lossy for
 * the model-facing view but the raw evidence remains retrievable by id.
 *
 * Design invariants:
 *  - Redact BEFORE persist. Evidence is redacted irreversibly at rest.
 *  - Fail open. Any distiller error yields a safe passthrough excerpt; a tool
 *    result is never dropped because distillation failed.
 *  - Never fabricate. Distillers only select/collapse existing lines.
 *
 * The complementary never-worse guard (ACF CH1 rule #5) adds the guarantee
 * that the distilled, model-facing view is never *worse* than a bounded,
 * redacted excerpt of the original — neither larger nor missing the failure
 * signal the original carried. Everything here is additive and injectable;
 * nothing in the hot path calls it yet.
 */

import { redactText } from "./redaction";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DistillFormat = "test" | "compiler" | "build" | "git-log" | "git-diff" | "generic";

/** A redacted-at-rest evidence record. `content` is already irreversibly redacted. */
export interface RedactedEvidenceRecord {
	evidenceId: string;
	projectId: string;
	/** Hash of the *redacted* content (stable id for dedupe / integrity). */
	contentHash: string;
	redactionVersion: string;
	redactionCount: number;
	redactionTypes: string[];
	/** True when redaction did not remove structural lines (only inline spans). */
	structurallyComplete: boolean;
	content: string;
	byteLength: number;
	createdAt: string;
}

export interface DistilledToolOutput {
	format: DistillFormat;
	/** One-line headline (e.g. "3 passed, 2 failed"). */
	summary: string;
	/** Ordered, deduped critical lines kept verbatim (post-redaction). */
	criticalLines: string[];
	warnings: string[];
	errors: string[];
	/** The full distilled, model-facing text (post-redaction). */
	text: string;
	originalBytes: number;
	distilledBytes: number;
	originalTokens: number;
	distilledTokens: number;
	/** distilledTokens / originalTokens in [0,1]; lower is more compression. */
	compressionRatio: number;
	/** Id of the archived redacted raw evidence (empty when archiving disabled). */
	rawEvidenceId: string;
	/** The model-facing text is a lossy view; raw evidence is authoritative. */
	reversible: false;
	redactionCount: number;
	/** True when the input was returned mostly as-is (below threshold / fail-open). */
	passthrough: boolean;
}

export interface DistillInput {
	content: string;
	projectId?: string;
	command?: string;
	exitCode?: number;
	toolName?: string;
	formatHint?: DistillFormat;
}

export type RedactorFn = (text: string) => { redacted: string; redactionCount: number; redactionTypes: string[] };

export interface DistillOptions {
	/** Below this byte length, skip distillation and pass content through. */
	minimumBytes?: number;
	/** Soft cap; distillers try to keep the model-facing text under this. */
	maximumDistilledLines?: number;
	/** Persist redacted raw evidence via `evidenceSink`. Default true. */
	archiveRawEvidence?: boolean;
	/** On distiller error, return a passthrough excerpt instead of throwing. Default true. */
	failOpen?: boolean;
	/** Override the redactor (defaults to the memory-fabric secret redaction). */
	redactor?: RedactorFn;
	/** Receives the redacted-at-rest evidence record for persistence. */
	evidenceSink?: (record: RedactedEvidenceRecord) => void;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
	/** Injectable id/hash for deterministic tests. */
	hash?: (text: string) => string;
}

export const REDACTION_VERSION = "of-redact-1";

// ---------------------------------------------------------------------------
// Evidence persistence
// ---------------------------------------------------------------------------

/**
 * Durable, append-only evidence store (e.g. a Memvid lane). The persistence
 * layer only ever sees irreversibly-redacted content — redaction has already
 * happened by the time a record reaches the store. `EvidenceStorePort` is a
 * minimal `put(record)` contract so the host wires it to real storage with a
 * one-line closure; no storage engine or native deps are imported here.
 */
export interface EvidenceStorePort {
	/** Persist one redacted-at-rest evidence record. May be async. */
	put(record: RedactedEvidenceRecord): void | Promise<void>;
}

/**
 * Build an OD1 `evidenceSink` from an {@link EvidenceStorePort}. The sink is
 * synchronous (as OD1 expects) and fire-and-forget: it schedules the durable
 * write and returns immediately, swallowing any error through `onError` —
 * a storage outage must never break a tool call.
 */
export function createEvidenceSink(
	store: EvidenceStorePort,
	onError?: (error: unknown) => void,
): (record: RedactedEvidenceRecord) => void {
	return record => {
		try {
			const result = store.put(record);
			if (result && typeof (result as Promise<void>).then === "function") {
				(result as Promise<void>).catch(error => {
					try {
						onError?.(error);
					} catch {
						/* diagnostics must never throw */
					}
				});
			}
		} catch (error) {
			try {
				onError?.(error);
			} catch {
				/* diagnostics must never throw */
			}
		}
	};
}

/** In-memory, append-only evidence store for tests and evidence collection. */
export class InMemoryEvidenceStore implements EvidenceStorePort {
	readonly #records: RedactedEvidenceRecord[] = [];

	put(record: RedactedEvidenceRecord): void {
		this.#records.push(record);
	}

	all(): readonly RedactedEvidenceRecord[] {
		return this.#records;
	}

	get(evidenceId: string): RedactedEvidenceRecord | undefined {
		return this.#records.find(r => r.evidenceId === evidenceId);
	}

	forProject(projectId: string): RedactedEvidenceRecord[] {
		return this.#records.filter(r => r.projectId === projectId);
	}

	get size(): number {
		return this.#records.length;
	}
}

// ---------------------------------------------------------------------------
// Distillation core
// ---------------------------------------------------------------------------

const DEFAULT_MIN_BYTES = 400;
const DEFAULT_MAX_LINES = 60;
const PASSTHROUGH_HEAD = 40;
const PASSTHROUGH_TAIL = 20;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROGRESS_RE = /^\s*(?:\d{1,3}%|\[=*>?\s*\]|[▏▎▍▌▋▊▉█\s]*\d+\/\d+)\s*$/;

// Note: ✗/✘ sit outside the \b group — word boundaries never match next to
// non-word characters, so keeping them inside would make those branches dead.
const ERROR_RE = /\b(?:error|fail(?:s|ed|ure)?|exception|panic|fatal|cannot|not found)\b|✗|✘/i;
const WARN_RE = /\b(warn(?:ing)?|deprecat)/i;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function estimateTokens(text: string): number {
	// Coarse but stable heuristic (~4 chars/token) used consistently on both
	// sides of the ratio so the compression figure is meaningful.
	return Math.ceil(text.length / 4);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function fnv1a(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function defaultRedactor(): RedactorFn {
	return (text: string) => {
		const result = redactText(text);
		return {
			redacted: result.redacted,
			redactionCount: result.redactions.reduce((n, r) => n + r.count, 0),
			redactionTypes: result.redactions.map(r => r.pattern),
		};
	};
}

/** Detect the output format from hints and content shape. */
export function detectFormat(input: DistillInput, redactedContent: string): DistillFormat {
	if (input.formatHint) return input.formatHint;
	const c = redactedContent;
	if (/^diff --git /m.test(c) || /^@@ -\d+/m.test(c)) return "git-diff";
	if (/^commit [0-9a-f]{7,40}\b/m.test(c)) return "git-log";
	if (/\berror TS\d{2,5}:/.test(c) || /^Found \d+ errors?\b/m.test(c)) return "compiler";
	if (
		/\(pass\)|\(fail\)|\bexpect\(|\btoBe\b|✓|✗|✔|✘/.test(c) ||
		/^\s*\d+ pass\b/m.test(c) ||
		/^\s*\d+ fail\b/m.test(c) ||
		/\bRan \d+ tests?\b/.test(c)
	) {
		return "test";
	}
	if (/\b(webpack|vite|esbuild|tsc|rollup|Compiled|Build succeeded|Build failed)\b/i.test(c)) return "build";
	return "generic";
}

interface DistillerResult {
	summary: string;
	criticalLines: string[];
	warnings: string[];
	errors: string[];
	text: string;
}

function collapseNoise(lines: string[]): string[] {
	const out: string[] = [];
	let blanks = 0;
	let prev: string | null = null;
	let dupRun = 0;
	for (const raw of lines) {
		const line = stripAnsi(raw).replace(/\r/g, "");
		if (PROGRESS_RE.test(line)) continue;
		if (line.trim() === "") {
			blanks++;
			if (blanks > 1) continue;
			out.push("");
			prev = "";
			dupRun = 0;
			continue;
		}
		blanks = 0;
		if (line === prev) {
			dupRun++;
			if (dupRun === 1) out.push("… (repeated)");
			continue;
		}
		dupRun = 0;
		prev = line;
		out.push(line);
	}
	return out;
}

function distillTest(lines: string[]): DistillerResult {
	const cleaned = collapseNoise(lines);
	const errors: string[] = [];
	const warnings: string[] = [];
	const kept: string[] = [];
	let summary = "";
	for (const line of cleaned) {
		const isSummary = /\b\d+ (pass|fail)\b/.test(line) || /\bRan \d+ tests?\b/.test(line);
		const isPass = /\(pass\)|^✓|^\s*✓/.test(line) && !ERROR_RE.test(line);
		if (isSummary) {
			summary = line.trim();
			kept.push(line);
			continue;
		}
		if (isPass) continue; // collapse passing lines
		if (ERROR_RE.test(line)) {
			errors.push(line.trim());
			kept.push(line);
			continue;
		}
		if (WARN_RE.test(line)) {
			warnings.push(line.trim());
			kept.push(line);
			continue;
		}
		// keep stack frames and assertion diffs
		if (/\s+at\s+.+:\d+/.test(line) || /^\s*(Expected|Received|-|\+)/.test(line)) {
			kept.push(line);
		}
	}
	if (!summary) summary = errors.length ? `${errors.length} error line(s)` : "test output";
	return { summary, criticalLines: errors.slice(0, 40), warnings, errors, text: kept.join("\n") };
}

function distillCompiler(lines: string[]): DistillerResult {
	const cleaned = collapseNoise(lines);
	const errors: string[] = [];
	const warnings: string[] = [];
	const kept: string[] = [];
	let count: string | null = null;
	for (const line of cleaned) {
		if (/^Found \d+ errors?\b/.test(line) || /\b\d+ errors?\b/.test(line)) count = line.trim();
		if (/\berror TS\d{2,5}:/.test(line)) {
			errors.push(line.trim());
			kept.push(line);
		} else if (/\bwarning TS\d{2,5}:/.test(line) || WARN_RE.test(line)) {
			warnings.push(line.trim());
			kept.push(line);
		}
	}
	const summary = count ?? (errors.length ? `${errors.length} TypeScript error(s)` : "no diagnostics");
	return { summary, criticalLines: errors.slice(0, 40), warnings, errors, text: kept.join("\n") || summary };
}

function distillGeneric(lines: string[], maxLines: number): DistillerResult {
	const cleaned = collapseNoise(lines);
	const errors = cleaned.filter(l => ERROR_RE.test(l)).map(l => l.trim());
	const warnings = cleaned.filter(l => WARN_RE.test(l) && !ERROR_RE.test(l)).map(l => l.trim());
	let body: string[];
	if (cleaned.length <= maxLines) {
		body = cleaned;
	} else {
		const head = cleaned.slice(0, PASSTHROUGH_HEAD);
		const tail = cleaned.slice(-PASSTHROUGH_TAIL);
		const signal = [...errors, ...warnings].slice(0, 20);
		body = [
			...head,
			`… (${cleaned.length - PASSTHROUGH_HEAD - PASSTHROUGH_TAIL} lines elided) …`,
			...signal,
			...tail,
		];
	}
	const summary = errors.length
		? `${errors.length} error line(s), ${warnings.length} warning(s)`
		: `${cleaned.length} line(s)`;
	return { summary, criticalLines: errors.slice(0, 40), warnings, errors, text: body.join("\n") };
}

function runDistiller(format: DistillFormat, redacted: string, maxLines: number): DistillerResult {
	const lines = redacted.split("\n");
	switch (format) {
		case "test":
			return distillTest(lines);
		case "compiler":
			return distillCompiler(lines);
		default:
			return distillGeneric(lines, maxLines);
	}
}

function passthrough(
	redacted: string,
	format: DistillFormat,
	rawEvidenceId: string,
	redactionCount: number,
	originalBytes: number,
): DistilledToolOutput {
	const lines = redacted.split("\n");
	const clipped =
		lines.length > PASSTHROUGH_HEAD + PASSTHROUGH_TAIL
			? [...lines.slice(0, PASSTHROUGH_HEAD), "… (truncated) …", ...lines.slice(-PASSTHROUGH_TAIL)].join("\n")
			: redacted;
	return {
		format,
		summary: "passthrough",
		criticalLines: [],
		warnings: [],
		errors: [],
		text: clipped,
		originalBytes,
		distilledBytes: byteLength(clipped),
		originalTokens: estimateTokens(redacted),
		distilledTokens: estimateTokens(clipped),
		compressionRatio: redacted.length ? estimateTokens(clipped) / Math.max(1, estimateTokens(redacted)) : 1,
		rawEvidenceId,
		reversible: false,
		redactionCount,
		passthrough: true,
	};
}

/**
 * Redact the raw content, archive it as redacted-at-rest evidence, detect the
 * output format, and produce a compact model-facing summary. Fails open: any
 * internal error degrades to a safe passthrough excerpt rather than throwing.
 */
export function distill(input: DistillInput, options: DistillOptions = {}): DistilledToolOutput {
	const minBytes = options.minimumBytes ?? DEFAULT_MIN_BYTES;
	const maxLines = options.maximumDistilledLines ?? DEFAULT_MAX_LINES;
	const archive = options.archiveRawEvidence ?? true;
	const failOpen = options.failOpen ?? true;
	const redactor = options.redactor ?? defaultRedactor();
	const now = options.now ?? (() => new Date());
	const hash = options.hash ?? fnv1a;

	const raw = input.content ?? "";
	const originalBytes = byteLength(raw);

	// 1. Redact FIRST (redacted-at-rest invariant).
	let redacted = raw;
	let redactionCount = 0;
	let redactionTypes: string[] = [];
	try {
		const r = redactor(raw);
		redacted = r.redacted;
		redactionCount = r.redactionCount;
		redactionTypes = r.redactionTypes;
	} catch {
		// redactor failure must not leak raw secrets: fall back to no content.
		redacted = "[REDACTION_FAILED]";
		redactionCount = 0;
		redactionTypes = ["redaction-error"];
	}

	// 2. Archive redacted raw evidence.
	let rawEvidenceId = "";
	if (archive) {
		const contentHash = hash(redacted);
		rawEvidenceId = `ev_${contentHash}`;
		if (options.evidenceSink) {
			const record: RedactedEvidenceRecord = {
				evidenceId: rawEvidenceId,
				projectId: input.projectId ?? "unknown",
				contentHash,
				redactionVersion: REDACTION_VERSION,
				redactionCount,
				redactionTypes,
				structurallyComplete: true,
				content: redacted,
				byteLength: byteLength(redacted),
				createdAt: now().toISOString(),
			};
			try {
				options.evidenceSink(record);
			} catch {
				// evidence persistence is best-effort; never fail the tool result.
			}
		}
	}

	const format = detectFormat(input, redacted);

	// 3. Small inputs: passthrough (distillation not worth the risk/latency).
	if (originalBytes < minBytes) {
		return passthrough(redacted, format, rawEvidenceId, redactionCount, originalBytes);
	}

	// 4. Distill (fail open).
	try {
		const d = runDistiller(format, redacted, maxLines);
		const text = d.text.length ? d.text : d.summary;
		return {
			format,
			summary: d.summary,
			criticalLines: d.criticalLines,
			warnings: d.warnings,
			errors: d.errors,
			text,
			originalBytes,
			distilledBytes: byteLength(text),
			originalTokens: estimateTokens(redacted),
			distilledTokens: estimateTokens(text),
			compressionRatio: estimateTokens(text) / Math.max(1, estimateTokens(redacted)),
			rawEvidenceId,
			reversible: false,
			redactionCount,
			passthrough: false,
		};
	} catch {
		if (!failOpen) throw new Error("distillation failed");
		return passthrough(redacted, format, rawEvidenceId, redactionCount, originalBytes);
	}
}

// ---------------------------------------------------------------------------
// Never-worse guard (ACF CH1 rule #5)
// ---------------------------------------------------------------------------

/** Which representation the guard selected for the model. */
export type GuardChoice = "distilled" | "bounded-original";

/** Token-accounting signals for one guard decision. */
export interface GuardTelemetry {
	choice: GuardChoice;
	reason: string;
	distilledTokens: number;
	boundedOriginalTokens: number;
	chosenTokens: number;
	failureSignalInOriginal: boolean;
	failureSignalPreserved: boolean;
}

export interface NeverWorseInput {
	/** The distilled, model-facing output produced by OD1 `distill()`. */
	distilled: DistilledToolOutput;
	/** The full, already-redacted original content (e.g. evidence record content). */
	redactedOriginal: string;
	/** Optional process exit code; a non-zero code counts as a failure signal. */
	exitCode?: number;
}

export interface NeverWorseOptions {
	/** Lines kept from the head of the bounded excerpt. Default 40. */
	boundedHeadLines?: number;
	/** Lines kept from the tail of the bounded excerpt. Default 20. */
	boundedTailLines?: number;
	/** Max signal lines re-inserted into the bounded excerpt. Default 20. */
	maxSignalLines?: number;
	/** Injectable token estimator (defaults to OD1's ~4 chars/token heuristic). */
	estimateTokens?: (text: string) => number;
	/** Receives token telemetry for each decision. Called fail-open. */
	telemetrySink?: (telemetry: GuardTelemetry) => void;
}

export interface GuardedOutput extends GuardTelemetry {
	/** The model-facing text to actually use. */
	text: string;
}

const DEFAULT_HEAD = 40;
const DEFAULT_TAIL = 20;
const DEFAULT_SIGNAL = 20;

/**
 * Build a bounded, redacted excerpt of the original that is safe to show the
 * model as a fallback: head + elision marker + preserved signal lines + tail.
 * Failure/warning lines are always re-inserted so the fallback can never hide
 * a failure the original reported.
 */
export function boundRedactedOriginal(
	redacted: string,
	head: number = DEFAULT_HEAD,
	tail: number = DEFAULT_TAIL,
	maxSignal: number = DEFAULT_SIGNAL,
): string {
	const lines = redacted.split("\n");
	if (lines.length <= head + tail) return redacted;
	const errors = lines.filter(l => ERROR_RE.test(l));
	const warnings = lines.filter(l => WARN_RE.test(l) && !ERROR_RE.test(l));
	const signal = [...errors, ...warnings].slice(0, maxSignal);
	const elided = lines.length - head - tail;
	return [...lines.slice(0, head), `… (${elided} lines elided) …`, ...signal, ...lines.slice(-tail)].join("\n");
}

/**
 * Decide between the distilled view and a bounded redacted excerpt such that
 * the result is never worse (larger or less safe) than the excerpt. "Worse"
 * means either larger — a "compression" that produced more tokens than the
 * bounded excerpt is not a compression — or unsafe: the distilled view dropped
 * the failure signal the original carried (a transform must never change
 * failure status).
 *
 * Pure and fail-open: on any internal error the distilled view is returned
 * unchanged with reason `guard-error-fail-open`.
 */
export function applyNeverWorseGuard(input: NeverWorseInput, options: NeverWorseOptions = {}): GuardedOutput {
	const estimate = options.estimateTokens ?? estimateTokens;
	try {
		const { distilled, redactedOriginal, exitCode } = input;
		const bounded = boundRedactedOriginal(
			redactedOriginal,
			options.boundedHeadLines ?? DEFAULT_HEAD,
			options.boundedTailLines ?? DEFAULT_TAIL,
			options.maxSignalLines ?? DEFAULT_SIGNAL,
		);
		const boundedOriginalTokens = estimate(bounded);
		const distilledTokens = distilled.distilledTokens ?? estimate(distilled.text);

		const failureSignalInOriginal = ERROR_RE.test(redactedOriginal) || (exitCode != null && exitCode !== 0);
		const failureSignalPreserved =
			!failureSignalInOriginal ||
			(Array.isArray(distilled.errors) && distilled.errors.length > 0) ||
			ERROR_RE.test(distilled.text) ||
			(exitCode != null && exitCode !== 0 && distilled.text.includes(String(exitCode)));

		let choice: GuardChoice;
		let reason: string;
		if (!failureSignalPreserved) {
			choice = "bounded-original";
			reason = "failure-status not preserved in distilled view";
		} else if (distilledTokens > boundedOriginalTokens) {
			choice = "bounded-original";
			reason = "distilled larger than bounded original (never-worse size guard)";
		} else {
			choice = "distilled";
			reason = "distilled is safe and not larger than bounded original";
		}

		const text = choice === "distilled" ? distilled.text : bounded;
		const result: GuardedOutput = {
			text,
			choice,
			reason,
			distilledTokens,
			boundedOriginalTokens,
			chosenTokens: estimate(text),
			failureSignalInOriginal,
			failureSignalPreserved,
		};
		emitTelemetry(options, result);
		return result;
	} catch {
		// Fail-open: never throw. Hand back the distilled view unchanged.
		const safeText = typeof input?.distilled?.text === "string" ? input.distilled.text : "";
		const result: GuardedOutput = {
			text: safeText,
			choice: "distilled",
			reason: "guard-error-fail-open",
			distilledTokens: input?.distilled?.distilledTokens ?? 0,
			boundedOriginalTokens: 0,
			chosenTokens: estimateTokens(safeText),
			failureSignalInOriginal: false,
			failureSignalPreserved: true,
		};
		emitTelemetry(options, result);
		return result;
	}
}

function emitTelemetry(options: NeverWorseOptions, result: GuardedOutput): void {
	if (!options.telemetrySink) return;
	try {
		options.telemetrySink({
			choice: result.choice,
			reason: result.reason,
			distilledTokens: result.distilledTokens,
			boundedOriginalTokens: result.boundedOriginalTokens,
			chosenTokens: result.chosenTokens,
			failureSignalInOriginal: result.failureSignalInOriginal,
			failureSignalPreserved: result.failureSignalPreserved,
		});
	} catch {
		// telemetry is best-effort; never fail the guard because of a sink error.
	}
}

/**
 * Convenience: run OD1 `distill()` and immediately apply the never-worse guard.
 *
 * The redacted original is captured from the archived evidence record so the
 * guard compares against exactly what OD1 redacted (no double-redaction). If
 * evidence archiving is disabled or produced no record, the guard degrades to
 * comparing against the distilled text itself (a safe no-op).
 */
export function distillGuarded(
	input: DistillInput,
	options: { distill?: DistillOptions; guard?: NeverWorseOptions } = {},
): { distilled: DistilledToolOutput; guarded: GuardedOutput } {
	let captured: string | null = null;
	const userSink = options.distill?.evidenceSink;
	const distillOptions: DistillOptions = {
		...options.distill,
		archiveRawEvidence: true,
		evidenceSink: (record: RedactedEvidenceRecord) => {
			captured = record.content;
			if (userSink) {
				try {
					userSink(record);
				} catch {
					// preserve OD1's best-effort evidence contract.
				}
			}
		},
	};

	const distilled = distill(input, distillOptions);
	const redactedOriginal = captured ?? distilled.text;
	const guarded = applyNeverWorseGuard({ distilled, redactedOriginal, exitCode: input.exitCode }, options.guard);
	return { distilled, guarded };
}
