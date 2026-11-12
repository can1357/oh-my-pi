/**
 * Tool hooks of the Spotlight experiment: `read`, `bash` and `eval` pass their model-facing text through shaping
 * themselves, and every other tool's result passes through it when the agent's call returns
 * ({@link shapeCalledTool}, from the tool wrapper); each journals one `spotlight:shape` entry per result. Only the
 * tools `spotlight.experiment.tools` names are shaped and journaled. Shaping never fails a tool call: any error keeps
 * the unshaped text.
 *
 * A random share of the results shaping would cut is held out (`spotlight.experiment.holdout`): the model gets the
 * plain result for the call, and the trace (`holdout: true`) records the would-be cut. Of the rest, a random share
 * (`spotlight.experiment.scoreFree`) is shaped without Spotlight by the no-score rules (`scoreFree: true`). Every
 * trace sizes the plain result (`plainChars`, `plainTokens`); savings count against it.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import {
	encodeHeat,
	keptRanges,
	SPOTLIGHT_VIEW_LINES,
	type SpotlightDetails,
	type SpotlightOriginal,
	type SpotlightWindow,
} from "@oh-my-pi/pi-tui/chat/spotlight";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { buildCallContext, callSummary } from "./context";
import { RecordingScorer, SCORE_FREE_SCORER } from "./scorer";
import { SpotlightExperiment } from "./session";
import { countTokens, noteCall, type ShapedBlock, shapeBlock, syncSeen, traceUnchanged } from "./shape";
import {
	type ShapedLines,
	type ShapedTool,
	type ShapeInput,
	type ShapeOutcome,
	SPOTLIGHT_ENTRY,
	SPOTLIGHT_FULL_OUTPUT_MAX_BYTES,
	shapesItself,
} from "./types";

/** One tool result to shape, and the command/code/`read <path>` that produced it. */
export interface ShapeRequest extends Omit<ShapeInput, "cwd"> {
	source: string;
	/**
	 * The plain model-facing text for the same call, notices included (a spilled bash output's capped text, a read's
	 * page): what savings count against. Defaults to `text`.
	 */
	plain?: string;
	/** Whether `plain`'s lines were cut to the sink's column cap: a short cut may then be longer than `plain`. */
	plainWidthCut?: boolean;
}

/** Whether the experiment replaces pi's own read summarizer and bash minimizer: whenever it is on, for every tool. */
export function nativeShapingOff(session: Pick<ToolSession, "spotlight">): boolean {
	return session.spotlight !== undefined;
}

/**
 * Whether the experiment rewrites `tool`'s output (the tools `spotlight.experiment.tools` names): a `read` without a
 * selector then pages the whole file, as the summarizer it replaces would have seen it, and shaping cuts it down.
 */
export function shapesOutput(session: Pick<ToolSession, "spotlight">, tool: ShapedTool): boolean {
	return shapingExperiment(session)?.shapesTool(tool) === true;
}

/** The session's experiment when it shapes tool output, with the state shaping needs. */
export function shapingExperiment(session: Pick<ToolSession, "spotlight">): SpotlightExperiment | undefined {
	return session.spotlight instanceof SpotlightExperiment ? session.spotlight : undefined;
}

/** A result's text after shaping, and the trace its details keep (`details.spotlight`). */
export interface ShapedText {
	text: string;
	/**
	 * Set when the experiment shapes the tool, changed or not. When `text` is the unshaped input (kept, held out,
	 * capped), the caller shows the model the plain result.
	 */
	spotlight?: SpotlightDetails;
}

/**
 * Shapes one tool result's text and journals it: {@link shapeToolBlocks} with the whole text as its one block. The
 * text is unchanged without the experiment, for a tool it does not shape, when shaping keeps it, and when shaping
 * fails.
 */
export async function shapeToolText(
	session: ToolSession,
	toolCallId: string,
	request: ShapeRequest,
	signal?: AbortSignal,
): Promise<ShapedText> {
	const { tool, source, command, ...block } = request;
	const shaped = await shapeToolBlocks(session, toolCallId, { tool, source, command }, [block], [0], signal);
	return { text: shaped.texts[0] ?? request.text, spotlight: shaped.spotlight };
}

