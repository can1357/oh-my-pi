import type {
	LimitFactMeta,
	PresentationSeverity,
	ToolCallPresentation,
	ToolDisplayOutput,
	ToolFact,
	ToolFactBody,
	ToolFactKind,
	ToolOutcome,
	ToolPresentationRecord,
	TruncationFactMeta,
} from "@oh-my-pi/pi-agent-core/presentation";
import { factAudience, outcomeExitCode, presentationSeverity } from "@oh-my-pi/pi-agent-core/presentation";
import { formatBytes } from "@oh-my-pi/pi-utils/format";
import type { PresentationContentBlock } from "./schemas/content";

/**
 * Total projections of one structured presentation.
 *
 * The governing rule: **the model-facing body is not authorable by a
 * tool.** One structure feeds several projections that share formatting
 * primitives but are not forced to be byte-identical, because their contracts
 * differ — model content is bounded for context, a TUI may render a rich diff, an
 * ACP terminal is append-only.
 *
 * Every projection here is exhaustive over the closed fact union, so a new fact
 * variant fails to compile until each audience decides what to do with it. There
 * is no `bodyOverride: string` and no notice-stripping: nothing in this file
 * parses a rendered string back.
 */

/** Everything a projection is allowed to read. */
export interface ToolPresentationView {
	readonly call: ToolCallPresentation;
	readonly outcome: ToolOutcome;
	readonly presentation: ToolPresentationRecord;
}

/**
 * Where a fact sits relative to the stream body.
 *
 * Three positions, each pinned to how the pre-refactor producers actually composed
 * their model-facing text — these are not aesthetic choices, they are what keeps the
 * projection byte-identical to the content that reaches the LLM today:
 *
 * - `block` — its own leading content block. TTSR returns
 *   `{content: [{text: reminder}, ...result.content]}`, a *separate* block, so
 *   folding it into the body text would change the persisted history's shape.
 * - `head` — the first line of the body block, joined to it by a single newline.
 *   `OutputSink.dump(notice)` returns `"[notice]\n" + body`, so a stop annotation
 *   *is* the head of the retained stream.
 * - `trail` — the ordinary annotation position: a blank line after the body, then
 *   the annotations joined by single newlines (bash's `outputLines.push("", ...notices)`).
 *
 * The table is exhaustive over `ToolFactKind`, so adding a fact forces the decision.
 */
const FACT_PLACEMENT = {
	model_guidance: "block",
	stop_annotation: "head",
	wall_time: "trail",
	limit: "trail",
	notice: "trail",
	capability_notice: "trail",
	unreported_annotation: "trail",
	diagnostics: "trail",
	truncation: "trail",
	artifact: "trail",
} as const satisfies Record<ToolFactKind, "block" | "head" | "trail">;

/**
 * Relative order of trailing facts. Lower sorts earlier.
 *
 * Pinned rather than left to declaration order because the model body's byte
 * layout is golden-locked: wall time first (bash pushes it before every other
 * notice), truncation and its artifact pointer last so the "where is the rest"
 * answer is adjacent to the claim that something is missing.
 */
const TRAIL_ORDER = {
	wall_time: 0,
	notice: 1,
	capability_notice: 2,
	unreported_annotation: 3,
	limit: 4,
	diagnostics: 5,
	truncation: 6,
	artifact: 7,
	model_guidance: 8,
	stop_annotation: 9,
} as const satisfies Record<ToolFactKind, number>;

/** Body text used when a stream produced nothing at all. */
export const EMPTY_OUTPUT_PLACEHOLDER = "(no output)";

/** One rendered fact line (or block), plus the fact it came from. */
export interface RenderedFact {
	readonly factId: ToolFact["id"];
	readonly kind: ToolFactKind;
	readonly text: string;
}

/** Render one fact to its canonical single spelling. Shared by every projection. */
export function renderFact(fact: ToolFact): RenderedFact {
	return { factId: fact.id, kind: fact.kind, text: renderFactText(fact) };
}

