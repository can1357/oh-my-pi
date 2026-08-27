import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolFactBody, ToolOutcome } from "@oh-my-pi/pi-agent-core/presentation";
import { outcomeFailed } from "@oh-my-pi/pi-agent-core/presentation";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { OutputSummary, TruncationResult } from "../session/streaming-output";
import type { OutputMeta, TruncationOptions, TruncationSummaryOptions } from "./output-meta";
import { columnLimitFactBody, outputMeta, resultCountLimitFactBody, truncationFactBody } from "./output-meta";

type ToolContent = Array<TextContent | ImageContent>;

type DetailsWithMeta = {
	meta?: OutputMeta;
	/**
	 * Fact **bodies** a tool authored for its registered trail projection —
	 * see {@link ToolResultBuilder.truncationFact}.
	 *
	 * Bodies, not `ToolFact`s: identity is minted by the scoped producer
	 * (`ToolPresentationStream#fact`, `streamId:fN`) — tools author payloads,
	 * not transport counters or fact audiences.
	 * `read` is synchronous and holds no producer handle, so it stops at the
	 * payload rather than manufacturing an identity — a tool-authored constant
	 * would collide across calls, and a receipt/dedup consumer would then be
	 * unable to tell two truncated reads apart. Nothing consumes a receipt for
	 * these yet; when a producer is threaded through the non-streaming path, it
	 * mints the IDs.
	 */
	presentationFacts?: readonly ToolFactBody[];
};

export class ToolResultBuilder<TDetails extends DetailsWithMeta> {
	#details: TDetails;
	#meta = outputMeta();
	#content: ToolContent = [];
	#isError = false;
	#useless = false;

	constructor(details?: TDetails) {
		this.#details = details ?? ({} as TDetails);
	}

	text(text: string): this {
		this.#content = [{ type: "text", text }];
		return this;
	}

	content(content: ToolContent): this {
		this.#content = content;
		return this;
	}

	truncation(result: TruncationResult, options: TruncationOptions): this {
		this.#meta.truncation(result, options);
		return this;
	}

	/**
	 * Read's escape hatch: declare a typed truncation fact
	 * *in addition to* the usual `.truncation()` meta (still populated exactly
	 * as before — the ACP mapper, `spillLargeResultToArtifact`, and every other
	 * `details.meta` consumer keep reading precisely what they always have).
	 * `ReadTool`'s registered `modelContentProjection` renders the declared
	 * fact(s) through `renderNoticeTrail` instead of letting
	 * `wrappedExecute`'s default composition bake `formatOutputNotice`'s
	 * bracket from the *meta* shape — same bytes, produced by threading a typed
	 * fact through a named projection instead of a hand-composed notice
	 * string.
	 *
	 * May be combined with {@link resultLimitFact} on the same builder (the
	 * archive-directory and sqlite-table-list sites do exactly that): both
	 * append to `details.presentationFacts` rather than overwrite it, so
	 * `renderNoticeTrail` sees every fact either declared and composes
	 * them into one bracket.
	 */
	truncationFact(result: TruncationResult, options: TruncationOptions, columnLimitValue?: number): this {
		this.#meta.truncation(result, options);
		if (columnLimitValue) this.#meta.columnTruncated(columnLimitValue);
		this.#pushTruncationMetaFacts(columnLimitValue);
		return this;
	}

