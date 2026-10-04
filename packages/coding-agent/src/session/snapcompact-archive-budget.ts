import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";

/**
 * Sizing target for the compacted context, as a share of the compaction
 * trigger: the archive budget never plans past it, and an automatic render
 * that lands above it is re-rendered with fewer frames. It is a target, not a
 * guarantee: a one-frame archive cannot shrink further, automatic maintenance
 * only rejects results above the 80% recovery band, and manual `/compact`
 * checks only reduction and window fit.
 */
export const SNAPCOMPACT_POST_COMPACTION_TARGET = 0.6;

export interface SnapcompactArchiveBudgetInput {
	/** Tokens at which automatic compaction fires for the active model. */
	thresholdTokens: number;
	/**
	 * Everything the compacted context carries besides frames: system prompt
	 * and tools, kept recent turns, the archive's text edges and summary.
	 */
	fixedTokens: number;
	/** Tokens the trigger's counter charges per frame of the archive's shape ({@link shapeFrameTokens}). */
	frameTokens: number;
	/** `snapcompact.archiveShare`: fraction of the room under the trigger the archive may fill. */
	share: number;
}

/**
 * Archive frames that fit the compaction trigger's room: `share` of
 * `thresholdTokens − fixedTokens`, and never planned past
 * {@link SNAPCOMPACT_POST_COMPACTION_TARGET} of the trigger. `0` means the
 * trigger leaves no room for even one frame. Window, payload and provider
 * image caps are the caller's.
 */
export function snapcompactArchiveFrames(input: SnapcompactArchiveBudgetInput): number {
	const { thresholdTokens, fixedTokens, frameTokens, share } = input;
	if (!(frameTokens > 0)) return 0;
	const byShare = Math.floor((share * (thresholdTokens - fixedTokens)) / frameTokens);
	const byTarget = Math.floor((SNAPCOMPACT_POST_COMPACTION_TARGET * thresholdTokens - fixedTokens) / frameTokens);
	return Math.max(0, Math.min(byShare, byTarget));
}

/**
 * What `tokenizer` — the counter behind the compaction trigger and `/context`
 * — charges for `images` carried as snapcompact archive frames. Every archive
 * budget prices frames through it, so a budget equals what the trigger will
 * count after the commit, whatever price the tokenizer assigns per model.
 */
export function archiveFrameTokens(tokenizer: Tokenizer, images: readonly ImageContent[]): number {
	if (images.length === 0) return 0;
	const timestamp = new Date(0).toISOString();
	const withFrames = createCompactionSummaryMessage("", 0, timestamp, { blocks: [...images] });
	return tokenizer.countMessage(withFrames) - tokenizer.countMessage(createCompactionSummaryMessage("", 0, timestamp));
}

/** An archive's frames as the image blocks the rebuilt compaction summary carries. */
export function snapcompactFrameImages(archive: {
	frames: readonly Pick<snapcompact.Frame, "data">[];
}): ImageContent[] {
	return archive.frames.map(frame => ({ type: "image", data: frame.data, mimeType: "image/png" }));
}

/** One full rendered frame per shape, the probe {@link shapeFrameTokens} prices. */
const probeFrames = new Map<string, ImageContent>();

/**
 * {@link archiveFrameTokens} of one full frame of `shape`, for budgets drawn
 * up before the archive is rendered. The probe is a real render, so the
 * tokenizer sees the same pixel size the archive's frames will have.
 */
export async function shapeFrameTokens(tokenizer: Tokenizer, shape: snapcompact.Shape): Promise<number> {
	const key = JSON.stringify(shape);
	let probe = probeFrames.get(key);
	if (!probe) {
		const page = "the archived transcript ".repeat(Math.ceil(snapcompact.geometry(shape).capacity / 24));
		const frame = await snapcompact.render(page, shape);
		probe = { type: "image", data: frame.data, mimeType: "image/png" };
		probeFrames.set(key, probe);
	}
	return archiveFrameTokens(tokenizer, [probe]);
}