/**
 * The canonical spelling of one fact's text, keyed off its payload alone.
 *
 * Exported over the id-less {@link ToolFactBody} for the one consumer that has
 * to render a fact it deliberately never published: the ACP reducer's
 * settlement snapshot must disclose its own retained-byte head-window cut
 * (`buildReplacementSnapshotContent` in `modes/acp/view/reducer.ts`) without
 * minting a `FactId` that could collide with a producer's — and without
 * entering `state.facts`, which would emit a content-snapshot receipt for a
 * fact that never crossed the wire. It must be *this* formatter rather than
 * {@link renderTruncationWindowNotice}: a replayed persisted record renders its
 * truncation fact through here, so any other spelling would make live and
 * replay disagree about the same cut.
 */
export function renderFactText(fact: ToolFactBody): string {
	switch (fact.kind) {
		case "wall_time":
			return `Wall time: ${(fact.ms / 1000).toFixed(2)} seconds`;
		case "truncation": {
			const { direction, totalBytes, retainedBytes, totalLines, retainedLines, elidedBytes, elidedLines } =
				fact.meta;
			if (direction === "middle") {
				const lines = elidedLines === undefined ? "" : `${elidedLines} lines, `;
				return `[Elided ${lines}${formatBytes(elidedBytes ?? Math.max(0, totalBytes - retainedBytes))} from the middle of ${formatBytes(totalBytes)}]`;
			}
			if (totalLines !== undefined && retainedLines !== undefined) {
				const start = direction === "tail" ? totalLines - retainedLines + 1 : 1;
				const end = direction === "tail" ? totalLines : retainedLines;
				return `[Showing lines ${start}-${end} of ${totalLines}]`;
			}
			const shown = direction === "tail" ? "last" : "first";
			return `[Showing ${shown} ${formatBytes(retainedBytes)} of ${formatBytes(totalBytes)}]`;
		}
		case "limit":
			return limitFactText(fact.meta);
		case "diagnostics": {
			const lines = fact.entries.map(entry => {
				const at =
					entry.line === undefined ? "" : `:${entry.line}${entry.column === undefined ? "" : `:${entry.column}`}`;
				return `${entry.path}${at}: ${entry.severity}: ${entry.message}`;
			});
			return lines.join("\n");
		}
		case "artifact":
			return `[raw output: artifact://${fact.artifactId}]`;
		case "model_guidance":
			return fact.text;
		case "stop_annotation":
			return fact.text;
		case "notice":
			return fact.text;
		case "capability_notice":
			return fact.text;
		case "unreported_annotation":
			return fact.text;
	}
}

/** Single canonical spelling per {@link LimitFactMeta} discriminant, shared by {@link renderFactText}. */
function limitFactText(meta: LimitFactMeta): string {
	switch (meta.limit) {
		case "column":
			return `[Lines wider than ${meta.value} bytes were truncated]`;
		case "inline_bytes":
			return `[Inline output capped at ${formatBytes(meta.value)}]`;
		case "result_count":
			return `[${meta.value} results limit reached. Use limit=${meta.suggestedValue} for more]`;
		case "display_count":
			return `[${meta.droppedItems} display${meta.droppedItems === 1 ? "" : "s"} dropped: item limit of ${meta.value} reached]`;
		case "display_bytes":
			return `[Display output dropped: ${formatBytes(meta.droppedBytes)} over the ${formatBytes(meta.value)} budget]`;
	}
}

/**
 * The non-`middle` truncation notice, formatted from a {@link TruncationFactMeta}
 * window.
 *
 * Extracted so `output-meta.ts`'s legacy `formatTruncationMetaNotice` (every
 * still-unmigrated call site) and this file's typed model projection
 * (`renderNoticeTrail` below, an escape hatch) share one formatter —
 * two spellings of "showing lines A-B of N" would drift the instant either
 * one changed. `renderFactText`'s generic `"truncation"` case above intentionally
 * uses a *different* one-fact-per-bracket spelling (used only by the
 * exhaustive `renderModelContent`/`renderTuiPresentation`, whose audience
 * table forbids the model from seeing this kind at all); this formatter
 * reproduces the pre-migration producers' single joined-bracket spelling
 * instead, because that is the byte layout the model goldens lock in.
 */
