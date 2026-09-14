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
import {
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
} from "@oh-my-pi/pi-ai/utils";
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";
import { sanitizeMalformedToolCalls } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isRecord } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { providerImageByteBudget } from "@oh-my-pi/pi-catalog/compat/behavior";
import { providerImageBudget } from "@oh-my-pi/snapcompact";
import { supportsRemoteImageUrls } from "../blob-broker/context-images";
import { imageDecodeFailureReason } from "../utils/image-loading";

const IMAGE_OMISSION_NOTICE: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

/**
 * A native Responses assistant message the replay sanitizer counts as
 * replayable output. Appended to a full-snapshot payload whose only such output
 * the byte clamp just cleared, so `buildResponsesInput()` still splices the wire
 * on it instead of resurrecting the superseded pre-snapshot history.
 */
const REPLAYED_IMAGE_OMISSION_ITEM: Record<string, unknown> = {
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text: IMAGE_OMISSION_NOTICE.text }],
};

/**
 * Tool-result messages that survive `sanitizeMalformedToolCalls()` — the same
 * predicate `transformMessages()` applies before any converter runs.
 *
 * A persisted assistant tool call with an empty id or name is malformed, so the
 * sanitizer drops BOTH it and its matched tool result before the wire. This
 * traversal must not charge that result's image bytes: charging them let an
 * older VALID image plus the dead result exceed the budget, so oldest-first
 * eviction discarded the valid image while the converter then dropped the
 * malformed pair — the request carried NEITHER, though the live one fit alone.
 *
 * The sanitizer pushes a surviving tool result by REFERENCE and omits a dropped
 * one, so reference membership is an exact "was it dropped" test. Assistant
 * messages it may REWRITE into a new object (filtering a malformed block) still
 * replay their payload, so they are never keyed here; only tool results, which
 * it never rewrites, drive the byte skip below.
 */
function survivingToolResults(context: Context): ReadonlySet<Message> {
	const survivors = new Set<Message>();
	for (const message of sanitizeMalformedToolCalls(context.messages)) {
		if (message.role === "toolResult") survivors.add(message);
	}
	return survivors;
}

