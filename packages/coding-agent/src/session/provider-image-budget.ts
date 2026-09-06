import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Message,
	Model,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
	ToolResultProviderMetadata,
	UserMessage,
} from "@oh-my-pi/pi-ai";
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
 * The two budgets count different populations, so they are tallied separately.
 * The COUNT cap is a per-request image cap the provider applies to every image
 * part, reference-backed or not, so references consume it. The BYTE cap bounds
 * the base64 payload actually put on the wire, so an image the provider
 * resolves from a reference contributes no bytes. Conflating them either
 * over-drops (charging reference bytes that never travel) or under-drops
 * (letting references push the request past the image count).
 */
function collectImageStats(context: Context, model: Model): { total: number; inlineSizes: number[] } {
	let total = 0;
	const inlineSizes: number[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		// An assistant image is a display artifact that NO provider accepts in a
		// replay turn: `transform-messages.ts` drops every assistant image block
		// unconditionally, and the native Responses result rides in
		// `providerPayload` instead. Its base64 therefore never reaches the wire,
		// so charging it against the byte budget would evict a live user or tool
		// image in its place — an old 7 MB generated artifact could push a small
		// current screenshot out on its own.
		const contributesBytes = message.role !== "assistant";
		for (const part of message.content) {
			if (part.type !== "image") continue;
			total++;
			if (contributesBytes && sendsInlineImageBytes(part, model)) inlineSizes.push(part.data.length);
		}
	}
	return { total, inlineSizes };
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
	if (!Array.isArray(message.content) || !clampWanted(state)) return message;
	const content = clampContent(message.content, state);
	return content
		? { ...message, content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE], providerPayload: undefined }
		: message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: ImageClampState): DeveloperMessage {
	if (!Array.isArray(message.content) || !clampWanted(state)) return message;
	const content = clampContent(message.content, state);
	return content
		? { ...message, content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE], providerPayload: undefined }
		: message;
}

function clampToolResultMessage(message: ToolResultMessage, state: ImageClampState): ToolResultMessage {
	if (!clampWanted(state)) return message;
	const content = clampContent(message.content, state);
	if (!content) return message;
	return { ...message, content: content.length > 0 ? content : [IMAGE_OMISSION_NOTICE] };
}

/** Drops oldest transient image blocks so outgoing vision requests fit the
 *  active provider's image budget — both the per-request image COUNT cap and the
 *  combined image-BYTE cap (a long snapcompact archive can stay under the count
 *  cap yet bust the request-size limit on summed frame bytes). */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const { total, inlineSizes } = collectImageStats(context, model);
	if (total === 0) return context;
	const countDrops = Math.max(0, total - providerImageBudget(model.provider));
	const inlineDrops = imageDropCountForBytes(inlineSizes, providerImageByteBudget(model.provider));
	if (countDrops === 0 && inlineDrops === 0) return context;

	// The two budgets are tracked as SEPARATE remaining constraints rather than
	// collapsed with max(): a reference-backed drop satisfies the count cap but
	// relieves no bytes, so one shared counter lets references absorb the whole
	// allowance and leaves the request over the byte budget (and still 413ing).
	// `inlineDrops` is the number of INLINE images that must go; `countDrops` is
	// the number of image parts of any kind. A dropped inline image pays down
	// both.
	const state = { remainingDrops: countDrops, remainingInlineDrops: inlineDrops, model };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				// Assistant images count toward the drop budget but are never
				// themselves dropped — matching the pre-existing count-cap
				// invariant, since snapcompact frames ride in user/tool messages.
				return message;
		}
		return message;
	});
	return { ...context, messages };
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
