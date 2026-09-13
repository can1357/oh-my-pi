import type {
	AssistantMessage,
	Context,
	DeveloperMessage,
	ImageContent,
	Message,
	Model,
	OpenAIResponsesHistoryPayload,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
	ToolResultProviderMetadata,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { prepareAnthropicManyImageContext } from "@oh-my-pi/pi-ai/providers/anthropic";
import { getOpenAIResponsesHistoryPayload, normalizeResponsesToolCallId } from "@oh-my-pi/pi-ai/utils";
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";
import { isRecord } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { providerImageBudget, providerImageByteBudget } from "@oh-my-pi/snapcompact";
import { supportsRemoteImageUrls } from "../blob-broker/context-images";
import { imageDecodeFailureReason } from "../utils/image-loading";

const IMAGE_OMISSION_NOTICE: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

/**
 * The single traversal both budgets are derived from, so the population each
 * one enforces can never drift apart.
 *
 * Only images that actually reach the provider are tallied. An assistant image
 * is a display artifact that NO provider accepts in a replay turn:
 * `transform-messages.ts` drops every assistant image block unconditionally
 * before a request is built (the native Responses result rides in
 * `providerPayload` instead), and the converters that bypass that transform
 * render an assistant turn from its text, thinking and tool-call blocks alone.
 * So an assistant image consumes neither budget, and charging it against
 * either evicts a live user or tool image to make room for something that was
 * never going to be sent — a handful of old generated artifacts could push
 * every current screenshot out on their own.
 *
 * Within that population the two budgets still count different things, so they
 * are tallied separately. The COUNT cap is a per-request image cap the provider
 * applies to every image part, reference-backed or not, so references consume
 * it. The BYTE cap bounds the base64 payload actually put on the wire, so an
 * image the provider resolves from a reference contributes no bytes. Conflating
 * them either over-drops (charging reference bytes that never travel) or
 * under-drops (letting references push the request past the image count).
 *
 * `byteModel` is the model whose reference shapes decide which images put bytes
 * on the wire, or `undefined` for a caller that needs the count alone — the
 * count pass runs before normalization rewrites inline sizes, so tallying bytes
 * there would only produce a number it must not use.
 */
function collectImageStats(
	context: Context,
	byteModel: Model | undefined,
	replaysNativeHistory: boolean,
	countModel: Model,
): { total: number; inlineSizes: number[] } {
	let total = 0;
	const inlineSizes: number[] = [];
	const pairedComputerCallIds = collectPairedComputerCallIds(context);
	for (const message of context.messages) {
		if (message.role === "assistant") {
			// An assistant's generic `content` images are display-only, but its
			// replayed native image results are NOT — see
			// `replayedImageResultSizes`.
			if (byteModel !== undefined)
				inlineSizes.push(...replayedImageResultSizes(message, byteModel, replaysNativeHistory));
			continue;
		}
		// A computer result's metadata screenshot REPLACES its generic content on
		// the wire — `appendResponsesToolResultMessages()` sends the metadata copy
		// as the `computer_call_output.output` and never looks at the content. So
		// the mirrored content image must not be charged a second time, or one
		// 9 MB screenshot measures 18 MB and evicts the only copy that travels.
		const sendsScreenshot =
			message.role === "toolResult" && sendsComputerScreenshot(message, countModel, pairedComputerCallIds);
		// A demoted screenshot's bytes travel inside an assistant note while the
		// content mirror is dropped — so it owes bytes but no image part, and the
		// mirror must not be charged in its place.
		const demotesScreenshot = message.role === "toolResult" && demotesComputerScreenshot(message, countModel);
		if (demotesScreenshot && byteModel !== undefined) {
			const screenshot = inlineComputerScreenshot(message.providerMetadata);
			if (screenshot !== undefined) inlineSizes.push(screenshot.length);
		}
		if (sendsScreenshot) {
			// One image part, whether or not a content mirror exists: a history
			// parsed back from `computer_call_output` produces `content: []`, and a
			// file-backed screenshot carries no inline bytes — so leaving the count
			// to the content loop left a long replay uncounted and un-evictable.
			total++;
			if (byteModel !== undefined) {
				const screenshot = inlineComputerScreenshot(message.providerMetadata);
				if (screenshot !== undefined) inlineSizes.push(screenshot.length);
			}
		}
		// A replayed `input_image` is sent as an ordinary Responses image input, so
		// it consumes the provider's per-request image COUNT as well as bytes —
		// unlike a replayed `image_generation_call` result, which is an assistant
		// output item rather than an input part.
		const replayed = replayedInputImages(message, byteModel ?? countModel, replaysNativeHistory);
		total += replayed.length;
		if (byteModel !== undefined) {
			for (const size of replayed) if (size > 0) inlineSizes.push(size);
		}
		if (!Array.isArray(message.content)) continue;
		// A replayed turn's generic content NEVER travels: `convertConversationMessages()`
		// pushes the replay items and `continue`s past `msg.content` entirely. Charging
		// both representations let attached frames on a compaction summary evict the
		// native history that was the only thing going onto the wire.
		if (supersedesContentWithReplay(message, byteModel ?? countModel, replaysNativeHistory)) continue;
		for (const part of message.content) {
			if (part.type !== "image") continue;
			// The mirror is neither counted nor charged: the metadata copy above
			// already stands for this screenshot on both budgets.
			if (sendsScreenshot || demotesScreenshot) continue;
			total++;
			if (byteModel !== undefined && sendsInlineImageBytes(part, byteModel)) inlineSizes.push(part.data.length);
		}
	}
	return { total, inlineSizes };
}

/**
 * Base64 sizes of the native image results this assistant turn replays.
 *
 * A completed `image_generation_call` keeps its base64 in `providerPayload`
 * rather than in `content`, and `openai-shared.ts`
 * `convertConversationMessages()` replays the sanitized item verbatim on a
 * continuing same-model Responses request — so those bytes DO travel, and a
 * few generated images can exceed the byte budget on their own while the
 * content-only tally reads zero.
 *
 * Bytes only: the count cap is the provider's per-request cap on image parts,
 * which a replayed generation result is not.
 */
function replayedImageResultSizes(message: AssistantMessage, model: Model, replaysNativeHistory: boolean): number[] {
	const payload = replayableHistoryPayload(message, model, replaysNativeHistory);
	if (!payload) return [];
	const sizes: number[] = [];
	for (const item of payload.items) {
		const result = replayedImageResult(item);
		if (result !== undefined) sizes.push(result.length);
	}
	return sizes;
}

/**
 * This turn's replayed Responses payload, but only when the request will
 * actually carry it.
 *
 * `openai-shared.ts` `convertConversationMessages()` replays a payload solely
 * when the turn's `api` and `model` match the request's and
 * `getOpenAIResponsesHistoryPayload` accepts the provider. A payload that fails
 * any of those is dead weight on this request — charging it would let a stale
 * generation result evict a live user image that IS being sent, which is the
 * exact harm the byte budget exists to avoid.
 *
 * Matching those is necessary but NOT sufficient: `buildParams` also sends no
 * native history at all until the session's replay state is warmed, so on the
 * first request after a restore every payload here is dead weight however well
 * it matches. `replaysNativeHistory` carries that decision in; a caller with no
 * provider state passes `true`, the same default `buildParams` takes.
 */
function replayableHistoryPayload(
	message: AssistantMessage,
	model: Model,
	replaysNativeHistory: boolean,
): OpenAIResponsesHistoryPayload | undefined {
	if (!replaysNativeHistory) return undefined;
	if (message.api !== model.api || message.model !== model.id) return undefined;
	return getOpenAIResponsesHistoryPayload(message.providerPayload, model.provider, message.provider);
}

/** The replayable base64 of `item`, or `undefined` when it carries none. */
function replayedImageResult(item: Record<string, unknown>): string | undefined {
	if (item.type !== "image_generation_call") return undefined;
	const result = item.result;
	return typeof result === "string" && result.length > 0 ? result : undefined;
}

/**
 * Base64 sizes of the inline `input_image` parts this turn's replayed native
 * history carries.
 *
 * A remote-compaction replacement can retain `input_image` items whose bytes
 * exist ONLY inside a user/developer `providerPayload`:
 * `session-context.ts` attaches the full snapshot to the summary and
 * `openai-shared.ts` `convertConversationMessages()` replays it instead of the
 * generic content, which `inputContentParts()` reduced to text. Tallying
 * `message.content` alone therefore read zero while megabytes travelled, and a
 * resumed session kept failing with 413 because no drop was ever owed.
 *
 * Returns one size per image part — 0 for a reference-backed one, which counts
 * against the per-request image cap while carrying no inline bytes.
 */
function replayedInputImages(message: Message, model: Model, replaysNativeHistory: boolean): number[] {
	if (message.role !== "user" && message.role !== "developer") return [];
	// Only a Responses-family route consumes native history at all. Switching to a
	// same-provider `openai-completions` model leaves the payload attached and
	// unread, so charging it would let a stale payload evict a live image for
	// bytes the completions converter never sends.
	if (!replaysOpenAIResponsesNativeHistory(model)) return [];
	const payload = getOpenAIResponsesHistoryPayload(message.providerPayload, model.provider);
	if (!payload) return [];
	// A cold session still replays a payload that carries a `compaction` or
	// `compaction_summary` marker: `convertConversationMessages()` takes that
	// branch on the marker alone, independently of `nativeHistory.replay`. That
	// is exactly the oversized remote-compaction replacement this accounts for,
	// so skipping it on a cold resume let the very first request bust the cap.
	if (!replaysNativeHistory && !hasCompactionMarker(payload.items)) return [];
	// One entry per image PART, whatever it carries. An HTTPS- or file-backed
	// `input_image` is still sent as an image input and still consumes the count
	// cap, so recording only the inline ones left a payload of references
	// uncounted and un-evictable; its size is 0 and the byte tally skips it.
	const sizes: number[] = [];
	const repairedOrphans = repairedOrphanItemIndices(payload.items, model);
	for (let index = 0; index < payload.items.length; index++) {
		if (repairedOrphans.has(index)) continue;
		for (const part of nativeInputImageParts(payload.items[index])) {
			sizes.push(inlineImageFromDataUri(part.image_url)?.data.length ?? 0);
		}
	}
	return sizes;
}

/**
 * Indices of replayed `computer_call_output` items the converter will replace
 * with a short assistant note before they reach the wire.
 *
 * `repairOrphanResponsesToolOutputs()` rewrites an output whose `computer_call`
 * does not precede it, truncating the serialized output to 16 KB — so its
 * screenshot never travels, and charging it evicted live images to make room
 * for bytes that were already gone. Only the two routes that pass
 * `repairOrphanOutputs: true` do this; the Codex route replays the orphan
 * unchanged, so there its bytes are real.
 */
function repairedOrphanItemIndices(items: readonly Record<string, unknown>[], model: Model): ReadonlySet<number> {
	const repaired = new Set<number>();
	if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") return repaired;
	const precedingCalls = new Set<string>();
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const callId = typeof item?.call_id === "string" ? item.call_id : undefined;
		if (!callId) continue;
		if (item.type === "computer_call") precedingCalls.add(callId);
		else if (item.type === "computer_call_output" && !precedingCalls.has(callId)) repaired.add(index);
	}
	return repaired;
}

