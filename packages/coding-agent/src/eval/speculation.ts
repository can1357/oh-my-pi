/**
 * Speculative programmatic tool calling (sPTC) for eval cells.
 *
 * While the model is still streaming an `eval` tool call, the partially
 * generated cell source already contains complete, fully-literal calls to
 * high-latency bridge tools. This launches those early and parks the promise so
 * the real call inside the cell resolves against work that started seconds
 * before the cell existed. After Zhang, "Speculative Programmatic Tool Calling"
 * (2026), https://alexzhang13.github.io/blog/2026/spec-ptc/
 *
 * Scope is deliberately narrower than the paper's, because our bridge surface is
 * not the paper's pure `llm_query`:
 *
 * - `completion()` IS speculated. It is a stateless one-shot with no tools and
 *   no history, so an unclaimed speculation costs tokens and nothing else.
 * - `agent()` is NOT, despite being the higher-latency call. A subagent can edit
 *   files, so launching one for a branch the cell never takes would mutate the
 *   repository. Read-only agents could be added once the target agent is
 *   resolvable from the call site and checkable against the roster.
 * - Every other bridge tool (`write`, `edit`, `bash`, ...) is side-effecting by
 *   definition and is never a candidate.
 *
 * Only calls whose arguments are literals are considered, "Case 1" in the paper.
 * Variable dependencies would need a shadow REPL, which the JS kernel cannot
 * cheaply provide: cell state lives on a Worker's `globalThis` (see
 * `eval/js/shared/rewrite-imports.ts`, which demotes `const`/`let` to `var` for
 * exactly that reason), and `node:vm` is off the table under Bun because
 * `Worker.terminate()` mid-`runInContext` crashes the parent
 * (`eval/js/shared/indirect-eval.ts`).
 *
 * A speculation is never load-bearing. Every failure mode (miss, reject, abort,
 * budget exhaustion) falls back to running the real call normally, so the worst
 * outcome is wasted tokens rather than a wrong or failed cell.
 */

import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

/** Cell languages whose source this scanner understands. */
export type SpeculationLanguage = "js" | "py";

/** The single bridge tool speculated today. See the module docstring. */
export const SPECULATED_BRIDGE_TOOL = "__completion__";

/** A streamed eval cell worth scanning. */
export interface StreamedEvalCell {
	code: string;
	language: SpeculationLanguage;
}

/**
 * Recover the in-progress eval cell from a streamed assistant event, or
 * `undefined` when the event is not a partially-written eval call.
 *
 * Mirrors `StreamingEditGuard`'s access pattern: the provider fills
 * `toolCall.arguments` progressively as the JSON arrives, so a half-written cell
 * is readable here well before the tool runs. Split out from the session so the
 * event-shape handling is directly testable, leaving only the call site untested.
 */
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
 * Stable identity for a speculated call. Two textually different call sites with
 * identical arguments share a key; the store distinguishes them by occurrence,
 * because a completion is non-deterministic and one speculated result must not
 * satisfy two calls.
 */
export function speculationKey(name: string, args: Record<string, unknown>): string {
	const keys = Object.keys(args).sort();
	const parts = keys.map(key => `${key}=${JSON.stringify(args[key])}`);
	return `${name}\u0000${parts.join("\u0000")}`;
}

interface StringLiteral {
	/** Index just past the closing quote. */
	end: number;
	/**
	 * Literal text, present only when the source needs no unescaping. Absent
	 * means the terminator was located but the value is not reproducible, so the
	 * span may be skipped and must not be speculated on.
	 */
	value?: string;
}