/** What a call's blocks share: the tool, and the command/code/`read <path>` that produced them. */
export type ShapeCall = Pick<ShapeRequest, "tool" | "source" | "command">;

/** One block of a call's text: the call's whole text, or one part of a `;`/`,` path `read`. */
export type ShapeBlockRequest = Omit<ShapeRequest, "tool" | "source" | "command">;

/**
 * Where a call's blocks sit in the text the model gets: literal text of the call's own (a path list's notes and the
 * blank lines between its parts) and block indexes, concatenated in order.
 */
export type ShapeLayout = readonly (string | number)[];

/** A call's blocks after shaping, and the call's trace. */
export interface ShapedBlocks {
	/** Per block, its cut when the model gets it; undefined for a block the model gets plain (kept, held out, capped). */
	texts: (string | undefined)[];
	/** Set when the experiment shapes the tool, changed or not. */
	spotlight?: SpotlightDetails;
}

/**
 * Shapes the blocks of one tool call's text, each on its own (a read part's file window keeps its outline, its `:raw`
 * or bounded range keeps it whole), as one call: one coin draw, one journal entry, one trace, and the session learns
 * what the call showed only once every block is shaped, so no block collapses as seen against another. The text the
 * model gets is `layout` with each block's cut, or its plain text where the block is not cut.
 *
 * The coins are drawn before shaping. When the holdout coin lands and shaping cuts a block, every block stays plain and
 * the journal entry and trace (`holdout: true`) describe the would-be cut, whose text is saved too
 * (`original.shapedUrl`); a call shaping keeps is never held out. When the score-free coin lands instead, shaping
 * runs without asking Spotlight and the entry and trace say `scoreFree: true`, changed or not.
 *
 * A block's cut saving fewer than `MIN_SAVED_TOKENS` against its plain text is never applied: the block stays plain,
 * `steps` holds `plain-cap`, and when no block is cut, `cappedChars`/`cappedTokens` size the would-be text. A short
 * cut of a block whose plain text was cut to the column cap (`plainWidthCut`) is applied anyway, and its
 * `savedTokens` is negative when it is longer than plain. A call the model gets plain has the plain text's
 * `outChars`/`outTokens`.
 *
 * A cut call's original (the blocks' read windows, else their texts, in order) is saved as a session artifact the
 * trace points at. One block's original names its window by `start`/`path`; several blocks' name theirs in
 * `windows`, each with its own rank.
 */
