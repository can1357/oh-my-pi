/**
 * The closed fact algebra.
 *
 * A "fact" is something the agent knows about a tool call that is *not* part of
 * the process byte stream: wall time, a truncation window, an artifact pointer,
 * LSP diagnostics, a model reminder. Before this boundary existed, such facts
 * were concatenated into the model-facing body and then re-derived by whichever
 * channel needed them — which is the drift class the redesign deletes.
 *
 * Two properties are load-bearing:
 *
 * 1. The union is **closed**. A new built-in fact gets its own member, so every
 *    projection and every delivery policy fails to compile until it handles it.
 * 2. Audience is **not authorable by a producer**. {@link FACT_AUDIENCE} derives
 *    it from `kind` exhaustively, so a producer cannot hide a wall-time or
 *    diagnostic fact by labelling it model-only.
 */

import type { FactId } from "./brands";

/**
 * Who a fact is delivered to.
 *
 * `"human"` arrived with its first concrete facts: the policy allows adding a
 * new audience value only when a fact actually needs it. `truncation`, `artifact` and `limit`
 * are human-only because the *model* already learns about them from the retained
 * body itself — `OutputSink` writes its middle-elision marker into the bytes it
 * retains — while a terminal-rendering client sees only what the stream carried and
 * needs them spelled out. Delivering them to the model as well would add lines that
 * are not in today's model-facing content, which the model goldens forbid.
 */
export type FactAudience = "model" | "human" | "all";

/**
 * How a retained record was cut down relative to the full stream.
 *
 * `shownLineRange`/`truncatedBy`/`maxBytes`/`nextOffset`/`artifactId` are the
 * *windowed* (non-middle) fields: a paginated head/tail reader — currently only
 * `read`'s custom model projection (the escape hatch implemented by
 * `renderTruncationWindowNotice` in coding-agent's `presentation/projections.ts`)
 * — reports an explicit shown-line window and continuation offset rather than
 * "first/last N bytes". Every other producer leaves them `undefined`; they are
 * additive and do not change `middle`-direction rendering.
 *
 * `headLineRange`/`tailLineRange` are the `direction: "middle"` counterpart: the
 * two windows a middle-eliding producer kept around the hole. A middle cut has
 * no single shown window, so it cannot reuse `shownLineRange` — and
 * `renderMiddleElisionNotice` needs both endpoints to name the retained ranges.
 * `nextOffset`/`artifactId` are shared by both shapes (a paginated `read`
 * spilled to an artifact carries all three).
 */
export interface TruncationFactMeta {
	readonly direction: "head" | "tail" | "middle";
	readonly totalBytes: number;
	readonly retainedBytes: number;
	readonly totalLines?: number;
	readonly retainedLines?: number;
	readonly elidedBytes?: number;
	readonly elidedLines?: number;
	/** The exact `[start, end]` line window shown, when a windowed (non-middle) producer tracks one. */
	readonly shownLineRange?: { readonly start: number; readonly end: number };
	/** The leading line window a `direction: "middle"` producer retained before the elided region. */
	readonly headLineRange?: { readonly start: number; readonly end: number };
	/** The trailing line window a `direction: "middle"` producer retained after the elided region. */
	readonly tailLineRange?: { readonly start: number; readonly end: number };
	/** What produced a windowed cut, for its byte-limit annotation. Unused for `direction: "middle"`. */
	readonly truncatedBy?: "lines" | "bytes";
	/** The byte budget that produced a `truncatedBy: "bytes"` window cut. */
	readonly maxBytes?: number;
	/** Continuation offset a paginated windowed reader can pass to fetch the next window. */
	readonly nextOffset?: number;
	/** Recovery pointer when the full stream was also saved as an artifact. */
	readonly artifactId?: string;
}

/**
 * A configured budget that actually dropped data.
 *
 * `limit` selects the *sentence*, not merely the number: `"column"` and
 * `"inline_bytes"` are byte/width budgets on a stream, `"result_count"` is a
 * record-count budget on a listing ("N results limit reached. Use limit=M for
 * more"). Each budget gets its own arm rather than one `"count"` arm plus a
 * producer-authored noun, because a `string` label ("results", "matches",
 * "tables") *is* producer-authored model text — the thing this algebra exists
 * to remove. `applyListLimit`'s `"match"` `limitType` (the `matchLimit`
 * meta field, "N matches limit reached") has no live built-in caller today —
 * grep's own count-based caps surface through a hand-composed string it
 * bakes directly into the body, never through `.limits({matchLimit})` — but
 * if a future producer needs it, "matches" is the *same* record-count-on-a-
 * listing budget as `result_count` above, not a distinct budget kind: the
 * noun is composed by that producer's own registered `modelContentProjection`
 * (see `presentation/projections.ts`'s shared `renderNoticeTrail`), never
 * carried on the fact.
 */
export type LimitFactMeta =
	| {
			readonly limit: "column" | "inline_bytes";
			readonly value: number;
			readonly droppedBytes?: number;
			readonly affectedLines?: number;
	  }
	/**
	 * A listing that stopped after `value` records. `suggestedValue` is the
	 * larger budget the producer offers as a retry hint — *carried*, never
	 * recomputed by a projection from `value`, so the rendered "Use limit=M"
	 * cannot disagree with the budget the producer would actually honour if the
	 * caller took the hint.
	 */
	| { readonly limit: "result_count"; readonly value: number; readonly suggestedValue: number }
	/**
	 * A retained-record display-item budget (`LiveToolPresentationRecord`'s
	 * item-count cap on `ToolPresentationRecord.displays`) that dropped one or
	 * more `display_output` items entirely — unlike stream `truncation`, a
	 * dropped display has no partial/head-window form to keep, so this is the
	 * only structural signal that the item existed at all.
	 */
	| { readonly limit: "display_count"; readonly value: number; readonly droppedItems: number }
	/**
	 * The same retained-record budget's serialized-byte cap. Reported
	 * separately from `display_count` (mirroring `column`/`inline_bytes`'s own
	 * split) because either cap can trip independently — a single oversized
	 * display trips only this one, many small displays trip only the count.
	 */
	| { readonly limit: "display_bytes"; readonly value: number; readonly droppedBytes: number };