/** The API routes whose converters replay an `openaiResponsesHistory` payload. */
function replaysOpenAIResponsesNativeHistory(model: Model): boolean {
	return (
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "azure-openai-responses"
	);
}

/**
 * Whether a replayed payload REPLACES this turn's generic content on the wire.
 *
 * `convertConversationMessages()` pushes the sanitized replay items and
 * `continue`s, so `msg.content` is never converted for such a turn.
 */
function supersedesContentWithReplay(message: Message, model: Model, replaysNativeHistory: boolean): boolean {
	if (message.role !== "user" && message.role !== "developer") return false;
	if (!replaysOpenAIResponsesNativeHistory(model)) return false;
	const payload = getOpenAIResponsesHistoryPayload(message.providerPayload, model.provider);
	if (!payload) return false;
	return replaysNativeHistory || hasCompactionMarker(payload.items);
}

/** Whether these items replay regardless of the session's warmed replay state. */
function hasCompactionMarker(items: ReadonlyArray<Record<string, unknown> | undefined>): boolean {
	return items.some(item => item?.type === "compaction" || item?.type === "compaction_summary");
}

/**
 * The replayed image parts of an item: `input_image` at the top level or nested
 * in `content`, plus a `computer_call_output`'s screenshot `output`, which
 * `buildResponsesInput()` replays unchanged and which carries its `image_url` in
 * its own position rather than inside an `input_image`.
 */