export function renderTruncationWindowNotice(meta: TruncationFactMeta): string {
	if (meta.direction === "middle") {
		throw new Error('renderTruncationWindowNotice does not handle direction: "middle"');
	}
	let notice: string;
	const range = meta.shownLineRange;
	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${meta.totalLines}`;
	} else {
		notice = `Showing ${meta.retainedLines} of ${meta.totalLines} lines`;
	}
	if (meta.truncatedBy === "bytes") {
		notice += ` (${formatBytes(meta.maxBytes ?? meta.retainedBytes)} limit)`;
	}
	if (meta.nextOffset != null) {
		notice += `. Use :${meta.nextOffset} to continue`;
	}
	if (meta.artifactId != null) {
		notice += `. Read artifact://${meta.artifactId} for full output`;
	}
	return notice;
}

/**
 * The `direction: "middle"` truncation notice, formatted from a
 * {@link TruncationFactMeta} head+tail retention.
 *
 * Reproduces `output-meta.ts`'s legacy `formatTruncationMetaNotice` middle
 * branch byte-for-byte, for the same reason {@link renderTruncationWindowNotice}
 * exists: one formatter shared by the legacy composition and this file's typed
 * model projection (`renderNoticeTrail` below), so "showing lines A-B and C-D
 * of N; K middle lines elided" cannot drift into two spellings. Distinct from
 * `renderTruncationWindowNotice` rather than a shared branch inside it, because
 * the sentence shape is structurally different (two retained windows plus an
 * elided-count clause, not one shown window plus an optional byte-limit
 * suffix) — a middle producer never sets `truncatedBy`/`shownLineRange`.
 *
 * Returns `undefined` when `totalLines`/`retainedLines` are both absent — the
 * one case the legacy formatter could not have produced either, since
 * `TruncationMeta.totalLines`/`.outputLines` are non-optional there. A
 * producer that never tracked line counts (only bytes) has nothing this
 * sentence can report; the caller falls back to the generic composition.
 */
export function renderMiddleElisionNotice(meta: TruncationFactMeta): string | undefined {
	if (meta.direction !== "middle") {
		throw new Error('renderMiddleElisionNotice only handles direction: "middle"');
	}
	const { totalLines, retainedLines } = meta;
	if (totalLines === undefined || retainedLines === undefined) return undefined;

	const elidedBytes = meta.elidedBytes ?? Math.max(0, meta.totalBytes - meta.retainedBytes);
	const elidedLines = meta.elidedLines ?? Math.max(0, totalLines - retainedLines);
	const head = meta.headLineRange;
	const tail = meta.tailLineRange;
	const headPart = head ? `lines ${head.start}-${head.end}` : "";
	const tailPart = tail ? `${tail.start}-${tail.end}` : "";

	let notice: string;
	if (headPart && tailPart) {
		notice = `Showing ${headPart} and ${tailPart} of ${totalLines}; ${elidedLines.toLocaleString()} middle line${elidedLines === 1 ? "" : "s"} (${formatBytes(elidedBytes)}) elided`;
	} else {
		notice = `Showing ${retainedLines} of ${totalLines} lines; middle elided`;
	}
	if (meta.nextOffset != null) {
		notice += `. Use :${meta.nextOffset} to continue`;
	}
	if (meta.artifactId != null) {
		notice += `. Read artifact://${meta.artifactId} for full output`;
	}
	return notice;
}

