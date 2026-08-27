/**
 * Speculative programmatic tool calling: launch fully-literal `completion()` calls found
 * in a still-streaming eval cell. Never load-bearing; every failure runs the real call.
 */

import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

/** Cell languages whose source this scanner understands. */
export type SpeculationLanguage = "js" | "py";

/**
 * The only speculated bridge tool: stateless, so an unclaimed launch wastes only tokens.
 * Never add `agent()` or a writing tool; they mutate the repo on untaken branches.
 */
export const SPECULATED_BRIDGE_TOOL = "__completion__";

/** A streamed eval cell worth scanning. */
export interface StreamedEvalCell {
	code: string;
	language: SpeculationLanguage;
}

/** Recover the in-progress eval cell from a streamed assistant event, if it is one. */
export function streamedEvalCell(event: AgentEvent): StreamedEvalCell | undefined {
	if (event.type !== "message_update" || event.message.role !== "assistant") return undefined;
	const assistantEvent = event.assistantMessageEvent;
	if (
		assistantEvent.type !== "toolcall_start" &&
		assistantEvent.type !== "toolcall_delta" &&
		assistantEvent.type !== "toolcall_end"
	) {
		return undefined;
	}
	const contentIndex = assistantEvent.contentIndex ?? 0;
	const content = event.message.content;
	if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) return undefined;
	const toolCall = content[contentIndex] as ToolCall;
	if (toolCall?.name !== "eval") return undefined;
	const args = toolCall.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const { language, code } = args as { language?: unknown; code?: unknown };
	// Only the two runtimes whose comment and string syntax the scanner models.
	if ((language !== "js" && language !== "py") || typeof code !== "string") return undefined;
	return { code, language };
}