function nativeInputImageParts(item: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	if (!item) return [];
	if (item.type === "input_image") return [item];
	if (item.type === "computer_call_output") {
		const output = item.output;
		return isRecord(output) && typeof output.image_url === "string" ? [output] : [];
	}
	if (!Array.isArray(item.content)) return [];
	return item.content.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "input_image");
}

/**
 * Whether this result's screenshot travels as `computer_call_output.output`
 * rather than as its generic content image.
 *
 * `appendResponsesToolResultMessages()` takes that branch for a Responses
 * model's computer result, sending `providerMetadata.screenshot` and ignoring
 * the content entirely. On any other model the metadata is inert and the
 * content image is what travels, so the two are never both charged.
 */
function sendsComputerScreenshot(
	message: ToolResultMessage,
	model: Model | undefined,
	pairedComputerCallIds: ReadonlySet<string>,
): boolean {
	if (model?.supportsComputerUse !== true) return false;
	// The metadata's presence, not its inline bytes: a file- or URL-backed
	// screenshot is still sent as the `computer_call_output.output` and still
	// consumes an image part, it simply contributes no bytes.
	if (message.providerMetadata?.type !== "computer") return false;
	// And only while its `computer_call` survives into the request.
	// `appendResponsesToolResultMessages()` takes the screenshot branch behind
	// `computerCallIds.has(callId)`; an orphan — the call compacted or truncated
	// away — falls through to generic output instead, so charging its metadata
	// would evict a live image for bytes that never travel.
	return pairedComputerCallIds.has(normalizeComputerCallId(message.toolCallId));
}

/**
 * Whether this result's screenshot travels inside a demoted assistant note.
 *
 * `appendResponsesToolResultMessages()` takes an earlier branch for a computer
 * result on a model with `supportsComputerUse !== true`: it stringifies the
 * whole `providerMetadata.screenshot` — data uri included, untruncated — into an
 * assistant note and returns, so the generic content image is never sent. The
 * bytes therefore travel while the count does not: the note is text, not an
 * image part.
 */
function demotesComputerScreenshot(message: ToolResultMessage, model: Model | undefined): boolean {
	if (model === undefined || model.supportsComputerUse === true) return false;
	if (!usesResponsesToolResultConverter(model)) return false;
	return message.providerMetadata?.type === "computer";
}

/** The API routes whose tool results go through `appendResponsesToolResultMessages()`. */
function usesResponsesToolResultConverter(model: Model): boolean {
	return replaysOpenAIResponsesNativeHistory(model);
}

/**
 * The call ids of every computer tool call still present in this context.
 *
 * Mirrors `collectComputerCallIds` over the generic view: a `computer_call` item
 * is emitted for an assistant tool call whose `providerMetadata.type` is
 * `"computer"`, so that is what pairs a later result's screenshot.
 */
function collectPairedComputerCallIds(context: Context): Set<string> {
	const ids = new Set<string>();
	for (const message of context.messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (block.providerMetadata?.type !== "computer") continue;
			ids.add(normalizeComputerCallId(block.id));
		}
	}
	return ids;
}

/** The same call id the Responses converter pairs on. */
function normalizeComputerCallId(toolCallId: string): string {
	return normalizeResponsesToolCallId(toolCallId, "ctc").callId;
}

/**
 * The inline base64 of a computer result's replayed screenshot, or `undefined`
 * when it carries none.
 *
 * `openai-shared.ts` `appendResponsesToolResultMessages()` sends
 * `providerMetadata.screenshot` as the `computer_call_output.output`, so the
 * metadata copy is what travels — the mirrored generic content image is dropped
 * on the floor. Clamping only the content block therefore removed no wire bytes
 * at all, and a result with no mirrored copy went uncounted entirely.
 */
function inlineComputerScreenshot(metadata: ToolResultProviderMetadata | undefined): string | undefined {
	if (metadata?.type !== "computer") return undefined;
	const image = inlineImageFromDataUri(metadata.screenshot.image_url);
	return image && image.data.length > 0 ? image.data : undefined;
}

/** Count of oldest images to drop so the surviving image payload fits `byteLimit`. */
function imageDropCountForBytes(sizes: readonly number[], byteLimit: number): number {
	let total = 0;
	for (const size of sizes) total += size;
	let drops = 0;
	for (let index = 0; total > byteLimit && index < sizes.length; index++) {
		total -= sizes[index] ?? 0;
		drops++;
	}
	return drops;
}

interface ImageClampState {
	/** Image parts of ANY kind still to drop for the per-request count cap. */
	remainingDrops: number;
	/** INLINE images still to drop for the byte cap; only inline bytes travel. */
	remainingInlineDrops: number;
	model: Model;
	/** Whether this request will replay native `providerPayload` history at all. */
	replaysNativeHistory: boolean;
	/** Call ids of the computer calls still present, which pair a result's screenshot. */
	pairedComputerCallIds: ReadonlySet<string>;
}