	/**
	 * Bash's escape hatch: the same declaration as
	 * {@link truncationFact}, but for bash/eval's `OutputSink`-derived
	 * `.truncationFromSummary()` call sites instead of a `TruncationResult`.
	 * Declares a typed truncation fact (and, when `columnMax` was configured
	 * and actually trimmed a line, a co-occurring `limit`/`"column"` fact) *in
	 * addition to* the usual `.truncationFromSummary()` meta — still populated
	 * exactly as before for every consumer that already reads it (the ACP
	 * facts publisher in `bash.ts`, `spillLargeResultToArtifact`,
	 * `formatStyledTruncationWarning`). `BashTool`'s registered
	 * `modelContentProjection` renders the declared fact(s) through
	 * `renderNoticeTrail`, matching read/grep/glob's precedent — including
	 * `direction: "middle"` (bash's default spill shape, `headBytes > 0`),
	 * which `renderNoticeTrail` now renders via `renderMiddleElisionNotice`
	 * instead of declining outright.
	 */
	truncationFactFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		this.#meta.truncationFromSummary(summary, options);
		const columnTruncated = this.#meta.get()?.limits?.columnTruncated;
		this.#pushTruncationMetaFacts(columnTruncated?.maxColumn);
		return this;
	}

	/**
	 * Shared by {@link truncationFact}/{@link truncationFactFromSummary}: read
	 * `this.#meta`'s just-written `truncation`/`limits.columnTruncated` back and
	 * push the corresponding fact bodies, so both call sites derive the exact
	 * same fact shape from the exact same meta instead of two hand-written
	 * copies drifting apart. `columnLimitValue` gates the `limit`/`"column"`
	 * fact push explicitly (rather than re-reading `meta.limits.columnTruncated`
	 * unconditionally) so a caller that populated `columnTruncated` through a
	 * different path — none exists today — cannot silently gain an
	 * unintended fact.
	 */
	#pushTruncationMetaFacts(columnLimitValue: number | undefined): void {
		const truncation = this.#meta.get()?.truncation;
		if (truncation) {
			this.#pushFact(truncationFactBody(truncation));
			if (columnLimitValue) this.#pushFact(columnLimitFactBody(columnLimitValue));
		}
	}

	/**
	 * Read's escape hatch for its count-based listing caps
	 * — the archive directory listing, sqlite table list, and non-archive
	 * directory tree, the three sites that co-occur with a `resultLimit`
	 * notice `truncationFact`'s doc comment used to carve out as unmigrated.
	 * Declares a typed `limit`/`"result_count"` fact *in addition to* the
	 * usual `.limits({resultLimit})` meta (still populated exactly as
	 * before — every other `details.meta` consumer keeps reading precisely
	 * what it always has). `reached: number | undefined` (not just
	 * `undefined`-narrowed at each call site) so a call site can pass
	 * `listLimit.meta.resultLimit?.reached` directly, matching `.limits()`'s
	 * own optional-field convention; no-op when `undefined` or not positive,
	 * matching `OutputMetaBuilder.resultLimit`'s own no-op — mirrors, rather
	 * than duplicates, that builder's `suggestion = reached * 2` default by
	 * reading the value back from the meta it just wrote instead of
	 * recomputing it.
	 */
	resultLimitFact(reached: number | undefined): this {
		if (reached === undefined) return this;
		this.#meta.resultLimit(reached);
		const limit = this.#meta.get()?.limits?.resultLimit;
		if (limit) {
			this.#pushFact(resultCountLimitFactBody(limit.reached, limit.suggestion));
		}
		return this;
	}

	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		this.#meta.truncationFromSummary(summary, options);
		return this;
	}

	limits(limits: { matchLimit?: number; resultLimit?: number; headLimit?: number; columnMax?: number }): this {
		this.#meta.limits(limits);
		return this;
	}

	#pushFact(fact: ToolFactBody): void {
		this.#details.presentationFacts = [...(this.#details.presentationFacts ?? []), fact];
	}

	sourceUrl(value: string): this {
		this.#meta.sourceUrl(value);
		return this;
	}

	sourcePath(value: string): this {
		this.#meta.sourcePath(value);
		return this;
	}

	sourceInternal(value: string): this {
		this.#meta.sourceInternal(value);
		return this;
	}

	diagnostics(summary: string, messages: string[]): this {
		this.#meta.diagnostics(summary, messages);
		return this;
	}

	/** Flag the result as a non-throwing failure (agent-loop surfaces it as a tool error). */
	error(value = true): this {
		this.#isError = value;
		return this;
	}

	/** Marks the result contextually useless — compaction may elide it once consumed. */
	useless(value = true): this {
		this.#useless = value;
		return this;
	}

	done(): AgentToolResult<TDetails> {
		const meta = this.#meta.get();
		if (meta) {
			this.#details.meta = meta;
		}
		const hasDetails = Object.entries(this.#details).some(([, value]) => value !== undefined);

		return {
			content: this.#content,
			details: hasDetails ? this.#details : undefined,
			...(this.#isError ? { isError: true } : {}),
			...(this.#useless && !this.#isError ? { useless: true } : {}),
		};
	}
}

export function toolResult<TDetails extends DetailsWithMeta>(details?: TDetails): ToolResultBuilder<TDetails> {
	return new ToolResultBuilder(details);
}

/**
 * Whether a tool result represents a failure — the single derivation every
 * renderer must use.
 *
 * `outcome` is the authority when the producer set one: only the
 * producer knows whether its process timed out, exited nonzero, or was
 * interrupted, and a migrated producer is not obliged to keep the legacy
 * boolean bits consistent with it.
 *
 * The `isError`/`details.isError` branch below is a deliberate interim
 * fallback, not dead weight, for two distinct reasons:
 *
 * 1. Most producers are still unmigrated and carry no `outcome` at all.
 * 2. `outcome` is *never* persisted on the result: history stores
 *    `ToolResultMessage` (content/details/isError/useless/providerMetadata), so
 *    a replayed result has `outcome === undefined` even for a producer that
 *    sets one live — `eval` records a nonzero cell only in `details.isError`,
 *    which is exactly the asymmetry that shipped a success card in Zed for a
 *    failed `eval`.
 *
 * It goes away when every built-in carries an `outcome` and the presentation
 * journal is the only replay source; until then the fallback lives here, not
 * inlined at a call site, so a producer's failure signal reaches every renderer
 * at once.
 */
export function toolResultFailed(result: { isError?: boolean; details?: unknown; outcome?: ToolOutcome }): boolean {
	if (result.outcome !== undefined) return outcomeFailed(result.outcome);
	if (result.isError === true) return true;
	const details = result.details;
	if (typeof details !== "object" || details === null || !("isError" in details)) return false;
	return details.isError === true;
}
