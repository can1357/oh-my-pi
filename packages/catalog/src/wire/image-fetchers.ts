/**
 * Identification of provider-side image fetchers.
 *
 * A request may carry an image either inline (base64) or as a URL. With a URL,
 * the provider's backend performs its own server-side GET against that URL, so
 * a local blob server sees an inbound request from vendor infrastructure rather
 * than from the client. This module names those fetchers, letting a blob server
 * attribute an inbound GET to the vendor that issued it — which is how a caller
 * learns where a request actually landed when a router sits between them and
 * the model.
 *
 * NOT an authentication mechanism. Every value here is a request header chosen
 * by the caller and is trivially forged. Authorize blob reads with an
 * unguessable URL (single-use capability token, short TTL) and treat a fetcher
 * match as attribution/telemetry only.
 *
 * Each entry was captured from a live fetch triggered by handing that vendor's
 * API a URL-sourced image.
 */

/** Vendor whose infrastructure performed an inbound fetch. */
export type ImageFetcherVendor = "openai" | "anthropic" | "xai" | "google";

/** Registry key for a known fetcher. */
export type ImageFetcherId =
	| "openai-file-downloader"
	| "anthropic-claude-user"
	| "anthropic-claude-user-preview"
	| "xai-image-api-fetch"
	| "google";

/** Request signature of one provider-side fetcher. */
export interface ImageFetcherIdentity {
	vendor: ImageFetcherVendor;
	/** Human-readable name for logs and UI. */
	label: string;
	/**
	 * `User-Agent` contract: an exact string for fetchers that send a fixed
	 * value, or a pattern for those embedding a client version.
	 */
	userAgent: string | RegExp;
	/**
	 * Vendor-proprietary headers observed alongside the agent, used to
	 * corroborate a `User-Agent` claim. Generic infrastructure headers
	 * (`traceparent`, `x-cloud-trace-context`) are deliberately excluded: they
	 * are emitted by unrelated infrastructure and corroborate nothing. Empty
	 * means the agent string is the only available signal, so
	 * {@link ImageFetcherMatch.corroborated} can never be true for that entry.
	 */
	markerHeaders: readonly string[];
	/** API surface the capture came from. */
	observedVia: string;
	/** Operational caveats a blob server should account for. */
	note?: string;
}

/**
 * Known provider-side fetchers.
 *
 * Agent contracts do not overlap — exact strings never collide with the
 * versioned patterns — so lookup order carries no meaning.
 */
export const IMAGE_FETCHERS: Readonly<Record<ImageFetcherId, ImageFetcherIdentity>> = {
	"openai-file-downloader": {
		vendor: "openai",
		label: "OpenAI File Downloader",
		userAgent: "OpenAI File Downloader",
		markerHeaders: ["openai-internal-smokescreener"],
		observedVia: "chatgpt.com/backend-api/codex/responses, input_image.image_url",
		note: "Issues two near-simultaneous GETs per image; a blob server must treat a duplicate hit as expected rather than as replay.",
	},
	"anthropic-claude-user": {
		vendor: "anthropic",
		label: "Claude image fetcher",
		userAgent: "Claude-User",
		markerHeaders: [],
		observedVia: "api.anthropic.com/v1/messages, image.source.type=url",
		note: "Sends only generic trace headers, so the bare agent string is the sole signal. Distinct from the versioned Claude-User/<version> agent used for links appearing in conversation text.",
	},
	"anthropic-claude-user-preview": {
		vendor: "anthropic",
		label: "Claude link fetcher",
		userAgent: /\bClaude-User\/\d+(?:\.\d+)*\b/,
		markerHeaders: [],
		observedVia:
			"unsolicited fetch after a URL appeared in assistant output; never observed serving an image request",
		note: "Not an image fetcher. Listed so a blob server can separate it from the image path instead of counting it as a provider image fetch.",
	},
	"xai-image-api-fetch": {
		vendor: "xai",
		label: "xAI image API fetch",
		userAgent: /^XaiImageApiFetch\/\d+(?:\.\d+)*\s/,
		markerHeaders: ["x-xaifetchid"],
		observedVia: "api.x.ai/v1/responses, input_image.image_url",
		note: "Sends an image-only `accept` allowlist and rejects any other content type before the model sees the response.",
	},
	google: {
		vendor: "google",
		label: "Google",
		userAgent: "Google",
		markerHeaders: [],
		observedVia: "cloudcode-pa.googleapis.com v1internal:streamGenerateContent, fileData.fileUri",
		note: "Weakest signal of the set: the agent string is a bare vendor name with no version and no proprietary header.",
	},
};

/** Attribution outcome for one inbound request. */
export interface ImageFetcherMatch {
	id: ImageFetcherId;
	identity: ImageFetcherIdentity;
	/**
	 * Whether every proprietary marker header for the matched identity is
	 * present. Always false for identities declaring no markers — absence of
	 * corroboration is not evidence against the match.
	 */
	corroborated: boolean;
}

/** Inbound header bag, as exposed by either `fetch` or a Node-style server. */
export type InboundHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

function headerValue(headers: InboundHeaders, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const direct = headers[name];
	if (direct !== undefined) return Array.isArray(direct) ? direct[0] : (direct as string);
	for (const key in headers) {
		if (key.toLowerCase() !== name) continue;
		const value = headers[key];
		return Array.isArray(value) ? value[0] : (value as string | undefined);
	}
	return undefined;
}

/**
 * Attribute an inbound blob request to a known provider-side fetcher, or
 * `null` when the agent matches none.
 *
 * Matches on `User-Agent` alone and reports marker-header corroboration
 * separately; callers MUST NOT treat either as proof of origin. Gate access on
 * the unguessable URL.
 */
export function identifyImageFetcher(headers: InboundHeaders): ImageFetcherMatch | null {
	const agent = headerValue(headers, "user-agent");
	if (!agent) return null;
	for (const id in IMAGE_FETCHERS) {
		const identity = IMAGE_FETCHERS[id as ImageFetcherId];
		const { userAgent } = identity;
		const matched = typeof userAgent === "string" ? agent === userAgent : userAgent.test(agent);
		if (!matched) continue;
		return {
			id: id as ImageFetcherId,
			identity,
			corroborated:
				identity.markerHeaders.length > 0 &&
				identity.markerHeaders.every(header => headerValue(headers, header) !== undefined),
		};
	}
	return null;
}