/**
 * Drops the oldest images until both budgets are satisfied, tracking them
 * separately. An inline image pays down the byte constraint AND the count
 * constraint; a reference-backed image pays down only the count. A reference is
 * therefore dropped only while the count cap still needs it, so byte pressure
 * can never be "satisfied" by evicting context that carries no bytes.
 */
/** Any drop still owed on either budget. */
function clampWanted(state: ImageClampState): boolean {
	return state.remainingDrops > 0 || state.remainingInlineDrops > 0;
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: ImageClampState,
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image") {
			const inline = sendsInlineImageBytes(part, state.model);
			const needed = inline ? state.remainingInlineDrops > 0 || state.remainingDrops > 0 : state.remainingDrops > 0;
			if (needed) {
				if (inline && state.remainingInlineDrops > 0) state.remainingInlineDrops--;
				if (state.remainingDrops > 0) state.remainingDrops--;
				changed = true;
				continue;
			}
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

// A turn whose ONLY content was a dropped image must keep a placeholder: an
// empty content array is skipped by the Anthropic converter, so the turn would
// vanish from the transcript and take its conversational position with it.
function clampUserMessage(message: UserMessage, state: ImageClampState): UserMessage {
	const payload = clampReplayedInputImages(message, state);
	if (!Array.isArray(message.content) || !clampWanted(state)) return payload ? { ...message, ...payload } : message;
	const content = clampContent(message.content, state);
	if (!content) return payload ? { ...message, ...payload } : message;
	// Dropping a generic image already discards the payload, which is where the
	// replayed copy of that same image lives.
	return { ...message, content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE], providerPayload: undefined };
}

function clampDeveloperMessage(message: DeveloperMessage, state: ImageClampState): DeveloperMessage {
	const payload = clampReplayedInputImages(message, state);
	if (!Array.isArray(message.content) || !clampWanted(state)) return payload ? { ...message, ...payload } : message;
	const content = clampContent(message.content, state);
	if (!content) return payload ? { ...message, ...payload } : message;
	return { ...message, content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE], providerPayload: undefined };
}

function clampToolResultMessage(message: ToolResultMessage, state: ImageClampState): ToolResultMessage {
	if (!clampWanted(state)) return message;
	// A demoted screenshot's bytes leave through the assistant note, so only the
	// metadata can be redacted — and only while bytes are what is owed, since the
	// note is text and consumes no image part.
	if (demotesComputerScreenshot(message, state.model)) {
		if (state.remainingInlineDrops <= 0) return message;
		if (inlineComputerScreenshot(message.providerMetadata) === undefined) return message;
		state.remainingInlineDrops--;
		return { ...message, providerMetadata: undefined };
	}
	// Dropping the metadata screenshot already removes this result's only wire
	// image, so the mirrored content block must not also pay down a budget — it
	// was never charged one.
	if (sendsComputerScreenshot(message, state.model, state.pairedComputerCallIds)) {
		if (!clampComputerScreenshot(message, state)) return message;

		const clampedContent = clampContent(message.content, { ...state, remainingInlineDrops: 0 });
		return {
			...message,
			content: clampedContent && clampedContent.length > 0 ? clampedContent : [IMAGE_OMISSION_NOTICE],
			providerMetadata: undefined,
		};
	}
	const content = clampContent(message.content, state);
	if (!content) return message;
	return { ...message, content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE] };
}

/**
 * Evicts the inline `input_image` parts a replayed payload would carry, by
 * degrading each to the `input_text` the Responses input schema accepts in the
 * same position — the same in-place rewrite the undecodable path uses, for the
 * same reason: the payload also holds compaction markers and call ids the
 * generic content does not reproduce, so clearing it would lose real history.
 */
function clampReplayedInputImages(
	message: UserMessage | DeveloperMessage,
	state: ImageClampState,
): { providerPayload: ProviderPayload } | undefined {
	if (!clampWanted(state)) return undefined;
	if (!replaysOpenAIResponsesNativeHistory(state.model)) return undefined;
	const payload = getOpenAIResponsesHistoryPayload(message.providerPayload, state.model.provider);
	if (!payload) return undefined;
	// Same eligibility as the accounting, marker exception included.
	if (!state.replaysNativeHistory && !hasCompactionMarker(payload.items)) return undefined;
	let items: Array<Record<string, unknown>> | undefined;
	// Call ids of the computer outputs evicted below. Their paired `computer_call`
	// goes with them: `computer_call_output.output` accepts only a real
	// `computer_screenshot` ref, so there is nothing to degrade it to in place —
	// and a call left behind without its output is an orphan the provider rejects.
	const droppedComputerCallIds = new Set<string>();
	const repairedOrphans = repairedOrphanItemIndices(payload.items, state.model);
	for (let index = 0; index < payload.items.length; index++) {
		if (!clampWanted(state)) break;
		if (repairedOrphans.has(index)) continue;
		const item = payload.items[index];
		if (item?.type === "computer_call_output") {
			const [screenshot] = nativeInputImageParts(item);
			if (!screenshot || !dropsNativeInputImage(screenshot, state)) continue;
			payNativeInputImageDrop(screenshot, state);
			if (typeof item.call_id === "string") droppedComputerCallIds.add(item.call_id);
			items ??= [...payload.items];
			continue;
		}
		const rewritten = dropNativeInputImages(item, state);
		if (!rewritten) continue;
		items ??= [...payload.items];
		items[index] = rewritten;
	}
	if (!items) return undefined;
	const surviving =
		droppedComputerCallIds.size > 0
			? items.filter(item => !isDroppedComputerItem(item, droppedComputerCallIds))
			: items;
	return { providerPayload: { ...payload, items: surviving } };
}