/**
 * The shared typed custom model projection for head/tail truncation, middle
 * elision, and the count-based result limit (an escape hatch: "a
 * typed custom projection registered on the tool contract... receives the
 * complete presentation structure and cannot bypass fact threading").
 *
 * Takes fact **bodies** (no identity — a synchronous tool holds no scoped
 * producer; see `ToolResultBuilder.truncationFact`'s doc comment) and returns
 * only the trailing annotation text to append, never a replacement content
 * array: `wrappedExecute` (in `tools/output-meta.ts`) owns placement via the
 * same `appendTrailingText` the legacy path uses, so this function
 * structurally cannot delete or replace the body — it can only ever add a
 * trail derived from the facts it was given.
 *
 * Registered by `read`, `grep`, `glob`, `bash`, and `eval` (each as their own
 * `modelContentProjection`, a per-tool escape hatch — one shared
 * formatter, not five near-identical copies, because the byte layout below
 * is golden-locked and a second hand-written copy is a second place for it to
 * drift). head/tail truncation and the `limit`/`"result_count"` listing cap
 * (read's archive directory listing, sqlite table list, directory tree; grep
 * and glob's own result caps) write no elision marker into the retained
 * bytes — the trailing notice this function composes is the model's *only*
 * signal for either, which is why these call sites earn the escape hatch
 * instead of a `FACT_AUDIENCE` change (which would apply to every future
 * fact of these kinds, silently, with no per-producer review). A
 * middle-eliding producer's retained bytes already carry `OutputSink`'s own
 * `[…Nln elided…]` marker, so `FACT_AUDIENCE`'s global `"human"`-only default
 * for `truncation` stays unchanged even though this function now renders it
 * too: this is the *trailing* notice bash/read/eval's legacy
 * `formatTruncationMetaNotice` middle branch already appended to the model
 * body — a distinct sentence from the in-body marker, not a duplicate of it.
 *
 * The `limit`/`"column"` fact (when present) is the *same* structural fact
 * bash/eval already declare for their own per-line cap — one structure, many
 * projections, "not forced to be byte-identical" (this file's own doc comment
 * above). This projection renders it with the tools' own historical wording
 * (`"Some lines truncated to N chars"`) rather than the generic `renderFactText`
 * spelling (`"Lines wider than N bytes were truncated"`), because that generic
 * spelling is bash/eval's own byte-locked history, not read/grep/glob's.
 * Likewise `limit`/`"result_count"` renders with the historical
 * `"N results limit reached. Use limit=M for more"` wording, matching
 * `formatOutputNotice`'s pre-migration bracket byte-for-byte, joined into the
 * *same* bracket as the truncation part when both co-occur, in the same
 * truncation → result-count → column order `formatOutputNotice` used.
 *
 * There is no `matchLimit`-flavored arm: `result_count`'s wording ("N results
 * limit reached") is composed here, by the projection, not baked into the
 * fact — and no built-in tool actually produces a `matchLimit` notice today
 * (`applyListLimit`'s `limitType: "match"` branch has no live caller; grep's
 * own match-count caps surface as a hand-composed `limitMessage` string baked
 * directly into the body, never through `OutputMetaBuilder.matchLimit`/
 * `.limits({matchLimit})`, so there is nothing here to migrate). If a future
 * producer needs the "N matches limit reached" wording, it is a projection
 * choice on that producer's own registered `modelContentProjection`, not a
 * new `LimitFactMeta` arm — the fact already carries a bare `value`, and the
 * noun belongs to the projection, per this file's `LimitFactMeta` docstring.
 *
 * Returns `undefined` when `facts` contains neither a truncation fact that
 * rendered a notice nor a `result_count` limit fact (nothing for the wrapper
 * to append — a lone `column` limit fact stays on the legacy path, matching
 * the pre-013 precedent), or when a middle-elision truncation fact carries
 * neither `totalLines` nor `retainedLines` (see
 * {@link renderMiddleElisionNotice}'s doc comment: the one shape the legacy
 * formatter could never have produced either, so there is nothing to render
 * identically and the wrapper falls back to the generic composition).
 */
