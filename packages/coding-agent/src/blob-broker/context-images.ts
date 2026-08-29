/**
 * Pure context walkers for URL-mirrored images: decide which models may
 * receive image URLs, attach broker URLs to outgoing image blocks, and strip
 * them again when a provider rejects the request.
 *
 * All functions are structural and allocation-shy: untouched messages and
 * content arrays keep their identity so provider-side caches keyed on block
 * identity (e.g. Anthropic's resize memo) stay warm.
 */

import type { Context, ImageContent, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import { modelMatchesHost } from "@oh-my-pi/pi-catalog/hosts";

/** Responses/Chat APIs whose `image_url` accepts arbitrary https URLs. */
const URL_CAPABLE_OPENAI_APIS: Record<string, true> = {
	"openai-responses": true,
	"openai-codex-responses": true,
	"azure-openai-responses": true,
	"openai-completions": true,
	openrouter: true,
};

/**
 * Whether this model's provider fetches https image URLs server-side.
 *
 * Gated by API shape plus provider where the API is shared with backends that
 * cannot fetch (Bedrock never reaches out; the public generativelanguage API
 * restricts `fileUri` to Files API uploads). A wrong positive costs one failed
 * request — the stream fallback retries inline and quarantines the provider.
 */
export function supportsRemoteImageUrls(model: Model): boolean {
	if (!model.input.includes("image")) return false;
	// Moonshot-native hosts (api.moonshot.ai / api.kimi.com) reject remote
	// image URLs on both dialects: the OpenAI surface wants inline data and
	// the kimiApiFormat="anthropic" transport 400s with "unsupported image
	// url". Their catalog api is openai-completions, so the shape check
	// below would wrongly admit them.
	if (modelMatchesHost(model, "moonshotNative")) return false;
	if (URL_CAPABLE_OPENAI_APIS[model.api]) return true;
	if (model.api === "anthropic-messages") return model.provider === "anthropic";
	// Antigravity's Cloud Code endpoint fetches arbitrary https fileUri;
	// Vertex documents public https URLs for Gemini fileData.
	if (model.api === "google-gemini-cli") return model.provider === "google-antigravity";
	return model.api === "google-vertex";
}

type ImageBearingMessage = Extract<Message, { role: "user" | "developer" | "toolResult" }>;

function isImageBearing(message: Message): message is ImageBearingMessage {
	return message.role === "user" || message.role === "developer" || message.role === "toolResult";
}

function mapContextImages(context: Context, mapBlock: (block: ImageContent) => ImageContent): Context {
	let messagesChanged = false;
	const messages = context.messages.map(message => {
		if (!isImageBearing(message) || !Array.isArray(message.content)) return message;
		let contentChanged = false;
		const content = message.content.map((block): TextContent | ImageContent => {
			if (block.type !== "image") return block;
			const next = mapBlock(block);
			if (next !== block) contentChanged = true;
			return next;
		});
		if (!contentChanged) return message;
		messagesChanged = true;
		return { ...message, content } as Message;
	});
	return messagesChanged ? { ...context, messages } : context;
}

/**
 * Attach a broker URL to every image block lacking one. `urlFor` resolves a
 * block (by identity) to its stable URL, or `undefined` to leave it inline.
 */
export function decorateContextImages(context: Context, urlFor: (block: ImageContent) => string | undefined): Context {
	return mapContextImages(context, block => {
		if (block.url || block.providerFile) return block;
		const url = urlFor(block);
		return url ? { ...block, url } : block;
	});
}

/** Attach provider-native file references without disturbing independent URL mirrors. */
export function decorateContextProviderFiles(
	context: Context,
	referenceFor: (block: ImageContent) => ImageContent["providerFile"] | undefined,
): Context {
	return mapContextImages(context, block => {
		if (block.url) return block;
		const providerFile = referenceFor(block);
		if (!providerFile || providerFile === block.providerFile) return block;
		return { ...block, providerFile };
	});
}

/** True when any user/developer/toolResult message carries an image block. */
export function contextHasImages(context: Context): boolean {
	return context.messages.some(
		message =>
			isImageBearing(message) &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "image"),
	);
}

/**
 * Rewrite a decorated context back to pure inline base64 for a provider
 * retry: URLs are dropped, and URL-only placeholder blocks (lazy frames with
 * empty `data`) are filled through `resolveData`. A placeholder whose bytes
 * cannot be produced becomes a text note rather than an empty image the
 * provider would reject.
 */
export async function inlineContextImages(
	context: Context,
	resolveData: (block: ImageContent) => Promise<string | null>,
): Promise<Context> {
	let messagesChanged = false;
	const messages = await Promise.all(
		context.messages.map(async message => {
			if (!isImageBearing(message) || !Array.isArray(message.content)) return message;
			let contentChanged = false;
			const content = await Promise.all(
				message.content.map(async (block): Promise<TextContent | ImageContent> => {
					if (block.type !== "image" || (!block.url && !block.providerFile)) return block;
					contentChanged = true;
					const { url: _url, providerFile: _providerFile, ...rest } = block;
					if (rest.data.length > 0) return rest;
					const data = await resolveData(block);
					if (data) return { ...rest, data };
					return { type: "text", text: "[image unavailable: render source expired]" };
				}),
			);
			if (!contentChanged) return message;
			messagesChanged = true;
			return { ...message, content } as Message;
		}),
	);
	return messagesChanged ? { ...context, messages } : context;
}

/** Remove every image URL so the request carries pure inline base64. */
export function stripContextImageUrls(context: Context): Context {
	return mapContextImages(context, block => {
		if (!block.url) return block;
		const { url: _url, ...rest } = block;
		return rest;
	});
}

/** Remove provider-native references without disturbing independent URL mirrors. */
export function stripContextProviderFiles(context: Context): Context {
	return mapContextImages(context, block => {
		if (!block.providerFile) return block;
		const { providerFile: _providerFile, ...rest } = block;
		return rest;
	});
}

/** True when any outgoing image block carries a provider-native reference. */
export function contextHasProviderFiles(context: Context): boolean {
	return context.messages.some(
		message =>
			isImageBearing(message) &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "image" && block.providerFile !== undefined),
	);
}

/** True when any outgoing image block carries a URL mirror. */
export function contextHasImageUrls(context: Context): boolean {
	return context.messages.some(
		message =>
			isImageBearing(message) &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "image" && block.url !== undefined),
	);
}
