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
 *
 * Every read is traced `editLikely` or not ({@link SpotlightExperiment.noteRead}). Of the edit-likely reads not held
 * out, a random share (`spotlight.experiment.editGate`) is kept whole when shaping would cut it: the model gets the
 * plain page, and the trace (`gated: true`) records the would-be cut with no saving. Score-free is drawn after both.
 * Edits are tracked from every `edit`, `write` and `ast_edit` call the agent makes, shaped or not.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { encodeHeat, keptRanges, SPOTLIGHT_VIEW_LINES, type SpotlightDetails } from "@oh-my-pi/pi-tui/chat/spotlight";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { buildCallContext, callSummary } from "./context";
import { EDIT_TOOLS, editTargets } from "./edit-gate";
import { RecordingScorer, SCORE_FREE_SCORER } from "./scorer";
import { SpotlightExperiment } from "./session";
import { countTokens, shapeResult, syncSeen } from "./shape";
import {
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
 * Shapes one tool result's text and journals it; the text is unchanged without the experiment, for a tool it does not
 * shape, when shaping keeps it, and when shaping fails. A changed text's original is saved as a session artifact the
 * trace points at.
 *
 * The result's coins are drawn before shaping. When the holdout coin lands and shaping changes the text, the text
 * stays unchanged and the journal entry and trace (`holdout: true`) describe the would-be cut, whose text is saved too
 * (`original.shapedUrl`); a result shaping keeps is never held out. When the score-free coin lands instead, shaping
 * runs without asking Spotlight and the entry and trace say `scoreFree: true`, changed or not.
 *
 * A read the session is likely to edit is traced `editLikely: true` (any other read `false`). When the edit gate's coin
 * lands for it (drawn after the holdout coin) and shaping changes the text, the text stays unchanged like a holdout's
 * and the entry and trace say `gated: true`, with the would-be cut's sizes and no saving.
 *
 * A cut saving fewer than `MIN_SAVED_TOKENS` against the plain text is never applied (nor held out, since applying it
 * would show the plain text too): the text stays unchanged, `steps` ends with `plain-cap`, and
 * `cappedChars`/`cappedTokens` size the would-be cut. A short cut of a result whose plain text was cut to the column
 * cap (`plainWidthCut`) is applied anyway, and its `savedTokens` is negative when it is longer than plain. Every result
 * the model gets plain (kept or capped) has the plain text's `outChars`/`outTokens`.
 */
export async function shapeToolText(
	session: ToolSession,
	toolCallId: string,
	request: ShapeRequest,
	signal?: AbortSignal,
): Promise<ShapedText> {
	const experiment = shapingExperiment(session);
	if (!experiment?.shapesTool(request.tool)) return { text: request.text };
	experiment.claimCall(toolCallId);
	const editLikely = request.tool === "read" ? experiment.noteRead(request.path ?? "", session.cwd) : undefined;
	// Drawn before shaping, so held-out, gated and score-free results are random shares of the results shaping would
	// cut.
	const coins = experiment.drawCoins(editLikely === true);
	const scorer = new RecordingScorer(experiment.client, experiment.thinking);
	const started = performance.now();
	const { source, plain: plainText, plainWidthCut, ...input } = request;
	const plain = plainText ?? request.text;
	const plainTokens = plain !== request.text ? countTokens(plain) : undefined;
	let outcome: ShapeOutcome | undefined;
	let error: string | undefined;
	try {
		const ctx =
			session.getCallContext?.(toolCallId, source) ??
			buildCallContext([], toolCallId, source, session.getToolCallIntent?.(toolCallId));
		// What counts as seen is what is in the model's context now, whatever left it since the last result.
		const context = session.getContextMessages?.();
		if (context) syncSeen(experiment.shapeState, context);
		outcome = await shapeResult(
			{ ...input, cwd: session.cwd, toolCallId },
			ctx,
			coins.scoreFree ? SCORE_FREE_SCORER : scorer,
			experiment.shapeState,
			experiment.sink,
			signal,
			// A gated read, like a held-out result, shows `plain`: the cut is traced, not applied.
			coins.holdout || coins.gate,
			plainTokens === undefined ? undefined : { text: plain, tokens: plainTokens, widthCut: plainWidthCut },
		);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
		logger.warn("spotlight: shaping failed; keeping the unshaped result", { tool: request.tool, error });
	}
	const shaped = outcome?.text ?? request.text;
	const capped = outcome?.capped === true;
	const cut = shaped !== request.text && !capped;
	const holdout = coins.holdout && cut;
	const gated = coins.gate && cut;
	const text = cut && !holdout && !gated ? shaped : request.text;
	const inTokens = outcome?.inTokens ?? countTokens(request.text);
	const plainTokensOrIn = plainTokens ?? inTokens;
	// A kept or capped result's model got the plain text (a capped cut's own sizes go to `cappedChars`/`cappedTokens`);
	// a cut, applied or held out, is sized as cut.
	const outChars = cut ? shaped.length : plain.length;
	const outTokens = cut ? (outcome?.outTokens ?? inTokens) : plainTokensOrIn;
	const steps = outcome?.steps ?? ["none"];
	const traceFields = {
		...(capped ? { cappedChars: shaped.length, cappedTokens: outcome?.outTokens ?? inTokens } : {}),
		...(holdout ? { holdout: true } : {}),
		...(gated ? { gated: true } : {}),
		...(coins.scoreFree ? { scoreFree: true } : {}),
		...(editLikely !== undefined ? { editLikely } : {}),
	};
	experiment.log(SPOTLIGHT_ENTRY.shape, {
		toolCallId,
		tool: request.tool,
		steps,
		inChars: request.text.length,
		outChars,
		inTokens,
		outTokens,
		ms: Math.round(performance.now() - started),
		spotlight: { ...scorer.usage, costUsd: Number(scorer.usage.costUsd.toFixed(8)) },
		stats: outcome?.stats ?? {},
		plainChars: plain.length,
		plainTokens: plainTokensOrIn,
		...traceFields,
		...(error ? { error } : {}),
	});
	const spotlight: SpotlightDetails = {
		tool: request.tool,
		steps,
		inChars: request.text.length,
		outChars,
		inTokens,
		outTokens,
		plainChars: plain.length,
		plainTokens: plainTokensOrIn,
		// A result the model got plain (kept, capped or gated) saves nothing; a held-out one is traced with the saving
		// it would have made. A cut longer than plain (a width-cut plain) saves negative tokens.
		savedTokens: cut && !gated ? plainTokensOrIn - outTokens : 0,
		...traceFields,
	};
	const lines = outcome?.lines;
	if (lines && cut) {
		// The original is a read's window lines (numbered from its first file line), else the whole text.
		const read = request.read;
		try {
			const url =
				(!read && outcome?.textUrl) ||
				(await experiment.sink.save(read ? read.lines.join("\n") : request.text, request.tool));
			const shapedUrl = holdout || gated ? await experiment.sink.save(shaped, request.tool) : undefined;
			spotlight.original = {
				url,
				lines: lines.kept.length,
				start: read?.firstLine ?? 1,
				...(read ? { path: read.path } : {}),
				heat: encodeHeat(lines.scores),
				kept: keptRanges(lines.kept),
				why: lines.why.slice(0, SPOTLIGHT_VIEW_LINES).join(""),
				...(lines.rank ? { rank: lines.rank } : {}),
				map: lines.map,
				...(shapedUrl ? { shapedUrl } : {}),
			};
			if (scorer.params) spotlight.request = scorer.params;
		} catch (caught) {
			logger.debug("spotlight: original not saved", { tool: request.tool, error: String(caught) });
		}
	}
	return { text, spotlight };
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
	let plain = result;
	if (options?.plain) {
		try {
			plain = await options.plain();
		} catch (error) {
			// As with any shaping error, the model gets the unshaped result.
			logger.warn("spotlight: plain result failed; sizing and showing the unshaped result", {
				tool: request.tool,
				error: String(error),
			});
		}
	}
	const plainText = (joinedText(plain) ?? "") + formatOutputNotice(plain.details?.meta);
	const shaped = await shapeToolText(session, toolCallId, { ...request, text, plain: plainText }, signal);
	if (shaped.text === text) {
		return shaped.spotlight ? { ...plain, details: withSpotlight(plain.details, shaped.spotlight) } : plain;
	}
	let details = withSpotlight(result.details, shaped.spotlight);
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: shaped.text }];
	for (const block of result.content) {
		if (block.type !== "text") content.push(block);
	}
	if (options?.dropTruncation && details?.meta?.truncation) {
		const { truncation: _truncation, ...meta } = details.meta;
		details = { ...details, meta };
	}
	return { ...result, content, details };
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
	/** The files the call targets as the tool reads its arguments (`AgentTool.matcherPaths`), when it can. */
	targets?: () => readonly string[] | undefined;
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
 *
 * An `edit`, `write` or `ast_edit` call's targets are recorded for the edit gate first, whether or not its result is
 * shaped.
 */
export async function shapeCalledTool(session: ToolSession, call: CalledToolResult): Promise<AgentToolResult> {
	const { tool, toolCallId, own, result } = call;
	const experiment = shapingExperiment(session);
	if (!experiment) return result;
	if (Object.hasOwn(EDIT_TOOLS, tool)) {
		try {
			experiment.noteEdits(editTargets(call.args, call.targets?.()), session.cwd);
		} catch (error) {
			logger.debug("spotlight: edit targets unread", { tool, error: String(error) });
		}
	}
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