export function renderNoticeTrail(facts: readonly ToolFactBody[]): string | undefined {
	const truncation = facts.find((fact): fact is ToolFactBody & { kind: "truncation" } => fact.kind === "truncation");
	const truncationNotice = truncation
		? truncation.meta.direction === "middle"
			? renderMiddleElisionNotice(truncation.meta)
			: renderTruncationWindowNotice(truncation.meta)
		: undefined;
	if (truncation && truncationNotice === undefined) return undefined;
	const limits = facts.filter((fact): fact is ToolFactBody & { kind: "limit" } => fact.kind === "limit");
	const resultCountLimit = limits.find(
		(fact): fact is ToolFactBody & { kind: "limit"; meta: LimitFactMeta & { limit: "result_count" } } =>
			fact.meta.limit === "result_count",
	);
	const columnLimit = limits.find(fact => fact.meta.limit === "column");
	if (!truncationNotice && !resultCountLimit) return undefined;
	const parts: string[] = [];
	if (truncationNotice) parts.push(truncationNotice);
	if (resultCountLimit) {
		parts.push(
			`${resultCountLimit.meta.value} results limit reached. Use limit=${resultCountLimit.meta.suggestedValue} for more`,
		);
	}
	if (columnLimit) parts.push(`Some lines truncated to ${columnLimit.meta.value} chars`);
	return `\n\n[${parts.join(". ")}]`;
}

/** Exit-code annotation derived from the outcome — never from a fact that could drift. */
export function renderExitNotice(outcome: ToolOutcome): string | undefined {
	if (outcome.kind === "succeeded") return undefined;
	const code = outcomeExitCode(outcome);
	return code === undefined ? undefined : `Command exited with code ${code}`;
}

/** Facts split by their pinned placement, with `trail` in its contractual order. */
interface PartitionedFacts {
	/** Own leading content blocks (TTSR guidance). */
	readonly blocks: readonly RenderedFact[];
	/** First line(s) of the body block (`OutputSink.dump()`'s annotation). */
	readonly head: readonly RenderedFact[];
	/** Annotations after the body. */
	readonly trail: readonly RenderedFact[];
}

function partitionFacts(facts: readonly ToolFact[]): PartitionedFacts {
	const blocks: RenderedFact[] = [];
	const head: RenderedFact[] = [];
	const trail: RenderedFact[] = [];
	for (const fact of facts) {
		const rendered = renderFact(fact);
		switch (FACT_PLACEMENT[fact.kind]) {
			case "block":
				blocks.push(rendered);
				break;
			case "head":
				head.push(rendered);
				break;
			case "trail":
				trail.push(rendered);
				break;
		}
	}
	trail.sort((a, b) => TRAIL_ORDER[a.kind] - TRAIL_ORDER[b.kind]);
	return { blocks, head, trail };
}

/**
 * The body block: head annotations, the stream body, trailing annotations, then the
 * derived exit notice.
 *
 * Shared by the model and plain-ACP projections because both reproduce the same
 * composition the producers performed by hand — one newline between a head
 * annotation and the body (`dump()`), a blank line before the trailing block, single
 * newlines within it.
 */
function composeBodyBlock(parts: PartitionedFacts, body: string, exitNotice: string | undefined): string | undefined {
	const headed = [...parts.head.map(fact => fact.text).filter(text => text.length > 0), body].join("\n");
	const sections: string[] = [headed];
	const trailing = parts.trail.map(fact => fact.text).filter(text => text.length > 0);
	if (trailing.length > 0) sections.push(trailing.join("\n"));
	if (exitNotice !== undefined) sections.push(exitNotice);
	return sections.join("\n\n");
}

/** Facts this audience receives, derived from kind alone. */
export function factsFor(facts: readonly ToolFact[], audience: "model" | "human"): readonly ToolFact[] {
	return facts.filter(fact => {
		const policy = factAudience(fact.kind);
		return policy === "all" || policy === audience;
	});
}

/** Stream body as the model sees it, with the empty-stream placeholder applied. */
export function renderStreamBody(record: ToolPresentationRecord): string {
	const text = record.stream?.text ?? "";
	return text.length > 0 ? text : EMPTY_OUTPUT_PLACEHOLDER;
}