/** Whether this item is an evicted computer output, or the call it was paired with. */
function isDroppedComputerItem(
	item: Record<string, unknown> | undefined,
	droppedCallIds: ReadonlySet<string>,
): boolean {
	if (item?.type !== "computer_call_output" && item?.type !== "computer_call") return false;
	return typeof item.call_id === "string" && droppedCallIds.has(item.call_id);
}

/** `undefined` when the item carries no inline image worth dropping. */
function dropNativeInputImages(
	item: Record<string, unknown> | undefined,
	state: ImageClampState,
): Record<string, unknown> | undefined {
	if (!item) return undefined;
	const omitted = { type: "input_text", text: IMAGE_OMISSION_NOTICE.text };
	if (item.type === "input_image") {
		if (!dropsNativeInputImage(item, state)) return undefined;
		payNativeInputImageDrop(item, state);
		return omitted;
	}
	if (!Array.isArray(item.content)) return undefined;
	let content: unknown[] | undefined;
	for (let index = 0; index < item.content.length; index++) {
		if (!clampWanted(state)) break;
		const part = item.content[index];
		if (!isRecord(part) || part.type !== "input_image" || !dropsNativeInputImage(part, state)) continue;
		payNativeInputImageDrop(part, state);
		content ??= [...item.content];
		content[index] = omitted;
	}
	return content ? { ...item, content } : undefined;
}

/**
 * An inline replayed image pays down BOTH allowances; a reference-backed one is
 * an image part carrying no bytes, so it pays only the count — the same split
 * `clampContent` applies to ordinary image parts.
 */
function payNativeInputImageDrop(part: Record<string, unknown>, state: ImageClampState): void {
	if (isInlineNativeImage(part) && state.remainingInlineDrops > 0) state.remainingInlineDrops--;
	if (state.remainingDrops > 0) state.remainingDrops--;
}

/** Whether dropping this part serves an allowance that still wants a drop. */
function dropsNativeInputImage(part: Record<string, unknown>, state: ImageClampState): boolean {
	return isInlineNativeImage(part) ? clampWanted(state) : state.remainingDrops > 0;
}

/** Whether this native part carries inline bytes at all. */
function isInlineNativeImage(part: Record<string, unknown>): boolean {
	const image = inlineImageFromDataUri(part.image_url);
	return image !== undefined && image.data.length > 0;
}

/**
 * Clears a computer result's replayed screenshot while byte pressure remains.
 * That metadata copy is what `computer_call_output.output` sends, so it is the
 * only way this result gives back wire bytes. `computer_call_output` accepts
 * only a `computer_screenshot` ref with no text alternative, so the metadata is
 * cleared outright rather than degraded in place.
 */
function clampComputerScreenshot(message: ToolResultMessage, state: ImageClampState): boolean {
	// EITHER constraint, not just bytes: a screenshot is an image part under the
	// count cap too, so more than the cap of small ones leaves `remainingDrops`
	// positive with no bytes owed — and gating on bytes alone returned every
	// result unchanged while the request stayed over the count.
	if (!clampWanted(state)) return false;
	// A reference-backed screenshot contributed nothing to `inlineSizes`, so it
	// can only relieve the COUNT cap. Paying the byte allowance down with it would
	// retire a debt it never incurred and leave a later oversized inline image in
	// place — and dropping it while the byte cap is the only thing that binds
	// loses the screenshot for nothing at all.
	const inline = inlineComputerScreenshot(message.providerMetadata) !== undefined;
	let relieved = false;
	if (inline && state.remainingInlineDrops > 0) {
		state.remainingInlineDrops--;
		relieved = true;
	}
	if (state.remainingDrops > 0) {
		state.remainingDrops--;
		relieved = true;
	}
	return relieved;
}

/**
 * Evicts this turn's replayed native image results while byte pressure remains.
 *
 * Clears the item's `result` rather than removing the item or the payload:
 * `utils.ts` `sanitizeOpenAIResponsesImageGenerationCallForReplay` returns
 * `undefined` for an empty result, so the emptied item stops being replayed —
 * while the payload's other items (reasoning, call ids, compaction markers,
 * none of which the generic content reproduces) survive untouched. Only the
 * byte allowance is paid down; these are not image parts under the count cap.
 */
function clampAssistantMessage(message: AssistantMessage, state: ImageClampState): AssistantMessage {
	if (state.remainingInlineDrops <= 0) return message;
	// Same eligibility gate as the accounting: never rewrite a payload this
	// request was not going to replay anyway.
	const payload = replayableHistoryPayload(message, state.model, state.replaysNativeHistory);
	if (!payload) return message;
	let items: Array<Record<string, unknown>> | undefined;
	for (let index = 0; index < payload.items.length; index++) {
		if (state.remainingInlineDrops <= 0) break;
		const item = payload.items[index];
		if (!item || replayedImageResult(item) === undefined) continue;
		state.remainingInlineDrops--;
		items ??= [...payload.items];
		items[index] = { ...item, result: "" };
	}
	return items ? { ...message, providerPayload: { ...payload, items } } : message;
}

/** Applies an already-computed drop allowance oldest-first across the context. */
function applyImageClamp(context: Context, state: ImageClampState): Context {
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				// Generic assistant images are display artifacts the request never
				// carries, so there is nothing to reclaim by dropping them. A
				// replayed native image result is different: those bytes travel, so
				// they are charged and must be evictable.
				return clampAssistantMessage(message, state);
		}
		return message;
	});
	return { ...context, messages };
}