export async function shapeToolBlocks(
	session: ToolSession,
	toolCallId: string,
	call: ShapeCall,
	blocks: readonly ShapeBlockRequest[],
	layout: ShapeLayout,
	signal?: AbortSignal,
): Promise<ShapedBlocks> {
	const texts: (string | undefined)[] = blocks.map(() => undefined);
	const experiment = shapingExperiment(session);
	if (!experiment?.shapesTool(call.tool)) return { texts };
	experiment.claimCall(toolCallId);
	// Drawn before shaping, so held-out and score-free results are random shares of the results shaping would cut.
	const coins = experiment.drawCoins();
	const scorer = new RecordingScorer(experiment.client, experiment.thinking);
	const state = experiment.shapeState;
	const started = performance.now();
	const single = blocks.length === 1;
	const plains = blocks.map(block => block.plain ?? block.text);
	const plainTokens = blocks.map((block, i) => (plains[i] !== block.text ? countTokens(plains[i]) : undefined));
	const inputs: ShapeInput[] = blocks.map(({ plain: _plain, plainWidthCut: _widthCut, ...block }) => ({
		...block,
		tool: call.tool,
		...(call.command !== undefined ? { command: call.command } : {}),
		cwd: session.cwd,
		toolCallId,
	}));
	const outcomes: (ShapeOutcome | undefined)[] = blocks.map(() => undefined);
	const errors: string[] = [];
	const failed = (caught: unknown) => {
		const error = caught instanceof Error ? caught.message : String(caught);
		errors.push(error);
		logger.warn("spotlight: shaping failed; keeping the unshaped result", { tool: call.tool, error });
	};
	try {
		const ctx =
			session.getCallContext?.(toolCallId, call.source) ??
			buildCallContext([], toolCallId, call.source, session.getToolCallIntent?.(toolCallId));
		// What counts as seen is what is in the model's context now, whatever left it since the last result.
		const context = session.getContextMessages?.();
		if (context) syncSeen(state, context);
		noteCall(state, ctx, call.tool, call.command ?? "", toolCallId);
		const shapedBlocks: ShapedBlock[] = [];
		for (const [i, block] of blocks.entries()) {
			const tokens = plainTokens[i];
			try {
				const shaped = await shapeBlock(
					inputs[i],
					ctx,
					coins.scoreFree ? SCORE_FREE_SCORER : scorer,
					state,
					experiment.sink,
					signal,
					coins.holdout,
					tokens === undefined ? undefined : { text: plains[i], tokens, widthCut: block.plainWidthCut },
				);
				outcomes[i] = shaped.outcome;
				shapedBlocks.push(shaped);
			} catch (caught) {
				failed(caught);
			}
		}
		for (const shaped of shapedBlocks) shaped.settle();
	} catch (caught) {
		failed(caught);
	}
	const join = (parts: readonly string[]) =>
		layout.map(piece => (typeof piece === "number" ? parts[piece] : piece)).join("");
	const shapedTexts = blocks.map((block, i) => outcomes[i]?.text ?? block.text);
	const capped = outcomes.map(outcome => outcome?.capped === true);
	const cutAt = blocks.map((block, i) => shapedTexts[i] !== block.text && !capped[i]);
	const cut = cutAt.includes(true);
	const holdout = coins.holdout && cut;
	const inText = join(blocks.map(block => block.text));
	const plainText = join(plains);
	// What the model gets, or would get when held out: each cut block's cut beside the other blocks' plain text.
	const cutText = join(blocks.map((_, i) => (cutAt[i] ? shapedTexts[i] : plains[i])));
	const first = single ? outcomes[0] : undefined;
	const inTokens = first?.inTokens ?? countTokens(inText);
	const plainTokensOrIn = single
		? (plainTokens[0] ?? inTokens)
		: plainText === inText
			? inTokens
			: countTokens(plainText);
	// A kept or capped call's model got the plain text (a capped cut's own sizes go to `cappedChars`/`cappedTokens`);
	// a cut, applied or held out, is sized as cut.
	const outChars = cut ? cutText.length : plainText.length;
	const outTokens = cut ? (first?.outTokens ?? countTokens(cutText)) : plainTokensOrIn;
	const callCapped = !cut && capped.includes(true);
	const cappedText = callCapped ? join(blocks.map((_, i) => (capped[i] ? shapedTexts[i] : plains[i]))) : "";
	const steps = [...new Set(outcomes.flatMap(outcome => outcome?.steps ?? []).filter(step => step !== "none"))];
	if (!steps.length) steps.push("none");
	const stats: Record<string, number> = {};
	for (const outcome of outcomes) {
		for (const [key, value] of Object.entries(outcome?.stats ?? {})) stats[key] = (stats[key] ?? 0) + value;
	}
	const traceFields = {
		...(callCapped
			? { cappedChars: cappedText.length, cappedTokens: first?.outTokens ?? countTokens(cappedText) }
			: {}),
		...(holdout ? { holdout: true } : {}),
		...(coins.scoreFree ? { scoreFree: true } : {}),
	};
	experiment.log(SPOTLIGHT_ENTRY.shape, {
		toolCallId,
		tool: call.tool,
		steps,
		inChars: inText.length,
		outChars,
		inTokens,
		outTokens,
		ms: Math.round(performance.now() - started),
		spotlight: { ...scorer.usage, costUsd: Number(scorer.usage.costUsd.toFixed(8)) },
		stats,
		plainChars: plainText.length,
		plainTokens: plainTokensOrIn,
		...traceFields,
		...(errors.length ? { error: errors.join("; ") } : {}),
	});
	const spotlight: SpotlightDetails = {
		tool: call.tool,
		steps,
		inChars: inText.length,
		outChars,
		inTokens,
		outTokens,
		plainChars: plainText.length,
		plainTokens: plainTokensOrIn,
		// A call the model got plain (kept or capped) saves nothing; a held-out one is traced with the saving it would
		// have made. A cut longer than plain (a width-cut plain) saves negative tokens.
		savedTokens: cut ? plainTokensOrIn - outTokens : 0,
		...traceFields,
	};
	if (cut) {
		// A cut block's trace is its outcome's; a block shown plain beside it is traced as shown, unscored.
		const traces = inputs.map((input, i) => (cutAt[i] ? outcomes[i]?.lines : traceUnchanged(input, plains[i])));
		if (traces.every(trace => trace !== undefined)) {
			try {
				const shapedUrl = holdout ? await experiment.sink.save(cutText, call.tool) : undefined;
				spotlight.original = await originalOf(experiment, inputs, traces, outcomes, layout, shapedUrl);
				if (scorer.params) spotlight.request = scorer.params;
			} catch (caught) {
				logger.debug("spotlight: original not saved", { tool: call.tool, error: String(caught) });
			}
		}
	}
	if (cut && !holdout) for (const [i, cutHere] of cutAt.entries()) if (cutHere) texts[i] = shapedTexts[i];
	return { texts, spotlight };
}

