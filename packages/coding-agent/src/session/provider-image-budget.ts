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
import { reachesBudgetedHost } from "@oh-my-pi/pi-ai";
import { decodeDataUri } from "@oh-my-pi/pi-ai/providers/openai-data-uri";
import { resolveFactoryDroidPolicy } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { resolveInlineImageByteBudget, resolveRequestBodyByteLimit } from "@oh-my-pi/pi-catalog/compat/request-size";
import { isRecord } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { capFrameDataBytes, frameDataBytesBudget, providerImageBudget } from "@oh-my-pi/snapcompact";
import { supportsRemoteImageUrls } from "../blob-broker/context-images";
import { imageDecodeFailureReason } from "@oh-my-pi/pi-tui/chat/image-loading";

const IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

/**
 * Body bytes added after the clamp sees the context: injected reminders, the provider's own system prompt, and
 * request fields (model, limits, thinking, stream). Reserved before protecting images against a body limit.
 */
const REQUEST_ENVELOPE_BYTES = 64_000;

/**
 * Images the clamp below is actually able to remove, and therefore the only
 * ones worth charging against the provider budget.
 *
 * Assistant turns are excluded on purpose. An assistant `ImageContent` is a
 * model OUTPUT (the Responses image-generation tool appends one per
 * `image_generation_call`), and no serializer sends it back as an input image:
 * `convertResponsesAssistantMessage` skips every block that is not text,
 * thinking, or a tool call, and the Anthropic replay branch has no `image`
 * arm at all. So an assistant image never occupies an input-image slot, and
 * counting it inflates the drop budget until the clamp starts evicting user
 * and tool-result images the provider was perfectly happy to accept.
 *
 * A computer result on a route that sends its metadata screenshot counts as
 * that one image, whatever its content holds ({@link sentScreenshotBytes}).
 */
