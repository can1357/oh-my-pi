import type { ImageContent } from "@oh-my-pi/pi-ai";

/** Converts an image to PNG, rejecting when the runtime cannot decode or encode it. */
export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const data = await new Bun.Image(bytes).png().toBase64();
	return { ...image, data, mimeType: "image/png" };
}

/**
 * Byte ceiling for {@link convertImageToPngShared}'s resident conversions.
 * Converted PNGs are larger than the webp/jpeg they came from, so the cache is
 * bounded and evicts least-recently-used entries rather than growing with the
 * session's image history.
 */
const PNG_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Least-recently-used first; {@link touchPngCache} re-inserts on hit. */
const pngCache = new Map<string, ImageContent>();
let pngCacheBytes = 0;
const pngConversionsInFlight = new Map<string, Promise<ImageContent>>();

/** Cache lookup that also marks `key` as most recently used. */
function touchPngCache(key: string): ImageContent | undefined {
	const hit = pngCache.get(key);
	if (!hit) return undefined;
	pngCache.delete(key);
	pngCache.set(key, hit);
	return hit;
}

/**
 * Content-addressed identity of an image payload, stable across components and
 * transcript rebuilds. Callers key their own per-image state by this instead of
 * positional ids like `${toolCallId}:${index}`, which go stale when the images
 * behind a position are replaced.
 */
export function imagePayloadKey(image: ImageContent): string {
	return `${image.mimeType}:${image.data.length}:${Bun.hash(image.data)}`;
}

/**
 * The PNG conversion of `image` when one is still resident, else `undefined`.
 * Synchronous so renderers can use an already-converted image on the spot
 * instead of scheduling another async re-render.
 */
export function cachedPngConversion(image: ImageContent): ImageContent | undefined {
	return touchPngCache(imagePayloadKey(image));
}

/**
 * Converts `image` to PNG at most once per distinct payload: concurrent callers
 * share one in-flight conversion and later callers hit {@link pngCache}.
 * Kitty-graphics renderers use this because `convertImageToPng` is a full
 * decode plus re-encode, and the same image is delivered repeatedly (read-result
 * replay) and rebuilt from scratch on resume, rewind, and `/tree` navigation.
 *
 * Rejections are not cached — a payload that failed to decode is retried by the
 * next caller, matching {@link convertImageToPng}'s contract.
 */
export function convertImageToPngShared(image: ImageContent): Promise<ImageContent> {
	const key = imagePayloadKey(image);
	const cached = touchPngCache(key);
	if (cached) return Promise.resolve(cached);
	const running = pngConversionsInFlight.get(key);
	if (running) return running;
	const conversion = convertImageToPng(image)
		.then(({ data }) => {
			pngConversionsInFlight.delete(key);
			// Only the payload is shared; caller-specific fields (`url`,
			// `providerFile`, `detail`) describe the source image, not this PNG.
			const converted: ImageContent = { type: "image", data, mimeType: "image/png" };
			pngCache.set(key, converted);
			pngCacheBytes += data.length;
			for (const [oldest, entry] of pngCache) {
				if (pngCacheBytes <= PNG_CACHE_MAX_BYTES) break;
				if (oldest === key) continue;
				pngCache.delete(oldest);
				pngCacheBytes -= entry.data.length;
			}
			return converted;
		})
		.catch(error => {
			pngConversionsInFlight.delete(key);
			throw error;
		});
	pngConversionsInFlight.set(key, conversion);
	return conversion;
}