/**
 * The original of a cut call: each block's read window (numbered from its first file line), else its text, in block
 * order, with the blocks' traces joined over it. `map` follows `layout`: the call's own literal lines map to nothing.
 * One block reuses the copy its cut already saved of its text.
 */
async function originalOf(
	experiment: SpotlightExperiment,
	inputs: readonly ShapeInput[],
	traces: readonly ShapedLines[],
	outcomes: readonly (ShapeOutcome | undefined)[],
	layout: ShapeLayout,
	shapedUrl: string | undefined,
): Promise<SpotlightOriginal> {
	const windows: SpotlightWindow[] = [];
	let heat = "";
	const kept: boolean[] = [];
	const why: string[] = [];
	let at = 0;
	for (const [i, trace] of traces.entries()) {
		const read = inputs[i].read;
		const lines = trace.kept.length;
		windows.push({
			at,
			lines,
			start: read?.firstLine ?? 1,
			...(read ? { path: read.path } : {}),
			...(trace.rank ? { rank: trace.rank } : {}),
			...(read && !read.selected ? { wholeFile: true as const } : {}),
		});
		heat += encodeHeat(trace.scores).padEnd(lines, "-");
		kept.push(...trace.kept);
		why.push(...trace.why);
		at += lines;
	}
	const map: (number | [number, number] | null)[] = [null];
	for (const piece of layout) {
		const entries =
			typeof piece === "number"
				? (traces[piece].map ?? []).map(entry =>
						entry === null
							? null
							: typeof entry === "number"
								? entry + windows[piece].at
								: ([entry[0] + windows[piece].at, entry[1] + windows[piece].at] as [number, number]),
					)
				: piece.split("\n").map(() => null);
		map[map.length - 1] = entries[0] ?? map[map.length - 1];
		map.push(...entries.slice(1));
	}
	const texts = inputs.map(input => (input.read ? input.read.lines.join("\n") : input.text));
	const tool = inputs[0].tool;
	const url =
		(inputs.length === 1 && !inputs[0].read && outcomes[0]?.textUrl) ||
		(await experiment.sink.save(texts.join("\n"), tool));
	const [only] = windows;
	return {
		url,
		lines: at,
		start: windows.length === 1 ? only.start : 1,
		...(windows.length === 1 ? (only.path !== undefined ? { path: only.path } : {}) : { windows }),
		heat: heat.slice(0, SPOTLIGHT_VIEW_LINES).replace(/-+$/, ""),
		kept: keptRanges(kept),
		why: why.slice(0, SPOTLIGHT_VIEW_LINES).join(""),
		...(windows.length === 1 && only.rank ? { rank: only.rank } : {}),
		map,
		...(shapedUrl ? { shapedUrl } : {}),
	};
}

/** Options of {@link shapeToolResult}. */
export interface ShapeResultOptions<TDetails> {
	/** A changed result loses its truncation notice, whose line ranges no longer match the text. */
	dropTruncation?: boolean;
	/**
	 * The result as the `plain` arm builds it, when the tool built `result` otherwise for the arm (a whole-file read
	 * gathers past `plain`'s window): the trace sizes it as `plain`, and a result not cut (kept, held out, capped) is
	 * this one. Without it, `result` is.
	 */
	plain?: () => Promise<AgentToolResult<TDetails>>;
}