/** One diagnostic attributed to a path. */
export interface DiagnosticFactEntry {
	readonly path: string;
	readonly severity: "error" | "warning" | "info" | "hint";
	readonly message: string;
	readonly line?: number;
	readonly column?: number;
}

/** The payload half of a {@link ToolFact}, without its identity. */
export type ToolFactBody =
	| { readonly kind: "wall_time"; readonly ms: number }
	| { readonly kind: "truncation"; readonly meta: TruncationFactMeta }
	| { readonly kind: "limit"; readonly meta: LimitFactMeta }
	| { readonly kind: "diagnostics"; readonly entries: readonly DiagnosticFactEntry[] }
	| { readonly kind: "artifact"; readonly artifactId: string }
	| { readonly kind: "model_guidance"; readonly source: "ttsr"; readonly text: string }
	/**
	 * Why the process stopped before running to completion — a timeout, a kernel
	 * restart, a stdin request, a cancellation.
	 *
	 * Its own member rather than a `notice` because its **position** is contractual:
	 * `OutputSink.dump(notice)` composes this annotation onto the *head* of the
	 * retained body, so every projection has to render it as the stream's first line.
	 * An ordinary `notice` trails the body. One `notice` kind cannot have two
	 * positions, and inferring the position from the text would be exactly the
	 * string-parsing this design deletes.
	 */
	| { readonly kind: "stop_annotation"; readonly text: string }
	/**
	 * A requested capability the host environment could not honour (e.g. `pty:
	 * true` with no interactive UI attached), stated as its own member rather
	 * than folded into a tool's model-facing body text.
	 *
	 * `"all"` audience: on every path that declares this fact *and reports it in
	 * the tool's own model-facing result* (a normal completion or a timeout —
	 * bash's success/timeout body includes the same wording today), the model must
	 * see it too, or the structured fact and the producer's own bytes disagree
	 * about what the model was told. A path whose result body does not carry it
	 * (cancellation throws a message that never included it) must not declare
	 * *this* member — it declares {@link ToolFactBody}'s `unreported_annotation`
	 * instead, so the distinction lives in which kind was published, never in a
	 * producer-authored audience override.
	 */
	| { readonly kind: "capability_notice"; readonly text: string }
	/**
	 * An annotation whose information a terminal-rendering client needs but the
	 * call's own model-facing result text structurally does not carry — today,
	 * bash's thrown cancellation message never includes trailing notices (the
	 * timeout-clamp notice, the pty-fallback notice), unlike its returned
	 * success/timeout result bodies. `"human"` audience: declaring the same text
	 * as an `"all"`-audience `notice`/`capability_notice` on this path would show
	 * the model a line its own thrown text never had, which is the exact
	 * projection/producer divergence this algebra exists to make unrepresentable.
	 * Once §3.3 gives bash a real model-content projection instead of a hand-thrown
	 * string, every path can declare the ordinary `"all"` members and this member
	 * stops being needed for bash specifically.
	 */
	| { readonly kind: "unreported_annotation"; readonly text: string }
	/**
	 * Escape hatch for an annotation with no structured member yet (and the
	 * normalization target for unknown external/legacy annotations). A built-in
	 * reaching for this in review needs an explicit justification: the whole
	 * point of the union is that a recurring fact gets its own member.
	 */
	| { readonly kind: "notice"; readonly text: string };

/** A fact with stable identity. Receipts and tests refer to `id`, never to rendered text. */
export type ToolFact = { readonly id: FactId } & ToolFactBody;

/** Discriminant of {@link ToolFactBody}. */
export type ToolFactKind = ToolFactBody["kind"];

/**
 * The single audience policy table.
 *
 * `model_guidance` is `"all"` during the migration on purpose: TTSR guidance is
 * prepended to the actual result content today, so it is already visible to
 * ACP/TUI consumers. Narrowing it to `"model"` is a separate product change
 * after auditing those clients.
 *
 * `truncation`/`artifact`/`limit` are `"human"`: today's model-facing body carries
 * the elision marker the sink wrote into the retained bytes and nothing else, so
 * projecting these to the model would invent lines that are not in the current
 * content. The human surfaces genuinely need them — a terminal-rendering client
 * receives only what the byte stream carried.
 *
 * `read`'s non-`middle` truncation and its `limit`/`"result_count"` notices are
 * the one case where the model-facing body genuinely needs this "human" fact,
 * because read writes no elision marker into the retained bytes itself — the
 * trailing notice text *is* the model's only signal. Rather than widen this
 * table (which would apply globally, silently, to every future producer of
 * these kinds), read composes the exception locally in its own registered
 * projection (`renderNoticeTrail` in coding-agent's
 * `presentation/projections.ts`, its escape hatch for this case) — the audience
 * policy below stays `"human"` for both kinds, unchanged.
 */
export const FACT_AUDIENCE = {
	wall_time: "all",
	truncation: "human",
	limit: "human",
	diagnostics: "all",
	artifact: "human",
	model_guidance: "all",
	stop_annotation: "all",
	capability_notice: "all",
	unreported_annotation: "human",
	notice: "all",
} as const satisfies Record<ToolFactKind, FactAudience>;

/** Audience of a fact, derived from its kind alone. */
export function factAudience(kind: ToolFactKind): FactAudience {
	return FACT_AUDIENCE[kind];
}