/**
 * Read a string literal starting at `start`.
 *
 * Three outcomes, and the distinction is load-bearing:
 *
 * - a literal with `value`: safe to speculate on.
 * - a literal without `value`: terminator found, contents not reproducible
 *   without an escape decoder. The caller skips the span.
 * - `undefined`: the terminator could not be located at all, because the string
 *   is still streaming or because a template interpolation can nest quotes,
 *   braces, and further templates. The caller MUST stop scanning rather than
 *   walk into the body, which would read string contents as code.
 *
 * Escapes are never decoded: a decoder that disagreed with the runtime by one
 * character would key the speculation differently from the real call, wasting it
 * silently. They are consumed only to keep the terminator search aligned.
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
 * Parse `("literal")` starting at `afterIdent`, the index just past the callee
 * name. Anything else, including a second argument, yields `undefined`.
 *
 * The single-argument restriction keeps the reconstructed bridge args provably
 * identical to the prelude's. `completion(prompt)` with no options resolves to
 * exactly `{ prompt }` (`optionsArg` returns `{}` for a nil options value, see
 * `eval/js/shared/prelude.txt`), so the key computed here matches the key
 * computed at dispatch. Supporting an options object means mirroring
 * `optionsArg` normalization, and a mismatch there is a silent waste rather
 * than a visible error.
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
 * Scan cell source for complete, fully-literal speculatable calls, in source
 * order.
 *
 * Safe on a truncated prefix. An unclosed argument list yields nothing for that
 * call site, and a string whose terminator cannot be located stops the scan
 * outright rather than walking into its body: a cell that builds a meta-prompt
 * containing `completion('...')` would otherwise phantom-launch a billable call
 * for text the runtime never runs. Stopping costs nothing, because `observe`
 * re-scans the whole prefix on the next delta, by which point the string has
 * usually closed.
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
			// No locatable terminator: stop. Scanning onward would read the string's
			// contents as code, and a missed speculation is free while a phantom one
			// is billed.
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

interface SpeculationEntry {
	promise: Promise<SpeculationClaim>;
	controller: AbortController;
	claimed: boolean;
}

export interface EvalSpeculationOptions {
	run: SpeculationRunner;
	isEnabled: () => boolean;
	/** Ceiling on launches per turn. Speculation is billable, so this is not optional. */
	maxPerTurn: () => number;
}

/**
 * Per-session store of in-flight speculations, keyed by call identity and
 * claimed in occurrence order.
 *
 * Lifetime is one turn: {@link reset} aborts everything still unclaimed, so a
 * cell that never ran the speculated call stops paying for it as soon as the
 * turn settles.
 */
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
	 * Scan a partial cell and launch any call that is newly complete.
	 *
	 * Called once per streamed delta, so it must be idempotent: a key already
	 * launched as many times as it appears in the source is skipped, and the
	 * count grows only as the model writes more call sites.
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
		const promise = this.#run(call.name, call.args, controller.signal).then(
			(value): SpeculationClaim => ({ ok: true, value }),
			(error): SpeculationClaim => {
				// A speculation must never become the cell's failure. Report the miss
				// and let the caller run the real call with its own signal.
				logger.debug("eval speculation failed, falling back", { tool: call.name, error: String(error) });
				return { ok: false };
			},
		);
		const list = this.#entries.get(key);
		const entry: SpeculationEntry = { promise, controller, claimed: false };
		if (list) list.push(entry);
		else this.#entries.set(key, [entry]);
		this.#launched++;
	}

	/**
	 * Claim a speculated result for a real call, or `undefined` when none is
	 * parked. Each entry is claimable once: completions are non-deterministic, so
	 * two identical call sites must not collapse onto one result.
	 */
	claim(name: string, args: Record<string, unknown>): Promise<SpeculationClaim> | undefined {
		if (!this.#isEnabled()) return undefined;
		const entry = this.#entries.get(speculationKey(name, args))?.find(candidate => !candidate.claimed);
		if (!entry) return undefined;
		entry.claimed = true;
		return entry.promise;
	}

	/** Abort every unclaimed speculation and drop the turn's state. */
	reset(): void {
		for (const list of this.#entries.values()) {
			for (const entry of list) {
				if (!entry.claimed) entry.controller.abort();
			}
		}
		this.#entries = new Map();
		this.#launched = 0;
	}
}

/**
 * Store lookup keyed by the `ToolSession` a speculation dispatches through.
 *
 * Deliberately a side table rather than a `ToolSession` member. That interface
 * is shared by every tool, and widening it shifted type instantiation elsewhere
 * in the package badly enough to break inference in an unrelated test's
 * heterogeneous `new Map([...])`. Keeping the coupling here confines it to the
 * eval bridge, and a weak key means the entry dies with the session.
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