/**
 * {@link shapeToolText} over a built result: shapes its text blocks (joined) and keeps its images. A result shaping
 * does not cut (kept, held out, capped) is `plain`'s result (`options.plain`, else `result` itself) with the trace;
 * savings count against that result's model-facing text, its output notice included.
 */
export async function shapeToolResult<TDetails extends { meta?: OutputMeta } | undefined>(
	session: ToolSession,
	toolCallId: string,
	request: Omit<ShapeRequest, "text">,
	result: AgentToolResult<TDetails>,
	signal?: AbortSignal,
	options?: ShapeResultOptions<TDetails>,
): Promise<AgentToolResult<TDetails>> {
	if (!shapingExperiment(session)?.shapesTool(request.tool)) return result;
	const text = joinedText(result);
	if (text === undefined) return result;
	const plain = await plainResult(result, options?.plain, request.tool);
	const plainText = (joinedText(plain) ?? "") + formatOutputNotice(plain.details?.meta);
	const shaped = await shapeToolText(session, toolCallId, { ...request, text, plain: plainText }, signal);
	if (shaped.text === text) {
		return shaped.spotlight ? { ...plain, details: withSpotlight(plain.details, shaped.spotlight) } : plain;
	}
	let details = withSpotlight(result.details, shaped.spotlight);
	if (options?.dropTruncation && details?.meta?.truncation) {
		const { truncation: _truncation, ...meta } = details.meta;
		details = { ...details, meta };
	}
	return { ...withShapedText(result, shaped.text), details };
}

/** One part of a call that joins several reads (a `;`/`,` path `read`), read but not shaped. */
export interface ShapePart<TDetails> {
	/** The part's own target as written, whether it was read with `:raw`, and its file window. */
	request: Pick<ShapeRequest, "path" | "raw" | "read">;
	/** The part as read; it has text. */
	result: AgentToolResult<TDetails>;
	/** The part as the `plain` arm reads it, when `result` was read otherwise (see {@link ShapeResultOptions.plain}). */
	plain?: () => Promise<AgentToolResult<TDetails>>;
}

/**
 * {@link shapeToolBlocks} over the parts of one call, each part's text one block placed by `layout`: each part's
 * result as the model gets it (its cut, else its plain result) and the call's trace.
 */
export async function shapeToolParts<TDetails>(
	session: ToolSession,
	toolCallId: string,
	call: ShapeCall,
	layout: ShapeLayout,
	parts: readonly ShapePart<TDetails>[],
	signal?: AbortSignal,
): Promise<{ results: AgentToolResult<TDetails>[]; spotlight?: SpotlightDetails }> {
	if (!shapingExperiment(session)?.shapesTool(call.tool)) return { results: parts.map(part => part.result) };
	const plains: AgentToolResult<TDetails>[] = [];
	for (const part of parts) plains.push(await plainResult(part.result, part.plain, call.tool));
	const blocks = parts.map((part, i) => ({
		...part.request,
		text: joinedText(part.result) ?? "",
		plain: joinedText(plains[i]) ?? "",
	}));
	const shaped = await shapeToolBlocks(session, toolCallId, call, blocks, layout, signal);
	return {
		results: parts.map((part, i) => {
			const text = shaped.texts[i];
			return text === undefined ? plains[i] : withShapedText(part.result, text);
		}),
		spotlight: shaped.spotlight,
	};
}

/** The result the `plain` arm shows for `result`: `plain()`'s, else `result`; a failing `plain()` keeps `result`. */
async function plainResult<TDetails>(
	result: AgentToolResult<TDetails>,
	plain: (() => Promise<AgentToolResult<TDetails>>) | undefined,
	tool: ShapedTool,
): Promise<AgentToolResult<TDetails>> {
	if (!plain) return result;
	try {
		return await plain();
	} catch (error) {
		// As with any shaping error, the model gets the unshaped result.
		logger.warn("spotlight: plain result failed; sizing and showing the unshaped result", {
			tool,
			error: String(error),
		});
		return result;
	}
}

/** `result` with its text blocks replaced by one block of `text`, its other blocks after it. */
function withShapedText<TDetails>(result: AgentToolResult<TDetails>, text: string): AgentToolResult<TDetails> {
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	for (const block of result.content) {
		if (block.type !== "text") content.push(block);
	}
	return { ...result, content };
}