/**
 * The model-facing content blocks.
 *
 * Byte layout is contractual and golden-locked
 * (`test/presentation-model-goldens.test.ts`), and the goldens are the *current*
 * producer bytes rather than whatever this function happens to emit: guidance is its
 * own leading block, a stop annotation is the body's first line, the trailing
 * annotation block follows a blank line, and the derived exit notice comes last.
 * Only facts whose audience includes the model appear — truncation/artifact/limit do
 * not, because the retained body already carries the sink's own elision marker and
 * adding them would insert lines today's model content does not have.
 *
 * No production caller wires this into the agent loop yet: the "model
 * sees only audience-eligible facts" projection guarantee is enforced by
 * `test/presentation-model-goldens.test.ts` (byte-exact golden lock) and
 * `test/presentation-model-parity.test.ts` (proves those goldens match what
 * a real producer actually sends the model today), not by construction —
 * see "Enforced invariants" in `docs/acp-development.md`. A later phase lands
 * the atomic golden-locked cutover that wires a real caller; do not add one
 * here.
 */
export function renderModelContent(view: ToolPresentationView): readonly PresentationContentBlock[] {
	const parts = partitionFacts(factsFor(view.presentation.facts, "model"));
	const blocks: PresentationContentBlock[] = [];
	for (const fact of parts.blocks) {
		if (fact.text.length > 0) blocks.push({ type: "text", text: fact.text });
	}
	const body = composeBodyBlock(parts, renderStreamBody(view.presentation), renderExitNotice(view.outcome));
	if (body !== undefined) blocks.push({ type: "text", text: body });
	for (const attachment of view.presentation.attachments) {
		if (attachment.kind === "image") {
			blocks.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
		}
	}
	return blocks;
}

/** One line of a TUI presentation, tagged with the role a renderer styles it by. */
export interface TuiPresentationLine {
	readonly role: "body" | "fact" | "status";
	readonly text: string;
}

/**
 * The TUI projection.
 *
 * Deliberately *not* byte-identical to the model projection: a card shows facts
 * as styled footer rows rather than as body text, which is why the old code had
 * to strip its own notices back out of the body (`stripOutputNotice` and
 * friends). Here the body never contained them.
 */
export function renderTuiPresentation(view: ToolPresentationView): {
	readonly severity: PresentationSeverity;
	readonly lines: readonly TuiPresentationLine[];
} {
	const parts = partitionFacts(factsFor(view.presentation.facts, "human"));
	const lines: TuiPresentationLine[] = [];
	for (const fact of [...parts.blocks, ...parts.head]) lines.push({ role: "fact", text: fact.text });
	const body = view.presentation.stream?.text ?? "";
	if (body.length > 0) lines.push({ role: "body", text: body });
	for (const fact of parts.trail) {
		if (fact.text.length > 0) lines.push({ role: "fact", text: fact.text });
	}
	const exitNotice = renderExitNotice(view.outcome);
	if (exitNotice !== undefined) lines.push({ role: "status", text: exitNotice });
	return { severity: presentationSeverity(view.outcome), lines };
}

/**
 * The plain-content ACP projection, for a client with no terminal capability at
 * all.
 *
 * Fenced because a Markdown renderer would otherwise mangle raw command output.
 * Facts are their own block: an append-only terminal cannot receive them
 * retroactively, so on this channel they ride as visible text instead.
 */
export function renderAcpPlainContent(view: ToolPresentationView, options: { readonly fence: boolean }): string {
	const parts = partitionFacts(factsFor(view.presentation.facts, "human"));
	const sections: string[] = [];
	for (const fact of parts.blocks) sections.push(fact.text);
	// The fence wraps the process bytes only; a head annotation is the agent's own
	// line and stays outside it, where a Markdown renderer shows it as text.
	for (const fact of parts.head) sections.push(fact.text);
	sections.push(options.fence ? fenceBlock(renderStreamBody(view.presentation)) : renderStreamBody(view.presentation));
	const trailing = parts.trail.map(fact => fact.text).filter(text => text.length > 0);
	if (trailing.length > 0) sections.push(trailing.join("\n"));
	const exitNotice = renderExitNotice(view.outcome);
	if (exitNotice !== undefined) sections.push(exitNotice);
	return sections.join("\n\n");
}