/** A complete, fully-literal bridge call recovered from partial cell source. */
export interface SpeculatableCall {
	/** Bridge tool name as the prelude would send it. */
	name: string;
	/** Bridge args as the prelude would send them. */
	args: Record<string, unknown>;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Stable identity for a speculated call. Equal-argument call sites share a key and the
 * store separates them by occurrence, so one result never satisfies two calls.
 */
export function speculationKey(name: string, args: Record<string, unknown>): string {
	const keys = Object.keys(args).sort();
	const parts = keys.map(key => `${key}=${JSON.stringify(args[key])}`);
	return `${name}\u0000${parts.join("\u0000")}`;
}

interface StringLiteral {
	/** Index just past the closing quote. */
	end: number;
	/** Literal text, present only when the source needs no unescaping. */
	value?: string;
}

/**
 * Read a string literal at `start`. With `value` it is safe to speculate on; without,
 * the terminator was found but needs decoding; `undefined` means the caller must stop.
 */
function readStringLiteral(code: string, start: number, language: SpeculationLanguage): StringLiteral | undefined {
	const quote = code[start];
	if (quote === undefined) return undefined;
	// Python triple-quoted strings are a distinct terminator, not a repeat of the
	// single-quote scan: `"""a"b"""` would otherwise close at the inner quote.
	const triple = language === "py" && (quote === '"' || quote === "'") && code.startsWith(quote.repeat(3), start);
	const terminator = triple ? quote.repeat(3) : quote;
	let index = start + terminator.length;
	let reproducible = true;
	while (index < code.length) {
		const ch = code[index];
		if (ch === "\\") {
			reproducible = false;
			index += 2;
			continue;
		}
		if (language === "js" && quote === "`" && ch === "$" && code[index + 1] === "{") return undefined;
		if (!triple && quote !== "`" && (ch === "\n" || ch === "\r")) return undefined;
		if (code.startsWith(terminator, index)) {
			const body = code.slice(start + terminator.length, index);
			return { end: index + terminator.length, value: reproducible ? body : undefined };
		}
		index++;
	}
	return undefined;
}

/** Index of the first character at or after `index` that is not whitespace. */
function skipWhitespace(code: string, index: number): number {
	let i = index;
	while (i < code.length && /\s/.test(code[i] as string)) i++;
	return i;
}

/** Index just past the end of the current line. */
function skipLineComment(code: string, index: number): number {
	const nl = code.indexOf("\n", index);
	return nl === -1 ? code.length : nl + 1;
}

/** Index just past a JS block comment, or end of input when unterminated. */
function skipBlockComment(code: string, index: number): number {
	const close = code.indexOf("*/", index + 2);
	return close === -1 ? code.length : close + 2;
}

interface LiteralCall {
	prompt: string;
	end: number;
}

/**
 * Parse `("literal")` starting at `afterIdent`. A second argument yields `undefined`:
 * only a lone prompt provably reconstructs the prelude's bridge args.
 */
function readLiteralCall(code: string, afterIdent: number, language: SpeculationLanguage): LiteralCall | undefined {
	let index = skipWhitespace(code, afterIdent);
	if (code[index] !== "(") return undefined;
	index = skipWhitespace(code, index + 1);
	const literal = readStringLiteral(code, index, language);
	if (literal?.value === undefined) return undefined;
	index = skipWhitespace(code, literal.end);
	if (code[index] !== ")") return undefined;
	return { prompt: literal.value, end: index + 1 };
}

/**
 * Scan cell source for complete, fully-literal speculatable calls, in source order.
 * Safe on a truncated prefix; `observe` re-scans the whole prefix on the next delta.
 */
export function findSpeculatableCalls(code: string, language: SpeculationLanguage): SpeculatableCall[] {
	const found: SpeculatableCall[] = [];
	let index = 0;
	while (index < code.length) {
		const ch = code[index] as string;
		if (language === "js" && ch === "/" && code[index + 1] === "/") {
			index = skipLineComment(code, index);
			continue;
		}
		if (language === "js" && ch === "/" && code[index + 1] === "*") {
			index = skipBlockComment(code, index);
			continue;
		}
		if (language === "py" && ch === "#") {
			index = skipLineComment(code, index);
			continue;
		}
		if (ch === '"' || ch === "'" || (language === "js" && ch === "`")) {
			const literal = readStringLiteral(code, index, language);
			// Stop rather than read the string body as code: a missed speculation is
			// free, a phantom one is billed.
			if (!literal) return found;
			index = literal.end;
			continue;
		}
		if (IDENT_CHAR.test(ch)) {
			const start = index;
			while (index < code.length && IDENT_CHAR.test(code[index] as string)) index++;
			// A preceding ident char would have been consumed into this same word,
			// so a member call is the only shadowing form left to reject.
			if (code.slice(start, index) === "completion" && code[start - 1] !== ".") {
				const call = readLiteralCall(code, index, language);
				if (call) {
					found.push({ name: SPECULATED_BRIDGE_TOOL, args: { prompt: call.prompt } });
					index = call.end;
				}
			}
			continue;
		}
		index++;
	}
	return found;
}

/** Runs a bridge call for real. Supplied by the owner so this module stays free of the bridge. */
export type SpeculationRunner = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** Outcome of claiming a speculation. `ok: false` means the caller must run the call itself. */
export type SpeculationClaim = { ok: true; value: unknown } | { ok: false };

/** Launch/settle times for one speculation, created before the run so callbacks can close over it. */
interface SpeculationTiming {
	launchedAt: number;
	settledAt?: number;
}

interface SpeculationEntry {
	promise: Promise<SpeculationClaim>;
	controller: AbortController;
	claimed: boolean;
	timing: SpeculationTiming;
}

export interface EvalSpeculationOptions {
	run: SpeculationRunner;
	isEnabled: () => boolean;
	/** Ceiling on launches per turn. Speculation is billable, so this is not optional. */
	maxPerTurn: () => number;
}

/** Per-session store of in-flight speculations. Lifetime is one turn; {@link reset} aborts unclaimed ones. */
export class EvalSpeculationStore {
	readonly #run: SpeculationRunner;
	readonly #isEnabled: () => boolean;
	readonly #maxPerTurn: () => number;
	#entries = new Map<string, SpeculationEntry[]>();
	#launched = 0;

	constructor(options: EvalSpeculationOptions) {
		this.#run = options.run;
		this.#isEnabled = options.isEnabled;
		this.#maxPerTurn = options.maxPerTurn;
	}

	/** Launches so far this turn, for tests and diagnostics. */
	get launched(): number {
		return this.#launched;
	}