/** A tool result the malformed-tool-call sanitizer drops before the wire. */
function droppedByToolCallSanitization(message: Message, survivors: ReadonlySet<Message>): boolean {
	return message.role === "toolResult" && !survivors.has(message);
}

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
	const pairedComputerCallIds = collectPairedComputerCallIds(context, countModel, replaysNativeHistory);
	// Cross-message orphan verdicts: a `computer_call_output` whose paired
	// `computer_call` sits in an EARLIER wire-bound message is not an orphan, even
	// though its own payload starts the known-call set empty. Precomputed once so
	// every accounting pass and the clamp share one verdict — see
	// `collectRepairedOrphanIndices`.
	const { indicesByMessage: repairedOrphansByMessage, orphanToolResults } = collectRepairedOrphanIndices(
		context,
		countModel,
		replaysNativeHistory,
	);
	// Everything before a full-snapshot replacement is spliced off the wire, so
	// it owes neither budget — see `wireStartIndex`.
	const wireStart = wireStartIndex(context, countModel, replaysNativeHistory);
	// A tool result the malformed-tool-call sanitizer drops never reaches the
	// wire, so charging its bytes evicts a live image for a payload the converter
	// already removes — see `survivingToolResults`.
	const survivingResults = survivingToolResults(context);
	for (const message of context.messages.slice(wireStart)) {
		if (message.role === "assistant") {
			// An assistant's generic `content` images are display-only, but its
			// replayed native image results are NOT — see
			// `replayedImageResultSizes`.
			// ONE sequence, in the payload's own item order. `clampAssistantMessage`
			// evicts in that order, so appending all generation results and then all
			// input images let `imageDropCountForBytes` size the allowance against a
			// late oversized result while the clamp spent the drop on an earlier
			// small input — leaving the request over the byte limit and still 413ing.
			const replayedInputs: number[] = [];
			const repairedOrphans = repairedOrphansByMessage.get(message) ?? NO_REPAIRED_ORPHANS;
			if (byteModel !== undefined) {
				inlineSizes.push(
					...replayedPayloadByteSizes(message, byteModel, replaysNativeHistory, repairedOrphans, replayedInputs),
				);
			}
			// A replayed snapshot's retained `input_image` items ARE image parts on
			// the wire, so unlike a generation result they consume the count cap too.
			total +=
				byteModel !== undefined
					? replayedInputs.length
					: replayedAssistantInputImages(message, countModel, replaysNativeHistory, repairedOrphans).length;
			continue;
		}
		// A tool result whose paired call is malformed is dropped by
		// `sanitizeMalformedToolCalls()` before any converter runs, so its image
		// bytes never travel and must not be charged.
		if (droppedByToolCallSanitization(message, survivingResults)) continue;
		// A non-computer tool result whose paired call never reaches the wire is
		// truncated to a 16 KB assistant note by `repairOrphanResponsesToolOutputs()`
		// (or the strict-pairing fold), so its image bytes never travel and must not
		// be charged — the same orphan verdict the payload path applies. See
		// `collectRepairedOrphanIndices`.
		if (message.role === "toolResult" && orphanToolResults.has(message)) continue;
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
		// A demoted replay item's bytes reach the wire as assistant TEXT, so they
		// owe bytes but no image slot — kept out of `replayed` so the count stays
		// right, and pushed into `inlineSizes` so the byte clamp can see them.
		const demotedReplaySizes: number[] = [];
		const replayed = replayedInputImages(
			message,
			byteModel ?? countModel,
			replaysNativeHistory,
			repairedOrphansByMessage.get(message) ?? NO_REPAIRED_ORPHANS,
			demotedReplaySizes,
		);
		total += replayed.length;
		if (byteModel !== undefined) {
			for (const size of replayed) if (size > 0) inlineSizes.push(size);
			for (const size of demotedReplaySizes) inlineSizes.push(size);
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
 * Every byte-carrying entry of a replayed assistant payload, in the payload's
 * OWN item order — which is the order {@link clampAssistantMessage} evicts in.
 *
 * Both kinds interleave: an `image_generation_call` result carries bytes but no
 * image part, while a retained `input_image` carries both. Collecting them in
 * two separate passes produced a size sequence whose order did not match the
 * eviction order, so a drop allowance computed from a late large entry was
 * spent on an early small one and the request stayed over the byte limit.
 *
 * `inputSizes`, when supplied, receives the `input_image` entries alone, since
 * those are the ones that also consume the image COUNT.
 */
function replayedPayloadByteSizes(
	message: AssistantMessage,
	model: Model,
	replaysNativeHistory: boolean,
	repairedOrphans: ReadonlySet<number>,
	inputSizes?: number[],
): number[] {
	const payload = replayableHistoryPayload(message, model, replaysNativeHistory);
	if (!payload) return [];
	const sizes: number[] = [];
	const demotesNativeComputerItems = demotesReplayedComputerItems(model);
	// A `computer_call_output` whose `computer_call` does not precede it — across
	// the WHOLE assembled input, not just this payload — is an orphan
	// `repairOrphanResponsesToolOutputs()` rewrites into a 16 KB-capped assistant
	// note before the wire, so its screenshot never travels and must not be
	// charged. See {@link collectRepairedOrphanIndices}.
	for (let index = 0; index < payload.items.length; index++) {
		if (repairedOrphans.has(index)) continue;
		const item = payload.items[index];
		const result = replayedImageResult(item);
		if (result !== undefined) {
			sizes.push(result.length);
			continue;
		}
		// Demoted to assistant text by the converter, so it holds no image part —
		// but the note it becomes carries the base64 verbatim, so the bytes are
		// charged (to `sizes`) while the count (`inputSizes`) is not.
		if (demotesNativeComputerItems && isReplayedComputerItem(item)) {
			for (const part of nativeInputImageParts(item)) {
				const size = inlineImageFromDataUri(part.image_url)?.data.length ?? 0;
				if (size > 0) sizes.push(size);
			}
			continue;
		}
		for (const part of nativeInputImageParts(item)) {
			const size = inlineImageFromDataUri(part.image_url)?.data.length ?? 0;
			inputSizes?.push(size);
			if (size > 0) sizes.push(size);
		}
	}
	return sizes;
}

/**
 * Image PARTS a replayed assistant payload puts on the wire as image inputs.
 *
 * Separate from {@link replayedImageResultSizes}, which covers
 * `image_generation_call` results — assistant OUTPUT items that carry bytes but
 * consume no image-part slot. A legacy same-model snapshot (`dt` absent or
 * false) is spliced onto the wire WHOLE by `buildResponsesInput()`, so any
 * `input_image` items it retained are sent as ordinary image inputs and consume
 * both budgets. Recording only the generation results left those in neither
 * tally, so an oversized restored session kept failing with 413 and no drop was
 * ever owed.
 *
 * One entry per part, 0 for a reference-backed one — same convention as
 * {@link replayedInputImages}.
 */
function replayedAssistantInputImages(
	message: AssistantMessage,
	model: Model,
	replaysNativeHistory: boolean,
	repairedOrphans: ReadonlySet<number>,
): number[] {
	const payload = replayableHistoryPayload(message, model, replaysNativeHistory);
	if (!payload) return [];
	const sizes: number[] = [];
	const demotesNativeComputerItems = demotesReplayedComputerItems(model);
	// A `computer_call_output` the converter repairs into an assistant note puts
	// no image part on the wire — same cross-message exclusion the byte path and
	// the user/developer replay path apply.
	for (let index = 0; index < payload.items.length; index++) {
		if (repairedOrphans.has(index)) continue;
		const item = payload.items[index];
		// Demoted to assistant text by the converter, so it holds no image part —
		// the same exclusion the user/developer replay path applies.
		if (demotesNativeComputerItems && isReplayedComputerItem(item)) continue;
		for (const part of nativeInputImageParts(item)) {
			sizes.push(inlineImageFromDataUri(part.image_url)?.data.length ?? 0);
		}
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
	// Match `sanitizeOpenAIResponsesImageGenerationCallForReplay`: an item with no
	// valid string `id` is dropped before the request is built, so its result
	// never reaches the wire and must not be charged — otherwise the byte clamp
	// evicts a LIVE image to make room for bytes the converter then discards, and
	// the request ends with neither.
	if (typeof item.id !== "string") return undefined;
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
function replayedInputImages(
	message: Message,
	model: Model,
	replaysNativeHistory: boolean,
	repairedOrphans: ReadonlySet<number>,
	/** Sizes of bytes that travel as TEXT: charged to the byte budget, never counted. */
	demotedSizes: number[] = [],
): number[] {
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
	// A cross-message-aware orphan set, precomputed by {@link collectRepairedOrphanIndices}.
	const demotesNativeComputerItems = demotesReplayedComputerItems(model);
	for (let index = 0; index < payload.items.length; index++) {
		if (repairedOrphans.has(index)) continue;
		// A generation result carries bytes but no image PART: the user/developer
		// replay converter sends it verbatim, exactly as the assistant snapshot
		// does. It is a BYTE-only charge, so it rides the demoted channel — charged
		// to the byte budget, never counted against the image cap. See
		// {@link replayedImageResult} and the assistant path's `replayedPayloadByteSizes`.
		const result = replayedImageResult(payload.items[index]);
		if (result !== undefined) {
			demotedSizes.push(result.length);
			continue;
		}
		// `adaptResponsesReplayItemsForModel()` rewrites a replayed
		// `computer_call`/`computer_call_output` into a short assistant TEXT
		// message when the model does not support computer use, so its screenshot
		// reaches the wire as text and occupies no image part at all. Exposing it
		// here incremented the count, and with more than the cap's worth of
		// URL/file-backed screenshots the count-only clamp evicted real
		// call/output pairs for a request that carries zero image parts.
		if (demotesNativeComputerItems && isReplayedComputerItem(payload.items[index])) {
			// No image slot — but the bytes still travel. The converter stringifies
			// the WHOLE item into an untruncated assistant text message, base64
			// data URI included, so skipping it entirely let several restored
			// screenshots blow the request-size limit while the byte clamp saw
			// zero. Recorded through the demoted channel below, which charges
			// bytes without a count.
			for (const part of nativeInputImageParts(payload.items[index])) {
				const size = inlineImageFromDataUri(part.image_url)?.data.length ?? 0;
				if (size > 0) demotedSizes.push(size);
			}
			continue;
		}
		for (const part of nativeInputImageParts(payload.items[index])) {
			sizes.push(inlineImageFromDataUri(part.image_url)?.data.length ?? 0);
		}
	}
	return sizes;
}

/**
 * Whether this model's converter rewrites REPLAYED native computer items into
 * assistant text.
 *
 * `adaptResponsesReplayItemsForModel()` does this for the SHARED
 * `buildResponsesInput()` adapter (`openai-responses` / `azure-openai-responses`)
 * whenever `supportsComputerUse` is not true, so the item's screenshot travels
 * as text and consumes no image slot on either budget.
 *
 * NOT Codex. `openai-codex-responses` is a Responses route but replays through
 * its own `convertMessages()`, never that shared adapter: it runs
 * `unrollCodexComputerItems()` instead, which turns every `computer_call_output`
 * into a user `input_image` (from `output.image_url` OR `output.file_id`) — an
 * image part on the wire. Treating Codex as demoting therefore charged zero
 * count debt for real screenshots, so a history of more than the cap's worth of
 * URL/file-backed screenshots went out over the provider image limit.
 */
function demotesReplayedComputerItems(model: Model): boolean {
	return (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") && model.supportsComputerUse !== true
	);
}

/** A replayed native computer call or its output. */
function isReplayedComputerItem(item: Record<string, unknown> | undefined): boolean {
	return item?.type === "computer_call" || item?.type === "computer_call_output";
}

/** An empty orphan-index set for a message with no repaired outputs. */
const NO_REPAIRED_ORPHANS: ReadonlySet<number> = new Set<number>();

/**
 * Indices of a payload's replayed `computer_call_output` items the converter
 * will replace with a short assistant note before they reach the wire.
 *
 * `repairOrphanResponsesToolOutputs()` rewrites an output whose `computer_call`
 * does not precede it, truncating the serialized output to 16 KB — so its
 * screenshot never travels, and charging it evicted live images to make room
 * for bytes that were already gone. Only the two routes that pass
 * `repairOrphanOutputs: true` do this; the Codex route replays the orphan
 * unchanged, so there its bytes are real.
 *
 * `precedingWireCalls` carries the raw call ids of every `computer_call` earlier
 * WIRE-BOUND messages already placed on the input — `buildResponsesInput()`
 * repairs orphans only after assembling the COMPLETE input, so a call in an
 * earlier message pairs an output a later payload carries. Seeding the known-call
 * set with them (rather than starting empty per payload) is what makes this
 * helper's verdict match the converter's: a cross-message pair is charged, not
 * skipped as "repaired away" while its oversized screenshot slips the byte clamp.
 *
 * Empty on a DEMOTING model. `buildResponsesInput()` runs
 * `adaptResponsesReplayItemsForModel()` per message FIRST — turning every
 * replayed `computer_call_output` into an untruncated assistant note — and only
 * then `repairOrphanResponsesToolOutputs()`, which by that point sees a
 * `message`, not a `computer_call_output`, and leaves it alone. So a demoted
 * orphan's full bytes DO travel and must be charged: {@link replayedPayloadByteSizes}
 * and {@link replayedInputImages} record them through the demoted channel.
 */
function repairedOrphanItemIndices(
	items: readonly Record<string, unknown>[],
	model: Model,
	precedingWireCalls: ReadonlySet<string>,
): ReadonlySet<number> {
	const repaired = new Set<number>();
	if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") return repaired;
	if (demotesReplayedComputerItems(model)) return repaired;
	const precedingCalls = new Set<string>(precedingWireCalls);
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const callId = typeof item?.call_id === "string" ? item.call_id : undefined;
		if (!callId) continue;
		if (item.type === "computer_call") precedingCalls.add(`computer::${callId}`);
		else if (item.type === "computer_call_output" && !precedingCalls.has(`computer::${callId}`)) repaired.add(index);
	}
	return repaired;
}

/**
 * Adds the RAW wire tool-call id of every replayed call in `items` to `calls`,
 * keyed by kind exactly as `repairOrphanResponsesToolOutputs()` pairs. A demoting
 * model rewrites replayed `computer_call`s into notes before the wire, so its
 * computer calls pair nothing — `includeComputer` gates them out there.
 */
function addReplayedWireCallIdsRaw(
	items: readonly Record<string, unknown>[],
	calls: Set<string>,
	includeComputer: boolean,
): void {
	for (const item of items) {
		if (typeof item.call_id !== "string") continue;
		if (item.type === "function_call") calls.add(`function::${item.call_id}`);
		else if (item.type === "custom_tool_call") calls.add(`custom::${item.call_id}`);
		else if (includeComputer && item.type === "computer_call") calls.add(`computer::${item.call_id}`);
	}
}

/**
 * Both orphan verdicts the accounting and the clamp share, computed in one
 * message walk so they can never drift from what `buildResponsesInput()`
 * concludes over the whole assembled input.
 *
 * `indicesByMessage`: per replaying message, the `computer_call_output` indices
 * `repairOrphanResponsesToolOutputs()` rewrites into a note (never on a demoting
 * model, which turns every replayed computer item into a note first).
 *
 * `orphanToolResults`: live non-computer tool results whose paired call never
 * reaches the wire — a locally-rejected call, or a call a full snapshot spliced
 * away — so the converter truncates the result to a 16 KB assistant note and its
 * image bytes never travel. Computer results are excluded: they ride the
 * screenshot paths, whose demoted note is untruncated.
 *
 * Preceding calls are keyed by kind (`function`/`custom`/`computer`) and RESET at
 * a `dt`-falsy full-snapshot splice, exactly where `convertConversationMessages()`
 * discards everything before it. Only wire-bound carriers contribute: a replayed
 * user/developer payload, a replayed assistant payload, and a live assistant tool
 * call (a computer call only when the model is not demoting).
 */
interface RepairedOrphanVerdicts {
	indicesByMessage: ReadonlyMap<Message, ReadonlySet<number>>;
	orphanToolResults: ReadonlySet<Message>;
}

function collectRepairedOrphanIndices(
	context: Context,
	model: Model,
	replaysNativeHistory: boolean,
): RepairedOrphanVerdicts {
	const indicesByMessage = new Map<Message, ReadonlySet<number>>();
	const orphanToolResults = new Set<Message>();
	// Only the routes that repair orphan outputs; both pass `repairOrphanOutputs`.
	if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") {
		return { indicesByMessage, orphanToolResults };
	}
	const demoting = demotesReplayedComputerItems(model);
	let preceding = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "user" || message.role === "developer") {
			// A replayed user/developer payload is APPENDED — same eligibility the
			// accounting's `replayedInputImages` uses, marker exception included.
			if (!supersedesContentWithReplay(message, model, replaysNativeHistory)) continue;
			const payload = getOpenAIResponsesHistoryPayload(message.providerPayload, model.provider);
			if (!payload) continue;
			indicesByMessage.set(message, repairedOrphanItemIndices(payload.items, model, preceding));
			addReplayedWireCallIdsRaw(payload.items, preceding, !demoting);
			continue;
		}
		if (message.role === "assistant") {
			const payload = replayableHistoryPayload(message, model, replaysNativeHistory);
			if (payload) {
				// A `dt`-falsy payload that really splices replaces the wire, so calls
				// before it precede nothing. Its own calls seed the new prefix.
				if (!payload.dt && splicesItems(payload.items, model)) preceding = new Set<string>();
				indicesByMessage.set(message, repairedOrphanItemIndices(payload.items, model, preceding));
				addReplayedWireCallIdsRaw(payload.items, preceding, !demoting);
				continue;
			}
			// No replayed payload: the converter renders this turn from its blocks, so
			// a live tool call becomes a wire call (its id normalized). A computer call
			// on a demoting model becomes a note instead, so it pairs nothing.
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const callId = normalizeResponsesToolCallId(block.id).callId;
				if (block.providerMetadata?.type === "computer") {
					if (!demoting) preceding.add(`computer::${callId}`);
				} else {
					preceding.add(`${block.customWireName ? "custom" : "function"}::${callId}`);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			// A computer result travels through the screenshot paths, never as an
			// orphan-repaired note here.
			if (message.providerMetadata?.type === "computer") continue;
			const callId = normalizeResponsesToolCallId(message.toolCallId).callId;
			if (!preceding.has(`function::${callId}`) && !preceding.has(`custom::${callId}`)) {
				orphanToolResults.add(message);
			}
		}
	}
	return { indicesByMessage, orphanToolResults };
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
 * `buildResponsesInput()` replays unchanged and which carries its screenshot in
 * its own position rather than inside an `input_image`.
 *
 * A computer screenshot travels as either an inline `output.image_url` data URI
 * OR a server-side `output.file_id` reference. Both are sent as an image input —
 * `buildResponsesInput()` replays the whole output unchanged on a
 * computer-capable model, and Codex's `unrollCodexComputerItems()` rewrites
 * either shape into an `input_image` — so both consume the per-request image
 * COUNT. Recognizing only `image_url` left a file-backed screenshot in neither
 * the tally nor the eviction path, so enough of them busted the count cap with
 * no drop ever owed. Its bytes are 0: `inlineImageFromDataUri` reads nothing
 * from a `file_id`, so it pays only the count, like any reference.
 */
function nativeInputImageParts(item: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	if (!item) return [];
	if (item.type === "input_image") return [item];
	if (item.type === "computer_call_output") {
		const output = item.output;
		if (!isRecord(output)) return [];
		return typeof output.image_url === "string" || typeof output.file_id === "string" ? [output] : [];
	}
	if (!Array.isArray(item.content)) return [];
	return item.content.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "input_image");
}

/**
 * A demoted computer item with its inline screenshot bytes removed, or
 * `undefined` when it carries none to remove.
 *
 * The converter stringifies the whole item into an assistant note, so clearing
 * the data URI is what actually reclaims wire bytes. The item itself stays —
 * dropping it would break the call/output pairing the note preserves — and the
 * omission notice keeps the note self-describing rather than leaving a bare `""`.
 */
function stripDemotedComputerScreenshot(item: Record<string, unknown>): Record<string, unknown> | undefined {
	const parts = nativeInputImageParts(item);
	let changed = false;
	for (const part of parts) {
		const url = part.image_url;
		if (typeof url !== "string" || inlineImageFromDataUri(url) === undefined) continue;
		changed = true;
	}
	if (!changed) return undefined;
	if (item.type === "computer_call_output") {
		const output = item.output;
		if (!isRecord(output)) return undefined;
		return { ...item, output: { ...output, image_url: IMAGE_OMISSION_NOTICE.text } };
	}
	if (item.type === "input_image") return { ...item, image_url: IMAGE_OMISSION_NOTICE.text };
	if (!Array.isArray(item.content)) return undefined;
	return {
		...item,
		content: item.content.map(part =>
			isRecord(part) && part.type === "input_image" && typeof part.image_url === "string"
				? { ...part, image_url: IMAGE_OMISSION_NOTICE.text }
				: part,
		),
	};
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
	// Codex deletes the metadata before converting, so its screenshot travels as
	// a generic content image and must be accounted as one.
	if (!serializesDemotedScreenshotNote(model)) return false;
	return message.providerMetadata?.type === "computer";
}

/** The API routes whose tool results go through `appendResponsesToolResultMessages()`. */
function usesResponsesToolResultConverter(model: Model): boolean {
	return replaysOpenAIResponsesNativeHistory(model);
}

/**
 * Whether this route SERIALIZES a demoted computer screenshot as the
 * metadata-based assistant note.
 *
 * Narrower than {@link usesResponsesToolResultConverter}, and the difference is
 * Codex. `openai-codex-responses` reaches the same converter, but it calls
 * `unrollCodexComputerToolResult()` first, which DELETES `providerMetadata` — so
 * the converter never sees a computer result and encodes the generic content
 * image as an ordinary function result instead. Classifying that as
 * metadata-demoted made `collectImageStats()` skip an image that does travel,
 * leaving the count cap short on a long history.
 */
function serializesDemotedScreenshotNote(model: Model): boolean {
	return usesResponsesToolResultConverter(model) && model.api !== "openai-codex-responses";
}

/**
 * The call ids of every computer tool call still present in this context.
 *
 * Mirrors `collectComputerCallIds` over the generic view: a `computer_call` item
 * is emitted for an assistant tool call whose `providerMetadata.type` is
 * `"computer"`, so that is what pairs a later result's screenshot.
 */
/**
 * Index of the first message that survives onto the wire.
 *
 * `convertConversationMessages()` treats a replayed payload with `dt` falsy as
 * a FULL SNAPSHOT: `messages.splice(0, messages.length, ...wireItems)` throws
 * away everything accumulated before it. Tallying across that boundary counted
 * images the request never sends — a 20 MB user image before a 20 MB snapshot
 * measured 40 MB, so the single computed drop was spent on the image the splice
 * already removes and the snapshot stayed over the limit. The clamp shares this
 * boundary: a drop applied before it reclaims nothing.
 */
function wireStartIndex(context: Context, model: Model, replaysNativeHistory: boolean): number {
	let start = 0;
	for (let index = 0; index < context.messages.length; index++) {
		const message = context.messages[index];
		if (message?.role !== "assistant") continue;
		const payload = replayableHistoryPayload(message, model, replaysNativeHistory);
		if (payload && !payload.dt && splicesItems(payload.items, model)) start = index;
	}
	return start;
}

/**
 * Whether a `dt`-falsy payload's replay items really replace the wire.
 *
 * `convertConversationMessages()` splices only when the sanitizer returns items:
 * a hidden-empty payload (reasoning plus an empty assistant message) sanitizes
 * to `undefined`, the splice never runs, and the earlier history stays on the
 * wire. Advancing the boundary on such a payload excluded those images from
 * BOTH budgets while they still travelled — which is a 413 that no drop is ever
 * owed for.
 */
function splicesItems(items: readonly Record<string, unknown>[], model: Model): boolean {
	return (
		sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(items as Array<Record<string, unknown>>, {
			supportsComputerUse: model.supportsComputerUse === true,
		}) !== undefined
	);
}

/** Adds every replayed `computer_call`'s paired id from `items` into `ids`. */
function addReplayedComputerCallIds(items: readonly Record<string, unknown>[], ids: Set<string>): void {
	for (const item of items) {
		if (item.type !== "computer_call") continue;
		const callId = item.call_id;
		if (typeof callId === "string") ids.add(normalizeComputerCallId(callId));
	}
}

function collectPairedComputerCallIds(context: Context, model: Model, replaysNativeHistory: boolean): Set<string> {
	let ids = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "user" || message.role === "developer") {
			// A user/developer turn's replayed payload is APPENDED to the wire, never
			// spliced: `buildResponsesInput()` pushes its items and adds every
			// `computer_call` among them to `computerCallIds`, so a later matching
			// `toolResult` is emitted as a paired `computer_call_output` carrying
			// `providerMetadata.screenshot`. Skipping this carrier — because it is
			// not an assistant message — left the call out of the pair set, so
			// `sendsComputerScreenshot()` charged and clamped the generic content
			// mirror the converter throws away while the metadata copy that actually
			// travelled stayed in place, and neither budget was relieved. Record
			// those calls so the clamp evicts what the wire really carries. The same
			// eligibility `buildResponsesInput()` replays on (`nativeHistory.replay`
			// or a compaction marker).
			if (supersedesContentWithReplay(message, model, replaysNativeHistory)) {
				const payload = getOpenAIResponsesHistoryPayload(message.providerPayload, model.provider);
				if (payload) addReplayedComputerCallIds(payload.items, ids);
			}
			continue;
		}
		if (message.role !== "assistant") continue;
		// A replayed payload's items are what reach the wire — the converter records
		// their `computer_call`s and SKIPS this turn's generic content. A `dt`-falsy
		// payload that really splices is a full-snapshot replacement, where
		// `convertConversationMessages()` clears the accumulated pair set first (a
		// hidden-empty payload sanitizes to `undefined`, so the splice never runs and
		// the accumulated set still travels). An incremental `dt: true` payload only
		// appends, but its `computer_call`s still pair a later result's screenshot —
		// recording only the splice case left them unpaired, so a metadata screenshot
		// went untallied and an oversized one slipped the clamp. Mirrors
		// `collectRepairedOrphanIndices`.
		const payload = replayableHistoryPayload(message, model, replaysNativeHistory);
		if (payload) {
			if (!payload.dt && splicesItems(payload.items, model)) ids = new Set<string>();
			addReplayedComputerCallIds(payload.items, ids);
			continue;
		}
		if (!Array.isArray(message.content)) continue;
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
	/** First message index that survives onto the wire — see `wireStartIndex`. */
	wireStartIndex: number;
	/**
	 * Cross-message orphan verdicts keyed by message — the same set the accounting
	 * used, so the clamp never evicts a payload item the tally charged (or charges
	 * one it evicts). See `collectRepairedOrphanIndices`.
	 */
	repairedOrphansByMessage: ReadonlyMap<Message, ReadonlySet<number>>;
	/**
	 * Tool results that survive `sanitizeMalformedToolCalls()`. A dropped result
	 * never reaches the wire, so the accounting does not charge it — and the clamp
	 * must not spend an allowance evicting its image either. See
	 * `survivingToolResults`.
	 */
	survivingToolResults: ReadonlySet<Message>;
	/**
	 * Live non-computer tool results the converter truncates to a note because
	 * their paired call never reaches the wire — see `collectRepairedOrphanIndices`.
	 * Their images never travel, so the clamp must not evict them.
	 */
	orphanToolResults: ReadonlySet<Message>;
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
	// This turn's generic content never travels — the accounting skipped it for
	// the same reason. Descending into it spent the allowance on bytes the
	// converter drops, and the `providerPayload: undefined` below would then
	// discard the replay items that ARE the request.
	if (supersedesContentWithReplay(message, state.model, state.replaysNativeHistory))
		return payload ? { ...message, ...payload } : message;
	const content = clampContent(message.content, state);
	if (!content) return payload ? { ...message, ...payload } : message;
	// Dropping a generic image already discards the payload, which is where the
	// replayed copy of that same image lives.
	return { ...message, content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE], providerPayload: undefined };
}