/**
 * Headroom the count pass leaves above the provider cap, as a multiple of it.
 *
 * The count pass runs before anything has decoded, so it cannot know which
 * images the unreadable pass is about to turn into text. Clamping straight to
 * the cap therefore spent a slot on an image that was about to stop being one:
 * a history of exactly `cap` valid images plus one corrupt newer image evicted
 * the OLDEST VALID image to fit the corrupt one, and the final count-aware
 * clamp — which sees only survivors — would have kept all `cap` of them.
 *
 * Keeping `cap * (1 + slack)` images instead lets the decode pass consume the
 * overage out of the images that fail it, and the real cap is enforced
 * afterwards by {@link clampProviderContextImages} over what actually survived.
 *
 * This is deliberately a MULTIPLE and not "validate everything": the pass
 * exists to bound decode work, and decoding an unbounded history is the cost it
 * was introduced to remove. So the quota is preserved for up to `cap * slack`
 * unreadable images and decode work stays bounded by a constant multiple of the
 * cap — never by the length of the history.
 */
export const PROVIDER_IMAGE_COUNT_DECODE_SLACK = 1;

/** Drops oldest image blocks to satisfy the per-request image COUNT cap, plus
 *  {@link PROVIDER_IMAGE_COUNT_DECODE_SLACK} worth of headroom.
 *  Runs FIRST, ahead of the normalize and unreadable passes: both are per-image
 *  expensive (the unreadable pass fully decodes each one behind a 512-entry
 *  cache that a longer history evicts on every request, and normalization can
 *  re-encode), so paying either for an image no cap could ever admit is pure
 *  waste. The headroom is what keeps this from pre-committing the cap to images
 *  the decode pass is about to replace with text — see the constant.
 *  Bytes are deliberately NOT considered here — normalization
 *  rewrites inline sizes, so only {@link clampProviderContextImages}, running
 *  after it, sees final byte counts. */
export function clampProviderContextImageCount(context: Context, model: Model, replaysNativeHistory = true): Context {
	if (!model.input.includes("image")) return context;
	const admissible = providerImageBudget(model.provider) * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
	// A replayed generation result is not an image part, so it never reaches this
	// tally — but a replayed `input_image` IS one, so this pass needs the same
	// replay decision the byte pass gets. Hard-coding it let a payload the request
	// would not send justify dropping generic images it WOULD.
	const countDrops = collectImageStats(context, undefined, replaysNativeHistory, model).total - admissible;
	if (countDrops <= 0) return context;
	return applyImageClamp(context, {
		remainingDrops: countDrops,
		remainingInlineDrops: 0,
		model,
		replaysNativeHistory,
		pairedComputerCallIds: collectPairedComputerCallIds(context),
	});
}

/** Drops oldest transient image blocks so outgoing vision requests fit the
 *  active provider's image budget — both the per-request image COUNT cap and the
 *  combined image-BYTE cap (a long snapcompact archive can stay under the count
 *  cap yet bust the request-size limit on summed frame bytes). */
export function clampProviderContextImages(context: Context, model: Model, replaysNativeHistory = true): Context {
	if (!model.input.includes("image")) return context;
	const { total, inlineSizes } = collectImageStats(context, model, replaysNativeHistory, model);
	// Not `total === 0`: a replayed native image result contributes bytes but no
	// image part, so a context whose only images are generated ones has
	// `total === 0` and a payload that can still bust the byte budget.
	if (total === 0 && inlineSizes.length === 0) return context;
	const countDrops = Math.max(0, total - providerImageBudget(model.provider));
	const inlineDrops = imageDropCountForBytes(inlineSizes, providerImageByteBudget(model.provider, model.api));
	if (countDrops === 0 && inlineDrops === 0) return context;

	// The two budgets are tracked as SEPARATE remaining constraints rather than
	// collapsed with max(): a reference-backed drop satisfies the count cap but
	// relieves no bytes, so one shared counter lets references absorb the whole
	// allowance and leaves the request over the byte budget (and still 413ing).
	// `inlineDrops` is the number of INLINE images that must go; `countDrops` is
	// the number of image parts of any kind. A dropped inline image pays down
	// both.
	return applyImageClamp(context, {
		remainingDrops: countDrops,
		remainingInlineDrops: inlineDrops,
		model,
		replaysNativeHistory,
		pairedComputerCallIds: collectPairedComputerCallIds(context),
	});
}

/**
 * Decode verdicts keyed by payload hash: the same historical images ride along
 * on every turn of a session, and decoding all of them per request would be a
 * real cost. `null` means the image decodes.
 */
const IMAGE_DECODE_CACHE_MAX_ENTRIES = 512;
const imageDecodeFailures = new LRUCache<string, string | null>({ max: IMAGE_DECODE_CACHE_MAX_ENTRIES });

async function unreadableImageReason(image: ImageContent): Promise<string | null> {
	const key = `${image.mimeType}:${image.data.length}:${String(Bun.hash(image.data))}`;
	const cached = imageDecodeFailures.get(key);
	if (cached !== undefined) return cached;
	const reason = await imageDecodeFailureReason(image);
	imageDecodeFailures.set(key, reason);
	return reason;
}

/**
 * True when this block's inline `data` is what actually travels on the wire.
 *
 * An `ImageContent` may legitimately carry EMPTY `data` beside an external
 * reference, and it is the reference — never those bytes — that the provider
 * receives. Provider-file references displace inline bytes only on an API that
 * understands that provider's reference shape; another API falls back to data.
 * Two producers make the empty reference-backed shape:
 *   - `openai-responses-server.ts` `functionOutputContent()` represents a
 *     native `input_image` URL / file id as `{ data: "", url }` or
 *     `{ data: "", providerFile }`;
 *   - `blob-broker/service.ts` `frameSink` publishes lazy snapcompact frames as
 *     `{ data: "", url }` whose PNG renders only when a provider fetches it —
 *     and `SnapcompactInlineTransformer` runs BEFORE this guard in `sdk.ts`, so
 *     those placeholders are already reference-shaped when we see them.
 * `openai-shared.ts` `convertResponsesInputImage()` prefers `providerFile`, then
 * `url`, and only falls back to `data:<mime>;base64,<data>`. Decoding a
 * reference-backed block would therefore destroy a perfectly good image over
 * bytes the provider is never sent.
 */