/** One finished call the agent made to a tool that does not shape itself, as the tool wrapper hands it over. */
export interface CalledToolResult {
	/** The tool's name, as the agent called it. */
	tool: string;
	toolCallId: string;
	/** The call's arguments. */
	args: unknown;
	/** The tool's own result, before the wrapper spilled it to an artifact and appended its notices. */
	own: AgentToolResult;
	/** The model-facing result the wrapper built from {@link own}: what the `plain` arm shows. */
	result: AgentToolResult;
	signal?: AbortSignal;
}

/** Shapes the model-facing result of one of the agent's own tool calls; never throws. */
export type CalledToolShaper = (call: CalledToolResult) => Promise<AgentToolResult>;

/**
 * Shapes the result of a tool call the agent made, for every tool but those that shape themselves
 * ({@link SELF_SHAPED_TOOLS}) or are left out of `spotlight.experiment.tools`, and journals it like theirs. The
 * result's text blocks are shaped as command output, the source being the tool's name and arguments
 * ({@link callSummary}); images and other blocks stay. What `plain` shows is the wrapper's result, spill and notices
 * included. A result the wrapper spilled is shaped whole from the tool's own text, up to
 * {@link SPOTLIGHT_FULL_OUTPUT_MAX_BYTES}, and a cut of it no longer carries the spill's truncation. A result whose
 * details are not an object, or already carry a trace, is returned as is. Each call is shaped at most once.
 */
export async function shapeCalledTool(session: ToolSession, call: CalledToolResult): Promise<AgentToolResult> {
	const { tool, toolCallId, own, result } = call;
	const experiment = shapingExperiment(session);
	if (!experiment) return result;
	if (shapesItself(tool) || !experiment.shapesTool(tool)) return result;
	const details: unknown = result.details;
	if (details != null && (!isRecord(details) || details.spotlight !== undefined)) return result;
	const plain = joinedText(result);
	if (plain === undefined || !experiment.claimCall(toolCallId)) return result;
	try {
		// The wrapper spilled the tool's text when it gave the result a truncation of its own.
		const spilled = result.details?.meta?.truncation !== own.details?.meta?.truncation;
		const ownText = spilled ? (joinedText(own) ?? "") + formatOutputNotice(own.details?.meta) : undefined;
		const whole =
			ownText !== undefined && Buffer.byteLength(ownText, "utf-8") <= SPOTLIGHT_FULL_OUTPUT_MAX_BYTES
				? ownText
				: undefined;
		const text = whole ?? plain;
		const source = callSummary(tool, call.args);
		const path = isRecord(call.args) && typeof call.args.path === "string" ? call.args.path : undefined;
		const shaped = await shapeToolText(
			session,
			toolCallId,
			{ tool, text, plain, command: source, source, ...(path !== undefined ? { path } : {}) },
			call.signal,
		);
		if (shaped.text === text) {
			return shaped.spotlight ? { ...result, details: { ...result.details, spotlight: shaped.spotlight } } : result;
		}
		const cutDetails: Record<string, unknown> = { ...result.details, spotlight: shaped.spotlight };
		// Shaped from the whole text: the spill's truncation (its line ranges, its artifact) no longer describes it.
		if (whole !== undefined) {
			if (own.details?.meta) cutDetails.meta = own.details.meta;
			else delete cutDetails.meta;
		}
		return { ...result, content: withText(result.content, shaped.text), details: cutDetails };
	} catch (error) {
		logger.warn("spotlight: shaping a tool result failed; keeping it unshaped", { tool, error: String(error) });
		return result;
	}
}

/** `content` with its text blocks replaced by one block of `text`, where the first was; other blocks stay in order. */
function withText(content: readonly (TextContent | ImageContent)[], text: string): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	let placed = false;
	for (const block of content) {
		if (block.type !== "text") out.push(block);
		else if (!placed) {
			out.push({ type: "text", text });
			placed = true;
		}
	}
	return out;
}

/** A result's text blocks joined, or undefined when it has none. */
function joinedText(result: AgentToolResult<unknown>): string | undefined {
	const texts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") texts.push(block.text);
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/** `details` with the trace, when there is one. */
function withSpotlight<TDetails>(details: TDetails, spotlight: SpotlightDetails | undefined): TDetails {
	return spotlight ? ({ ...details, spotlight } as unknown as TDetails) : details;
}