function clampDeveloperMessage(message: DeveloperMessage, state: ImageClampState): DeveloperMessage {
	const payload = clampReplayedInputImages(message, state);
	if (!Array.isArray(message.content) || !clampWanted(state)) return payload ? { ...message, ...payload } : message;
	if (supersedesContentWithReplay(message, state.model, state.replaysNativeHistory))
		return payload ? { ...message, ...payload } : message;
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
		// Clearing the metadata CHANGES THE ROUTE: without it the result is no
		// longer a computer result, so `appendResponsesToolResultMessages()` stops
		// demoting and sends the generic content image instead. Redacting the
		// metadata alone therefore reclaimed nothing — the same bytes travelled as
		// the mirror. Drop the mirror in the same edit, unpaid: its bytes were
		// charged once, through the metadata.
		// Unconditionally, not through `clampContent`: blob decoration may have
		// attached a supported URL or provider-file reference to the mirror, which
		// `clampContent` classifies as non-inline and leaves alone under
		// `remainingDrops: 0`. Clearing the metadata below then reroutes the result
		// through the generic image converter, creating an image part the tally
		// deliberately did not count — so the request goes over the COUNT cap
		// instead of the byte one. The mirror's bytes were charged once, through
		// the metadata, so removing it here is unpaid whatever its reference shape.
		const mirrored = message.content.filter(part => part.type !== "image");
		const mirrorChanged = mirrored.length !== message.content.length;
		return {
			...message,
			providerMetadata: undefined,
			content: mirrorChanged && mirrored.length === 0 ? [IMAGE_OMISSION_NOTICE] : mirrored,
		};
	}
	// Dropping the metadata screenshot already removes this result's only wire
	// image, so the mirrored content block must not also pay down a budget — it
	// was never charged one.
	if (sendsComputerScreenshot(message, state.model, state.pairedComputerCallIds)) {
		if (!clampComputerScreenshot(message, state)) return message;

		// Clearing `providerMetadata` reroutes this result through the generic
		// converter, which builds its output — and, when the call is unpaired, its
		// fallback note — from `content`. The mirrored screenshot was charged once
		// through the metadata, so drop the image blocks here unpaid while RETAINING
		// the tool's text; replacing the whole content with the omission notice would
		// silently lose that text.
		const retained = message.content.filter(part => part.type !== "image");
		return {
			...message,
			content: retained.length > 0 ? retained : [IMAGE_OMISSION_NOTICE],
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
	const demotesNativeComputerItems = demotesReplayedComputerItems(state.model);
	const repairedOrphans = state.repairedOrphansByMessage.get(message) ?? NO_REPAIRED_ORPHANS;
	for (let index = 0; index < payload.items.length; index++) {
		if (!clampWanted(state)) break;
		if (repairedOrphans.has(index)) continue;
		const item = payload.items[index];
		// A generation result answers a BYTE drop only, so clear its `result` while
		// byte pressure remains — the same edit `clampAssistantMessage` makes on the
		// assistant snapshot. Emptying it stops the replay (the sanitizer drops an
		// empty result) while the payload's other items survive.
		if (replayedImageResult(item) !== undefined) {
			if (state.remainingInlineDrops <= 0) continue;
			state.remainingInlineDrops--;
			items ??= [...payload.items];
			items[index] = { ...item, result: "" };
			continue;
		}
		if (item?.type === "computer_call_output") {
			const [screenshot] = nativeInputImageParts(item);
			if (!screenshot) continue;
			// On a model that DEMOTES replayed computer items the converter
			// stringifies this output into assistant text, so it puts no image part
			// on the wire and the accounting deliberately leaves it out of the count
			// tally. Paying a count drop for it therefore reclaims nothing the count
			// cap measures, while spending an allowance a later real image needs —
			// so the request can stay over the cap. Bytes only, like the assistant
			// path, which already splits the two for the same reason.
			if (demotesNativeComputerItems) {
				if (state.remainingInlineDrops <= 0 || !isInlineNativeImage(screenshot)) continue;
				// A demoted output with NO call id cannot be removed by the id-keyed
				// exclusion below — so the converter would serialize its untouched
				// data URI into the assistant note while the clamp already booked the
				// byte debt as paid, and the oversized request would ship unchanged.
				// Strip the screenshot IN PLACE by index, exactly as the
				// assistant-payload path does; the id-keyed path stays for the rest.
				if (typeof item.call_id !== "string") {
					const stripped = stripDemotedComputerScreenshot(item);
					if (!stripped) continue;
					state.remainingInlineDrops--;
					items ??= [...payload.items];
					items[index] = stripped;
					continue;
				}
				state.remainingInlineDrops--;
			} else {
				if (!dropsNativeInputImage(screenshot, state)) continue;
				payNativeInputImageDrop(screenshot, state);
			}
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
	if (!clampWanted(state)) return message;
	// Same eligibility gate as the accounting: never rewrite a payload this
	// request was not going to replay anyway.
	const payload = replayableHistoryPayload(message, state.model, state.replaysNativeHistory);
	if (!payload) return message;
	const demotesNativeComputerItems = demotesReplayedComputerItems(state.model);
	let items: Array<Record<string, unknown>> | undefined;
	// Call ids of the computer outputs evicted below. Their paired `computer_call`
	// goes with them, the same rule `clampReplayedInputImages` applies: a
	// `computer_call_output.output` accepts only a real `computer_screenshot` ref
	// with nothing to degrade it to in place, and a call left without its output
	// is an orphan the provider rejects.
	const droppedComputerCallIds = new Set<string>();
	// A `computer_call_output` the converter repairs into an assistant note puts
	// no bytes and no image part on the wire, so the accounting never charged it —
	// evicting it here would spend an allowance a real image needs. Same skip the
	// accounting and the user/developer eviction path apply.
	const repairedOrphans = state.repairedOrphansByMessage.get(message) ?? NO_REPAIRED_ORPHANS;
	for (let index = 0; index < payload.items.length; index++) {
		if (!clampWanted(state)) break;
		if (repairedOrphans.has(index)) continue;
		const item = payload.items[index];
		if (!item) continue;
		// A generation result carries bytes but no image part, so it answers only
		// a byte drop.
		if (replayedImageResult(item) !== undefined) {
			if (state.remainingInlineDrops <= 0) continue;
			state.remainingInlineDrops--;
			items ??= [...payload.items];
			items[index] = { ...item, result: "" };
			continue;
		}
		// A demoted computer item holds no image PART — the converter stringifies
		// it into assistant text — but its base64 still travels inside that text,
		// so it answers a BYTE drop only. Skipping it entirely charged bytes the
		// clamp could never reclaim, which is a tally that can only fail closed.
		if (demotesNativeComputerItems && isReplayedComputerItem(item)) {
			if (state.remainingInlineDrops <= 0) continue;
			const stripped = stripDemotedComputerScreenshot(item);
			if (!stripped) continue;
			state.remainingInlineDrops--;
			items ??= [...payload.items];
			items[index] = stripped;
			continue;
		}
		// A `computer_call_output` a computer-capable model replays natively carries
		// its screenshot in `output.image_url`, NOT an `input_image` — so
		// `dropNativeInputImages` never touches it and the byte the accounting
		// already charged could never be reclaimed. Evict the paired call + output,
		// the same in-place-degrade-is-impossible path `clampReplayedInputImages`
		// takes for a user/developer snapshot. It IS an image part on the wire, so
		// it answers a count drop as well.
		if (item.type === "computer_call_output") {
			const [screenshot] = nativeInputImageParts(item);
			if (!screenshot || !dropsNativeInputImage(screenshot, state)) continue;
			payNativeInputImageDrop(screenshot, state);
			if (typeof item.call_id === "string") droppedComputerCallIds.add(item.call_id);
			items ??= [...payload.items];
			continue;
		}
		// A retained `input_image` in a spliced snapshot IS an image part, so it
		// answers a count drop as well — and must be evictable, or the count pass
		// charges an image nothing can reclaim.
		const dropped = dropNativeInputImages(item, state);
		if (!dropped) continue;
		items ??= [...payload.items];
		items[index] = dropped;
	}
	if (!items) return message;
	let surviving =
		droppedComputerCallIds.size > 0
			? items.filter(item => !isDroppedComputerItem(item, droppedComputerCallIds))
			: items;
	// A full-snapshot payload (`dt` falsy) splices the whole wire only while the
	// replay sanitizer still returns output. When its ONLY replayable output was
	// an oversized `image_generation_call` we just emptied, the sanitizer now
	// returns `undefined`: `buildResponsesInput()` stops treating it as a snapshot
	// and does not splice, resurrecting the superseded pre-snapshot history that
	// `dropSplicedOffImages()` already stripped — the request loses the snapshot
	// AND regains stale context. Retain a replayable omission item so the splice
	// still runs.
	if (!payload.dt && splicesItems(payload.items, state.model) && !splicesItems(surviving, state.model)) {
		surviving = [...surviving, REPLAYED_IMAGE_OMISSION_ITEM];
	}
	return { ...message, providerPayload: { ...payload, items: surviving } };
}

/** Applies an already-computed drop allowance oldest-first across the context. */
function applyImageClamp(context: Context, state: ImageClampState): Context {
	const messages = context.messages.map((message, index) => {
		// Before the splice boundary nothing reaches the wire, so a drop applied
		// here reclaims no bytes while consuming the allowance the surviving
		// payload needs.
		if (index < state.wireStartIndex) return message;
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				// A result the malformed-tool-call sanitizer drops, or a non-computer
				// orphan the converter truncates to a note, never sends its image — so
				// evicting it here would spend an allowance a live image needs.
				if (
					droppedByToolCallSanitization(message, state.survivingToolResults) ||
					state.orphanToolResults.has(message)
				) {
					return message;
				}
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
	return clampImageCountToCap(
		context,
		model,
		replaysNativeHistory,
		providerImageBudget(model.provider) * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK),
	);
}

/**
 * Drops oldest image parts until the count fits `cap`, ignoring bytes. The count
 * pass runs it against a slack multiple of the provider cap; the pipeline runs
 * it again against the EXACT cap once the decode and size passes have settled
 * the final count, so decoration only ever uploads images the request can send.
 */
function clampImageCountToCap(context: Context, model: Model, replaysNativeHistory: boolean, cap: number): Context {
	// A replayed generation result is not an image part, so it never reaches this
	// tally — but a replayed `input_image` IS one, so this pass needs the same
	// replay decision the byte pass gets. Hard-coding it let a payload the request
	// would not send justify dropping generic images it WOULD.
	const countDrops = collectImageStats(context, undefined, replaysNativeHistory, model).total - cap;
	if (countDrops <= 0) return context;
	const orphanVerdicts = collectRepairedOrphanIndices(context, model, replaysNativeHistory);
	return applyImageClamp(context, {
		remainingDrops: countDrops,
		remainingInlineDrops: 0,
		model,
		replaysNativeHistory,
		// Same set the accounting used: a clamp deciding pairing differently from
		// the tally clears metadata whose mirror then travels instead.
		pairedComputerCallIds: collectPairedComputerCallIds(context, model, replaysNativeHistory),
		wireStartIndex: wireStartIndex(context, model, replaysNativeHistory),
		repairedOrphansByMessage: orphanVerdicts.indicesByMessage,
		orphanToolResults: orphanVerdicts.orphanToolResults,
		survivingToolResults: survivingToolResults(context),
	});
}

/** Drops oldest transient image blocks so outgoing vision requests fit the
 *  active provider's image budget — both the per-request image COUNT cap and the
 *  combined image-BYTE cap (a long snapcompact archive can stay under the count
 *  cap yet bust the request-size limit on summed frame bytes). */
export function clampProviderContextImages(context: Context, model: Model, replaysNativeHistory = true): Context {
	// The byte budget runs REGARDLESS of vision capability. A text-only Responses
	// model still receives a demoted computer screenshot's full data URI as an
	// assistant text note: `appendResponsesToolResultMessages()` serializes
	// `providerMetadata.screenshot` untruncated whenever `supportsComputerUse` is
	// not true, so those bytes reach the wire even though no image PART does. The
	// old `!model.input.includes("image")` early return skipped the clamp
	// entirely, so one oversized retained screenshot 413'd the switched session.
	const acceptsImages = model.input.includes("image");
	const { total, inlineSizes } = collectImageStats(context, model, replaysNativeHistory, model);
	// Not `total === 0`: a replayed native image result contributes bytes but no
	// image part, so a context whose only images are generated ones has
	// `total === 0` and a payload that can still bust the byte budget.
	if (total === 0 && inlineSizes.length === 0) return context;
	// A model that cannot accept images sends no image PART on the wire — its
	// content images are omitted and its computer screenshots demote to text — so
	// the per-request COUNT cap is meaningless there and only the BYTE budget
	// binds. Charging count debt would evict a call/output pair for a request
	// that carries zero image parts.
	const countDrops = acceptsImages ? Math.max(0, total - providerImageBudget(model.provider)) : 0;
	const inlineDrops = imageDropCountForBytes(inlineSizes, providerImageByteBudget(model.provider, model.api));
	if (countDrops === 0 && inlineDrops === 0) return context;
	const orphanVerdicts = collectRepairedOrphanIndices(context, model, replaysNativeHistory);

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
		// Same set the accounting used: a clamp deciding pairing differently from
		// the tally clears metadata whose mirror then travels instead.
		pairedComputerCallIds: collectPairedComputerCallIds(context, model, replaysNativeHistory),
		wireStartIndex: wireStartIndex(context, model, replaysNativeHistory),
		repairedOrphansByMessage: orphanVerdicts.indicesByMessage,
		orphanToolResults: orphanVerdicts.orphanToolResults,
		survivingToolResults: survivingToolResults(context),
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
	// A model that cannot accept images omits a generic content image on the wire
	// — `convertResponsesInputContent()` partitions it out and leaves a text
	// placeholder — so its inline bytes never travel and must not be charged.
	// A demoted computer screenshot is accounted separately, through its
	// metadata, not this block.
	if (!model.input.includes("image")) return false;
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
 *    resized.
 * 5. The EXACT count cap, now that the decode pass has settled which images
 *    survive. Decoration (step 6) uploads a blob for every image it sees, so
 *    the count must be at its final value BEFORE it runs or a request holding
 *    up to 2x the cap publishes blobs the byte-budget clamp then discards.
 * 6. Decoration, then the provider SIZE pass over what is still inline, then
 *    the byte budget LAST, over the images that actually travel. Sizing after
 *    decoration keeps a decode and lossy re-encode off every image that became
 *    a reference and puts no base64 on the wire at all. Clamping bytes earlier charged an undecodable image against the
 *    budget and evicted an older VALID one to fit it, and the unreadable pass
 *    then replaced the corrupt image too — so a request lost every image where
 *    the readable one would have fit alone.
 */
export async function applyProviderImagePipeline(
	context: Context,
	model: Model,
	normalizeForModel: (context: Context, model: Model) => Promise<Context>,
	replaysNativeHistory = true,
	decorate?: (context: Context, model: Model) => Promise<Context>,
): Promise<Context> {
	let transformed = clampProviderContextImageCount(context, model, replaysNativeHistory);
	// Strip the image DATA a full snapshot splices off the wire before the
	// expensive stages run. `normalizeForModel()`, `dropUnreadableContextImages()`
	// and the provider size pass all traverse the whole context, so without this
	// every pre-snapshot image is decoded and re-encoded on each request even
	// though none of them can reach the provider — which is the image-processing
	// bound the count pass exists to hold.
	transformed = dropSplicedOffImages(transformed, model, replaysNativeHistory);
	transformed = await normalizeForModel(transformed, model);
	transformed = await dropUnreadableContextImages(transformed, model);
	// Enforce the EXACT count cap before decoration. The first count pass kept a
	// slack multiple so the decode pass could consume the overage out of images
	// that fail it; those passes have now run, so the survivors are final. A
	// request holding between 1x and 2x the cap still carries every survivor here,
	// and decoration uploads/publishes each one — so without this clamp a blob for
	// every one of 180 valid images is created when only 90 can be sent. Bytes
	// stay for the post-decoration clamp: a reference carries none, so byte
	// accounting is only correct once decoration has settled which images travel
	// inline.
	transformed = clampImageCountToCap(transformed, model, replaysNativeHistory, providerImageBudget(model.provider));
	// Decoration BEFORE the byte budget. A successful blob upload turns inline
	// base64 into a provider file or a URL, and a reference puts no bytes on the
	// wire — so clamping first charged bytes the request was about to stop
	// sending and evicted images that would have travelled as references. The
	// count cap is unaffected either way: a reference is still an image part and
	// consumes it, which is why the two budgets are tallied separately.
	if (decorate) transformed = await decorate(transformed, model);
	// Provider sizing runs AFTER decoration, over what is still INLINE. An image
	// decoration turned into a URL or provider file puts no base64 on the wire,
	// and `resizeAnthropicManyImageContent()` skips a referenced block anyway —
	// so sizing first decoded and lossily re-encoded survivors that were about to
	// stop being bytes at all. The count cap above is unaffected: it is already
	// exact, and an already-small image is returned untouched, so the provider's
	// own later call stays a no-op. If a reference is later abandoned, the
	// fallback path re-inlines it through `applyProviderImageByteBudget()`, which
	// runs this same size pass over the re-inlined bytes.
	transformed = await applyProviderSizePass(transformed, model);
	return clampProviderContextImages(transformed, model, replaysNativeHistory);
}

/**
 * Replaces the image parts of messages a full snapshot splices off the wire.
 *
 * Only the parts a snapshot REPLACES: the surviving payload and everything at
 * or after it is untouched, and a request with no such snapshot is returned as
 * is, so the common path costs one boundary scan.
 *
 * A pre-boundary user/developer turn also carries its native `input_image`
 * items on `providerPayload`, which the full snapshot splices off the wire just
 * like the generic content — but `dropUnreadableContextImages()` still walks and
 * DECODES every one of them. Dropping the whole payload here is safe precisely
 * because the splice discards this turn entirely: nothing on it reaches the
 * provider, so no compaction marker or call id it holds is load-bearing.
 */
function splicesNativeImagePayload(message: Message): boolean {
	if (message.role !== "user" && message.role !== "developer") return false;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return false;
	return payload.items.some(item => nativeInputImageParts(item).length > 0);
}

function dropSplicedOffImages(context: Context, model: Model, replaysNativeHistory: boolean): Context {
	const wireStart = wireStartIndex(context, model, replaysNativeHistory);
	if (wireStart === 0) return context;
	let changed = false;
	const messages = context.messages.map((message, index) => {
		if (index >= wireStart) return message;
		const dropsPayload = splicesNativeImagePayload(message);
		const content = Array.isArray(message.content)
			? message.content.filter(part => part.type !== "image")
			: undefined;
		const dropsContent = content !== undefined && content.length !== message.content.length;
		if (!dropsPayload && !dropsContent) return message;
		changed = true;
		return {
			...message,
			...(dropsContent && content ? { content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE] } : {}),
			...(dropsPayload ? { providerPayload: undefined } : {}),
		} as Message;
	});
	return changed ? { ...context, messages } : context;
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