function sendsInlineImageBytes(image: ImageContent, model: Model): boolean {
	const reference = image.providerFile;
	if (reference) {
		switch (reference.provider) {
			case "openai":
				if (
					reference.id &&
					(model.api === "openai-responses" ||
						model.api === "openai-codex-responses" ||
						model.api === "azure-openai-responses")
				) {
					return false;
				}
				break;
			case "anthropic":
				if (reference.id && model.api === "anthropic-messages") return false;
				break;
			case "google":
				if (
					reference.uri &&
					(model.api === "google-generative-ai" ||
						model.api === "google-gemini-cli" ||
						model.api === "google-vertex")
				) {
					return false;
				}
				break;
		}
	}
	if (image.url && supportsRemoteImageUrls(model)) return false;
	return true;
}

/**
 * Inline image bytes carried by a native `image_url`, or `undefined` when there
 * is nothing local to decode. An `https:` URL or a `file_id` is a reference the
 * provider resolves itself — the same rule as {@link sendsInlineImageBytes}.
 */
function inlineImageFromDataUri(imageUrl: unknown): ImageContent | undefined {
	if (typeof imageUrl !== "string") return undefined;
	try {
		const decoded = decodeDataUri(imageUrl);
		return decoded ? { type: "image", data: decoded.data, mimeType: decoded.mimeType } : undefined;
	} catch {
		// A malformed percent escape is itself unreadable inline data. Return an
		// empty probe so the caller degrades it instead of wedging on URI decoding.
		return imageUrl.slice(0, 5).toLowerCase() === "data:"
			? { type: "image", data: "", mimeType: "application/octet-stream" }
			: undefined;
	}
}

/** `undefined` when every image decodes, so callers can keep the original array. */
async function replaceUnreadableContent(
	content: readonly (TextContent | ImageContent)[],
	model: Model,
): Promise<(TextContent | ImageContent)[] | undefined> {
	let replaced: (TextContent | ImageContent)[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (part.type !== "image" || !sendsInlineImageBytes(part, model)) continue;
		const reason = await unreadableImageReason(part);
		if (reason === null) continue;
		replaced ??= [...content];
		replaced[index] = {
			type: "text",
			text: `[image omitted: undecodable ${part.mimeType ?? "image"} data (${reason})]`,
		};
	}
	return replaced;
}

/**
 * `undefined` when the native part needs no rewrite. A replayed `input_image`
 * degrades to the `input_text` part the Responses input schema accepts in the
 * same position, so the surrounding item keeps its shape, its ids, and its
 * ordering.
 */
async function replaceUnreadableNativePart(part: unknown): Promise<Record<string, unknown> | undefined> {
	if (!isRecord(part) || part.type !== "input_image") return undefined;
	const image = inlineImageFromDataUri(part.image_url);
	if (!image) return undefined;
	const reason = await unreadableImageReason(image);
	if (reason === null) return undefined;
	return { type: "input_text", text: `[image omitted: undecodable ${image.mimeType} data (${reason})]` };
}

/** `undefined` when the item needs no rewrite. */
async function replaceUnreadableNativeItem(
	item: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
	const rewrittenItem = await replaceUnreadableNativePart(item);
	if (rewrittenItem) return rewrittenItem;
	if (!Array.isArray(item.content)) return undefined;

	let content: unknown[] | undefined;
	for (let index = 0; index < item.content.length; index++) {
		const rewritten = await replaceUnreadableNativePart(item.content[index]);
		if (!rewritten) continue;
		content ??= [...item.content];
		content[index] = rewritten;
	}
	return content ? { ...item, content } : undefined;
}

/**
 * `undefined` when no replayed item carries an undecodable image.
 *
 * A corrupt image can bypass the generic `content` view entirely:
 * `openai-responses-server.ts` `inputContentParts()` retains only text for the
 * generic view and keeps the raw native item on `providerPayload`, which
 * `openai-shared.ts` `convertConversationMessages()` then replays verbatim in
 * place of that content. So the payload has to be walked in its own right.
 *
 * Rewriting the offending part in place — rather than dropping the payload — is
 * what keeps this safe: payload items also carry `compaction` /
 * `compaction_summary` markers and native call ids that the generic content does
 * NOT reproduce, so clearing the payload would trade one broken request for
 * silent history loss. A valid image is never touched: every level returns
 * `undefined` when nothing changed, so the original objects survive by identity.
 */
async function replaceUnreadableNativePayload(
	payload: ProviderPayload | undefined,
): Promise<ProviderPayload | undefined> {
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return undefined;
	let items: Array<Record<string, unknown>> | undefined;
	for (let index = 0; index < payload.items.length; index++) {
		const rewritten = await replaceUnreadableNativeItem(payload.items[index]!);
		if (!rewritten) continue;
		items ??= [...payload.items];
		items[index] = rewritten;
	}
	return items ? { ...payload, items } : undefined;
}

/**
 * Why a computer screenshot cannot be decoded, or `null` when there is nothing
 * wrong (or nothing inline to check).
 *
 * `openai-shared.ts` `appendResponsesToolResultMessages()` replays
 * `providerMetadata.screenshot` verbatim into `computer_call_output.output`,
 * which accepts only a `computer_screenshot` ref — there is no text part to
 * degrade it to in place, so the caller clears the metadata instead.
 */
async function unreadableComputerScreenshotReason(
	metadata: ToolResultProviderMetadata | undefined,
): Promise<string | null> {
	if (metadata?.type !== "computer") return null;
	const image = inlineImageFromDataUri(metadata.screenshot.image_url);
	return image ? await unreadableImageReason(image) : null;
}