/**
 * Wrap text in a Markdown fenced code block, widening the fence past any run of
 * backticks already present so a command's own ``` output cannot close it early.
 *
 * A closing fence may be indented up to three spaces (CommonMark), so an indented
 * run closes the block just as a flush one does — hence the line-anchored scan
 * rather than a naive search for any backtick run.
 *
 * This is the canonical implementation; `acp-event-mapper.ts`'s `fenceCodeBlock`
 * delegates here so the legacy and reducer paths cannot drift while both exist.
 */
export function fenceBlock(text: string): string {
	let fence = "```";
	for (const match of text.matchAll(/^ {0,3}`{3,}/gm)) {
		const run = match[0].trimStart();
		while (run.length >= fence.length) fence += "`";
	}
	return `${fence}\n${text}\n${fence}`;
}

/** Cap per display JSON value sent back to the model. */
const MAX_DISPLAY_TEXT_BYTES = 8000;

/**
 * The one renderer for structured display output. The producer declares a
 * `ToolDisplayOutput` (a closed union of JSON value, image note, etc.); this
 * function projects it to text. The producer never formats the text itself,
 * so the projection and the producer cannot drift.
 */
export function renderDisplayOutput(display: ToolDisplayOutput): string {
	const rendered: string[] = [];
	let jsonIndex = 0;
	let imageIndex = 0;
	for (const item of display.items) {
		switch (item.kind) {
			case "json": {
				jsonIndex++;
				let text: string;
				try {
					text = JSON.stringify(item.value, null, 2) ?? String(item.value);
				} catch {
					text = String(item.value);
				}
				if (text.length > MAX_DISPLAY_TEXT_BYTES) {
					text = `${text.slice(0, MAX_DISPLAY_TEXT_BYTES)}\n[…${text.length - MAX_DISPLAY_TEXT_BYTES}ch elided…]`;
				}
				rendered.push(`display[${jsonIndex}]:\n${text}`);
				break;
			}
			case "invalid_json":
				jsonIndex++;
				rendered.push(`display[${jsonIndex}]:\n[unavailable: non-JSON display value]`);
				break;
			case "image_dimensions": {
				imageIndex++;
				const scale = item.originalWidth / item.width;
				rendered.push(
					`display image ${imageIndex}: [Image: original ${item.originalWidth}x${item.originalHeight}, displayed at ${item.width}x${item.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
				);
				break;
			}
			default: {
				const exhaustive: never = item;
				throw new Error(`Unhandled display item: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return rendered.join("\n\n");
}

/** One position in the ordered process/display timeline. */
export type ToolOutputSegment =
	| { readonly kind: "process"; readonly text: string }
	| { readonly kind: "display"; readonly display: ToolDisplayOutput };

/**
 * Render the ordered process/display timeline shared by model content and ACP.
 * Process bytes remain verbatim; projection-owned boundaries guarantee a blank
 * line between independently rendered process and display groups without tools
 * emitting synthetic byte-stream chunks.
 */
export function renderToolOutputSegments(segments: readonly ToolOutputSegment[]): string {
	let rendered = "";
	for (const segment of segments) {
		const text = segment.kind === "process" ? segment.text : renderDisplayOutput(segment.display);
		if (text.length === 0) continue;
		if (rendered.length > 0) rendered += outputSegmentSeparator(rendered);
		rendered += text;
	}
	return rendered;
}

/** The projection-owned layout boundary between ordered output groups. */
export function outputSegmentSeparator(previous: string): string {
	return previous.endsWith("\n\n") ? "" : previous.endsWith("\n") ? "\n" : "\n\n";
}