	/**
	 * Scan a partial cell and launch any newly complete call. Runs once per delta, so
	 * a key already launched as often as it appears in the source is skipped.
	 */
	observe(code: string, language: SpeculationLanguage): void {
		if (!this.#isEnabled()) return;
		const seen = new Map<string, number>();
		for (const call of findSpeculatableCalls(code, language)) {
			const key = speculationKey(call.name, call.args);
			const occurrence = (seen.get(key) ?? 0) + 1;
			seen.set(key, occurrence);
			if ((this.#entries.get(key)?.length ?? 0) >= occurrence) continue;
			if (this.#launched >= this.#maxPerTurn()) return;
			this.#launch(key, call);
		}
	}

	#launch(key: string, call: SpeculatableCall): void {
		const controller = new AbortController();
		const timing: SpeculationTiming = { launchedAt: performance.now() };
		const promise = this.#run(call.name, call.args, controller.signal).then(
			(value): SpeculationClaim => {
				timing.settledAt = performance.now();
				return { ok: true, value };
			},
			(error): SpeculationClaim => {
				// A speculation must never become the cell's failure; the caller runs the real call.
				timing.settledAt = performance.now();
				logger.debug("eval speculation failed, falling back", { tool: call.name, error: String(error) });
				return { ok: false };
			},
		);
		const list = this.#entries.get(key);
		const entry: SpeculationEntry = { promise, controller, claimed: false, timing };
		if (list) list.push(entry);
		else this.#entries.set(key, [entry]);
		this.#launched++;
		// Detects a broken streaming hook or an uninjected store. Prompt text omitted.
		logger.debug("eval speculation launched", { tool: call.name, launched: this.#launched });
	}

	/**
	 * Claim a parked result, or `undefined` when none matches. Each entry is claimable
	 * once: completions are non-deterministic, so two call sites must not share a result.
	 */
	claim(name: string, args: Record<string, unknown>): Promise<SpeculationClaim> | undefined {
		if (!this.#isEnabled()) return undefined;
		const entry = this.#entries.get(speculationKey(name, args))?.find(candidate => !candidate.claimed);
		if (!entry) return undefined;
		entry.claimed = true;
		const claimedAt = performance.now();
		// Log after settlement so claims that were still in flight are measured too.
		void entry.promise.then(result => {
			const settledAt = entry.timing.settledAt ?? performance.now();
			const resolveMs = Math.round(settledAt - entry.timing.launchedAt);
			const claimWaitMs = Math.round(Math.max(0, settledAt - claimedAt));
			logger.debug("eval speculation claimed", {
				tool: name,
				ok: result.ok,
				leadMs: Math.round(claimedAt - entry.timing.launchedAt),
				resolveMs,
				claimWaitMs,
				savedMs: result.ok ? resolveMs - claimWaitMs : 0,
				addedWaitMs: result.ok ? 0 : claimWaitMs,
			});
		});
		return entry.promise;
	}

	/** Abort every unclaimed speculation and drop the turn's state. */
	reset(): void {
		let aborted = 0;
		for (const list of this.#entries.values()) {
			for (const entry of list) {
				if (entry.claimed) continue;
				entry.controller.abort();
				aborted++;
			}
		}
		// Unclaimed launches are the cost of being wrong. Surfacing the count makes
		// the speculation ceiling tunable against real waste instead of guesswork.
		if (aborted > 0) logger.debug("eval speculations abandoned unclaimed", { aborted });
		this.#entries = new Map();
		this.#launched = 0;
	}
}

/**
 * Store lookup keyed by the `ToolSession` a speculation dispatches through. A side
 * table, not a `ToolSession` member, to keep that shared interface unwidened.
 */
const STORES_BY_SESSION = new WeakMap<object, EvalSpeculationStore>();

/** Bind a store to the tool session its speculations dispatch through. */
export function registerEvalSpeculation(session: object, store: EvalSpeculationStore): void {
	STORES_BY_SESSION.set(session, store);
}

/** The store bound to this tool session, if speculation is wired for it. */
export function evalSpeculationFor(session: object): EvalSpeculationStore | undefined {
	return STORES_BY_SESSION.get(session);
}