function countImages(context: Context, metadataWire: boolean): number {
	let count = 0;
	for (const message of context.messages) {
		if (message.role === "assistant") continue;
		if (sentScreenshotBytes(message, metadataWire) !== undefined) {
			count++;
			continue;
		}
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

function inlineImageBytes(image: ImageContent, model: Model): number {
	// Match the reference/inline decision shared with the outbound image guard.
	if (!sendsInlineImageBytes(image, model)) return 0;
	return image.data.length; // Base64 is ASCII, so character count equals JSON byte count.
}

/**
 * Whether `model`'s request sends a computer result's `providerMetadata.screenshot` in place of its content image.
 * The Responses wire does (`appendResponsesToolResultMessages`: a `computer_call_output`, or an assistant note quoting
 * it on a model without native computer use), except Codex without native computer use, which unrolls the result to its
 * content. Every other wire sends only the content. Factory Droid sends each model over its registry wire.
 */
function sendsComputerScreenshotMetadata(model: Model): boolean {
	const api = model.api === "factory-droid-agent" ? resolveFactoryDroidPolicy(model)?.wire : model.api;
	switch (api) {
		case "openai-responses":
		case "azure-openai-responses":
			return true;
		case "openai-codex-responses":
			return model.supportsComputerUse === true;
		default:
			return false;
	}
}

/**
 * Inline bytes of a computer result's `providerMetadata.screenshot` on a route that sends it in place of the result's
 * content ({@link sendsComputerScreenshotMetadata}), or `undefined` where the route sends the content. On such a route
 * the result's content images never travel, and a `file_id` screenshot costs nothing.
 */
function sentScreenshotBytes(message: Message, metadataWire: boolean): number | undefined {
	if (!metadataWire || message.role !== "toolResult" || message.providerMetadata?.type !== "computer")
		return undefined;
	const imageUrl = message.providerMetadata.screenshot.image_url;
	return imageUrl?.slice(0, 5).toLowerCase() === "data:" ? imageUrl.length : 0;
}

/** Inline image bytes a user, developer or tool-result message puts on the wire. */
function sentImageBytes(message: Message, model: Model, metadataWire: boolean): number {
	const screenshot = sentScreenshotBytes(message, metadataWire);
	if (screenshot !== undefined) return screenshot;
	if (!Array.isArray(message.content)) return 0;
	let bytes = 0;
	for (const part of message.content) {
		if (part.type === "image") bytes += inlineImageBytes(part, model);
	}
	return bytes;
}

interface ImageBudgetState {
	remainingDrops: number;
	inlineBytes: number;
	byteBudget: number;
	model: Model;
	/** {@link sendsComputerScreenshotMetadata} for `model`. */
	metadataWire: boolean;
	/** Messages whose images the byte clamp must not evict. */
	kept?: ReadonlySet<Message>;
}

function needsImageDrop(state: ImageBudgetState): boolean {
	return state.remainingDrops > 0 || state.inlineBytes > state.byteBudget;
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: ImageBudgetState,
): (TextContent | ImageContent)[] | undefined {
	let clamped: (TextContent | ImageContent)[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (part.type === "image" && needsImageDrop(state)) {
			const bytes = state.byteBudget === Number.POSITIVE_INFINITY ? 0 : inlineImageBytes(part, state.model);
			if (state.remainingDrops > 0 || (state.inlineBytes > state.byteBudget && bytes > 0)) {
				clamped ??= content.slice(0, index);
				if (state.remainingDrops > 0) state.remainingDrops--;
				state.inlineBytes -= bytes;
				continue;
			}
		}
		clamped?.push(part);
	}
	// An image-only message would otherwise go out empty; converters skip
	// zero-block messages, silently losing the turn (e.g. an oversized pasted image).
	return clamped && clamped.length === 0 ? [IMAGE_OMISSION] : clamped;
}

function clampUserMessage(message: UserMessage, state: ImageBudgetState): UserMessage {
	if (!Array.isArray(message.content) || !needsImageDrop(state)) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: ImageBudgetState): DeveloperMessage {
	if (!Array.isArray(message.content) || !needsImageDrop(state)) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

/**
 * Where the route sends a computer result's metadata screenshot, the result is that one image, never its content:
 * evicting it drops the metadata (and the unsent content images), and the result goes out as its remaining text, as
 * for an unreadable screenshot in {@link dropUnreadableContextImages}. Elsewhere the content is what is sent and
 * clamped, and the unsent metadata stays.
 */
function clampToolResultMessage(message: ToolResultMessage, state: ImageBudgetState): ToolResultMessage {
	if (!needsImageDrop(state)) return message;
	const screenshot = sentScreenshotBytes(message, state.metadataWire);
	if (screenshot === undefined) {
		const content = clampContent(message.content, state);
		return content ? { ...message, content } : message;
	}
	const bytes = state.byteBudget === Number.POSITIVE_INFINITY ? 0 : screenshot;
	if (state.remainingDrops <= 0 && !(state.inlineBytes > state.byteBudget && bytes > 0)) return message;
	if (state.remainingDrops > 0) state.remainingDrops--;
	state.inlineBytes -= bytes;
	const text = message.content.filter(part => part.type === "text");
	return { ...message, content: text.length > 0 ? text : [IMAGE_OMISSION], providerMetadata: undefined };
}

function clampImages(context: Context, state: ImageBudgetState): Context {
	const messages = context.messages.map(message => {
		if (state.kept?.has(message)) return message;
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
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
 * Drops oldest transient image blocks so outgoing vision requests fit the active provider's image cap.
 *
 * {@link countImages} counts exactly the roles {@link clampImages} can drop, so the
 * budget is always fully spendable and the clamp never evicts an input image
 * on behalf of a model output.
 */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const metadataWire = sendsComputerScreenshotMetadata(model);
	const totalImages = countImages(context, metadataWire);
	const remainingDrops = totalImages - providerImageBudget(model);
	if (remainingDrops <= 0) return context;
	return clampImages(context, {
		remainingDrops,
		inlineBytes: 0,
		byteBudget: Number.POSITIVE_INFINITY,
		model,
		metadataWire,
	});
}

/**
 * Messages whose inline images a host with a `request-body-byte-limit` keeps past the byte budget: the newest user
 * message (summary archives excluded) and the newest tool result carrying inline image bytes, newest first, each only
 * while the kept images still fit `imageRoom`, the limit less the request's other serialized bytes. The clamp evicts
 * everything else oldest-first, as on other hosts.
 */
function newestImageMessages(
	context: Context,
	model: Model,
	metadataWire: boolean,
	imageRoom: number | undefined,
): Set<Message> {
	const kept = new Set<Message>();
	if (imageRoom === undefined || imageRoom <= 0) return kept;
	let user: Message | undefined;
	let toolResult: Message | undefined;
	let bytes = 0;
	for (let index = context.messages.length - 1; index >= 0 && !(user && toolResult); index--) {
		const message = context.messages[index];
		if (!Array.isArray(message.content)) continue;
		const isUser = !user && message.role === "user" && message.historyRewriteAt === undefined;
		if (!isUser && (toolResult || message.role !== "toolResult")) continue;
		const messageBytes = sentImageBytes(message, model, metadataWire);
		if (isUser) user = message;
		else if (messageBytes > 0) toolResult = message;
		else continue;
		if (messageBytes === 0 || bytes + messageBytes > imageRoom) continue;
		bytes += messageBytes;
		kept.add(message);
	}
	return kept;
}

/**
 * Drops oldest inline image blocks so their base64 fits the deployment's request-body budget.
 * Runs after URL/provider-file decoration: blocks the provider receives as references carry no inline bytes.
 */
export function clampProviderContextImageBytes(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const budgetedHost = reachesBudgetedHost(model);
	const byteBudget = resolveInlineImageByteBudget(model, budgetedHost);
	if (byteBudget === undefined) return context;
	const metadataWire = sendsComputerScreenshotMetadata(model);
	let inlineBytes = 0;
	// Assistant images are model outputs no serializer replays (see countImages): never charged or reserved.
	let unsentBytes = 0;
	for (const message of context.messages) {
		if (message.role !== "assistant") {
			inlineBytes += sentImageBytes(message, model, metadataWire);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "image") unsentBytes += part.data.length;
		}
	}
	if (inlineBytes <= byteBudget) return context;
	const bodyLimit = resolveRequestBodyByteLimit(model, budgetedHost);
	// Text, tools and the system prompt ride in the same body, as UTF-8: only what they leave may hold protected
	// images. Base64 is ASCII, so its characters are its bytes. Never sent: tool-result `details` (UI-only) and
	// another provider's native payload (assistant turns, compaction summaries), which this request does not replay.
	// A computer result carries its screenshot twice and sends one copy (sentScreenshotBytes); where that is the
	// metadata copy, none of its content is sent.
	const wire = context.messages.map(message => {
		if (message.role === "toolResult") {
			return sentScreenshotBytes(message, metadataWire) === undefined
				? { ...message, details: undefined, providerMetadata: undefined }
				: { ...message, details: undefined, content: [] };
		}
		const payload = message.providerPayload;
		if (!payload) return message;
		const owner =
			message.role === "assistant" ? message.provider : "provider" in payload ? payload.provider : undefined;
		return owner !== undefined && owner !== model.provider ? { ...message, providerPayload: undefined } : message;
	});
	const otherBytes = Buffer.byteLength(JSON.stringify({ ...context, messages: wire })) - inlineBytes - unsentBytes;
	const imageRoom = bodyLimit === undefined ? undefined : bodyLimit - REQUEST_ENVELOPE_BYTES - otherBytes;
	const kept = newestImageMessages(context, model, metadataWire, imageRoom);
	return clampImages(context, { remainingDrops: 0, inlineBytes, byteBudget, model, metadataWire, kept });
}

/**
 * Caps snapcompact archive frames at `model`'s frame payload budget.
 *
 * The archive is sized when the agent context is built, for the model active then. A later switch to a host with a
 * smaller budget (`/model`, cycling, retry and role fallbacks, prewalk hand-offs, context promotion, an advisor on
 * another host) would otherwise resend the larger archive, and hosts without an inline byte budget have no other clamp.
 * Archive frames are the images of summary (rewritten-history) user messages.
 */
export function capArchiveFrameBytes(context: Context, model: Model): Context {
	const budget = frameDataBytesBudget(model);
	let messages: Message[] | undefined;
	for (let index = 0; index < context.messages.length; index++) {
		const message = context.messages[index];
		if (message.role !== "user" || message.historyRewriteAt === undefined || !Array.isArray(message.content)) {
			continue;
		}
		const content = capFrameDataBytes(message.content, budget);
		if (content === message.content) continue;
		messages ??= context.messages.slice();
		messages[index] = { ...message, content };
	}
	return messages ? { ...context, messages } : context;
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
