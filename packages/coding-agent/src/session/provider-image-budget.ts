import type {
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
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";
import { getOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { isRecord } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { providerImageBudget, providerImageByteBudget } from "@oh-my-pi/snapcompact";
import { supportsRemoteImageUrls } from "../blob-broker/context-images";
import { imageDecodeFailureReason } from "../utils/image-loading";

const IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

/** The same marker in the shape the Responses input schema accepts in an `input_image` position. */
const NATIVE_IMAGE_OMISSION: Record<string, unknown> = { type: "input_text", text: IMAGE_OMISSION.text };

/**
 * Providers skip blocks that carry nothing and then skip the message itself, so
 * a turn clamped down to no images and no non-blank text vanishes from the wire
 * (an image-only user turn arrives as `[{ type: "text", text: "" }]`).
 */
function withOmissionFallback(content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const survives = content.some(part => (part.type === "text" ? part.text.trim().length > 0 : true));
	return survives ? content : [IMAGE_OMISSION];
}

/**
 * The replayed native Responses payload when its items are what this message
 * actually sends, else `undefined` for the generic `content` view.
 *
 * `openai-shared.ts` `buildResponsesInput()` pushes these items and `continue`s
 * past `convertResponsesInputContent`, so content is not sent at all for such a
 * message — and `openai-responses-server.ts` `inputContentParts()` keeps only
 * text in that content, so a client's image can live nowhere else. Counting
 * content here would bill blocks the provider never receives while the images
 * that do travel stay invisible to both caps.
 */
function replayedNativePayload(message: Message, model: Model): OpenAIResponsesHistoryPayload | undefined {
	if (message.role !== "user" && message.role !== "developer") return undefined;
	switch (model.api) {
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return getOpenAIResponsesHistoryPayload(message.providerPayload, model.provider);
		default:
			return undefined;
	}
}

/**
 * Base64 length of an `input_image` part, `0` for a `file_id` or `https:`
 * reference the provider resolves itself, and `undefined` when the part is not
 * an image. Reference-backed parts still occupy the count budget, exactly as a
 * reference-backed {@link ImageContent} with empty `data` does.
 */
function nativeImageBytes(part: unknown): number | undefined {
	if (!isRecord(part) || part.type !== "input_image") return undefined;
	const imageUrl = part.image_url;
	if (typeof imageUrl !== "string" || imageUrl.slice(0, 5).toLowerCase() !== "data:") return 0;
	const comma = imageUrl.indexOf(",");
	return comma < 0 ? 0 : imageUrl.length - comma - 1;
}

/** Appends the size of every replayed image, in wire order. An image sits on the item or in `item.content`. */
function collectNativeImageSizes(items: readonly Record<string, unknown>[], sizes: number[]): void {
	for (const item of items) {
		const topLevel = nativeImageBytes(item);
		if (topLevel !== undefined) {
			sizes.push(topLevel);
			continue;
		}
		if (!Array.isArray(item.content)) continue;
		for (const part of item.content) {
			const bytes = nativeImageBytes(part);
			if (bytes !== undefined) sizes.push(bytes);
		}
	}
}

/** Image sizes in message order; assistant images are never dropped, so their bytes are charged as retained. */
function imageStats(context: Context, model: Model): { droppable: number[]; retainedBytes: number; total: number } {
	const droppable: number[] = [];
	let retained = 0;
	let retainedBytes = 0;
	for (const message of context.messages) {
		const native = replayedNativePayload(message, model);
		if (native) {
			collectNativeImageSizes(native.items, droppable);
			continue;
		}
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "image") continue;
			if (message.role === "assistant") {
				retained++;
				retainedBytes += part.data.length;
			} else {
				droppable.push(part.data.length);
			}
		}
	}
	return { droppable, retainedBytes, total: droppable.length + retained };
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: { remainingDrops: number },
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			continue;
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

/**
 * `undefined` when nothing was dropped. Each removed image degrades to the
 * `input_text` marker the Responses input schema accepts in its position, so
 * the surrounding item keeps its shape, its ids, and its `compaction` /
 * `compaction_summary` markers — clearing the payload instead would trade an
 * oversized request for silent history loss.
 */
function clampNativeItems(
	items: readonly Record<string, unknown>[],
	state: { remainingDrops: number },
): Array<Record<string, unknown>> | undefined {
	let clamped: Array<Record<string, unknown>> | undefined;
	for (let index = 0; index < items.length && state.remainingDrops > 0; index++) {
		const item = items[index]!;
		if (nativeImageBytes(item) !== undefined) {
			state.remainingDrops--;
			clamped ??= [...items];
			clamped[index] = NATIVE_IMAGE_OMISSION;
			continue;
		}
		if (!Array.isArray(item.content)) continue;
		let content: unknown[] | undefined;
		for (let part = 0; part < item.content.length && state.remainingDrops > 0; part++) {
			if (nativeImageBytes(item.content[part]) === undefined) continue;
			state.remainingDrops--;
			content ??= [...item.content];
			content[part] = NATIVE_IMAGE_OMISSION;
		}
		if (!content) continue;
		clamped ??= [...items];
		clamped[index] = { ...item, content };
	}
	return clamped;
}

function clampNativeMessage<T extends UserMessage | DeveloperMessage>(
	message: T,
	payload: OpenAIResponsesHistoryPayload,
	state: { remainingDrops: number },
): T {
	const items = clampNativeItems(payload.items, state);
	return items ? { ...message, providerPayload: { ...payload, items } } : message;
}

function clampGenericMessage<T extends UserMessage | DeveloperMessage>(
	message: T,
	state: { remainingDrops: number },
): T {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content: withOmissionFallback(content), providerPayload: undefined } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: { remainingDrops: number }): ToolResultMessage {
	if (state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	if (!content) return message;
	return { ...message, content: withOmissionFallback(content) };
}

/** Drops oldest transient image blocks so outgoing vision requests fit the active provider's image and byte caps. */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const { droppable, retainedBytes, total } = imageStats(context, model);
	let drops = Math.max(0, total - providerImageBudget(model.provider, model.api));
	const byteLimit = providerImageByteBudget(model.provider);
	if (byteLimit !== undefined) {
		let kept = retainedBytes;
		for (let index = Math.min(drops, droppable.length); index < droppable.length; index++) {
			kept += droppable[index] ?? 0;
		}
		while (drops < droppable.length && kept > byteLimit) {
			kept -= droppable[drops] ?? 0;
			drops++;
		}
	}
	if (drops === 0) return context;

	const state = { remainingDrops: drops };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
			case "developer": {
				const native = replayedNativePayload(message, model);
				return native ? clampNativeMessage(message, native, state) : clampGenericMessage(message, state);
			}
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
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