/** `undefined` when the message needs no rewrite. */
async function dropUnreadableFromMessage(message: Message, model: Model): Promise<Message | undefined> {
	switch (message.role) {
		case "user":
		case "developer": {
			// Both views matter, and they can disagree: a native input image is
			// stripped out of generic content and survives only on the payload.
			const content = Array.isArray(message.content)
				? await replaceUnreadableContent(message.content, model)
				: undefined;
			const providerPayload = await replaceUnreadableNativePayload(message.providerPayload);
			if (!content && !providerPayload) return undefined;
			return { ...message, ...(content ? { content } : {}), ...(providerPayload ? { providerPayload } : {}) };
		}
		case "toolResult": {
			const content = await replaceUnreadableContent(message.content, model);
			const screenshotReason = await unreadableComputerScreenshotReason(message.providerMetadata);
			if (!content && screenshotReason === null) return undefined;
			// Dropping the computer metadata is safe here specifically because the
			// provider layer then takes its `computerCallIds` fallback and emits an
			// assistant note built from this result's generic `content`, so the model
			// still learns the call ran and what it reported — the screenshot bytes
			// were the only thing lost, and they were unreadable anyway.
			return {
				...message,
				...(content ? { content } : {}),
				...(screenshotReason === null ? {} : { providerMetadata: undefined }),
			};
		}
		case "assistant":
			// Assistant payloads replay model OUTPUT items (reasoning, tool calls,
			// output text); input images never live there.
			return undefined;
	}
}

/**
 * Last line of defence before the wire: an undecodable image makes the provider
 * reject the entire request rather than the offending block, so one bad payload
 * anywhere in history leaves the session permanently unable to send. Degrades
 * those blocks to text and leaves everything else — including the `context`
 * object itself — untouched.
 *
 * Covers all three places outbound image bytes can hide: generic `content`, the
 * native `providerPayload` items that get replayed in place of that content, and
 * a computer result's `providerMetadata.screenshot`. Only bytes that actually
 * travel are checked — see {@link sendsInlineImageBytes}.
 */
export async function dropUnreadableContextImages(context: Context, model: Model): Promise<Context> {
	let messages: Message[] | undefined;
	for (let index = 0; index < context.messages.length; index++) {
		const rewritten = await dropUnreadableFromMessage(context.messages[index], model);
		if (!rewritten) continue;
		messages ??= [...context.messages];
		messages[index] = rewritten;
	}
	return messages ? { ...context, messages } : context;
}

/**
 * The outbound image pipeline, in the one order that is correct.
 *
 * Order is load-bearing and each step constrains the next, so it lives here as
 * a single callable rather than being re-spelled at each `transformContext`:
 *
 * 1. Count cap FIRST, but only down to a slack multiple of the real cap: the
 *    passes below are per-image expensive (a full decode each, behind a cache a
 *    longer history evicts every request), and a history far past the cap
 *    discards its oldest images regardless of what those passes conclude.
 * 2. Model-specific normalization, which rewrites sizes (WebP conversion,
 *    downscales) and so must precede any byte accounting.
 * 3. The unreadable backstop, after the normalizers because they carry better
 *    wording for the cases they own.
 * 4. The provider's OWN size pass, so step 5 weighs the payload the provider
 *    will really receive. Anthropic downscales every image in a many-image
 *    request to 2000px, which can shrink the wire payload a lot — measuring
 *    before it evicted the oldest images of a request that would have fit once
 *    resized. It also gates on having MORE than 20 images, so a byte clamp
 *    landing first could cut the count to 20 and stop the downscale running at
 *    all. Running it here is safe: an already-small image is returned
 *    untouched, so the provider's own later call is a no-op.
 * 5. Byte budget LAST, over the images that actually travel. Clamping earlier
 *    charged an undecodable image against the budget and evicted an older VALID
 *    one to fit it, and the unreadable pass then replaced the corrupt image too
 *    — so a request lost every image where the readable one would have fit
 *    alone.
 */
export async function applyProviderImagePipeline(
	context: Context,
	model: Model,
	normalizeForModel: (context: Context, model: Model) => Promise<Context>,
	replaysNativeHistory = true,
	decorate?: (context: Context, model: Model) => Promise<Context>,
): Promise<Context> {
	let transformed = clampProviderContextImageCount(context, model, replaysNativeHistory);
	transformed = await normalizeForModel(transformed, model);
	transformed = await dropUnreadableContextImages(transformed, model);
	transformed = await applyProviderSizePass(transformed, model);
	// Decoration BEFORE the byte budget. A successful blob upload turns inline
	// base64 into a provider file or a URL, and a reference puts no bytes on the
	// wire — so clamping first charged bytes the request was about to stop
	// sending and evicted images that would have travelled as references. The
	// count cap is unaffected either way: a reference is still an image part and
	// consumes it, which is why the two budgets are tallied separately.
	if (decorate) transformed = await decorate(transformed, model);
	return clampProviderContextImages(transformed, model, replaysNativeHistory);
}

/**
 * Runs `model`'s provider-side image resizing early, when that provider has
 * one, so the byte budget measures post-resize bytes. Only Anthropic's
 * many-image path resizes today; every other provider is returned unchanged.
 */
function applyProviderSizePass(context: Context, model: Model): Promise<Context> {
	if (model.api !== "anthropic-messages") return Promise.resolve(context);
	return prepareAnthropicManyImageContext(context, model.input.includes("image"));
}

/**
 * The size pass plus the byte budget, in that order, for a caller that has
 * already materialized its images and cannot re-run the whole pipeline.
 *
 * Exists so the blob broker's URL-to-inline recovery does not re-spell the
 * final two stages: it calls the low-level stream fn directly, so
 * `transformProviderContext` never runs again — but clamping bytes without the
 * provider's own downscale charges pre-resize sizes and evicts images a
 * resized payload would have fit.
 */
export async function applyProviderImageByteBudget(
	context: Context,
	model: Model,
	replaysNativeHistory = true,
): Promise<Context> {
	return clampProviderContextImages(await applyProviderSizePass(context, model), model, replaysNativeHistory);
}
