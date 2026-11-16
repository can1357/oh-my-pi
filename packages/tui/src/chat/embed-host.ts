/**
 * How reply embeds (`<img>`, `<iframe>`) load. The host application installs
 * where relative paths resolve and how a page is screenshotted
 * ({@link setEmbedHost}); {@link loadEmbed} turns an embed into its picture.
 * Remote pictures and page screenshots are kept per address, failures
 * included, so rebuilding a transcript neither fetches nor captures again;
 * local files are read every time, so a regenerated file shows as it is now.
 */
import { loadMedia, type Media } from "../media";
import type { Embed } from "./embed-source";
import { embedTargetUrl, resolveEmbedSource } from "./embed-target";

/** What the application lends embeds; unset, replies keep their tags as Markdown. */
export interface EmbedHost {
	/** Directory relative `src` paths resolve against. */
	cwd: () => string;
	/** A PNG screenshot of the page at `url` (http(s) or `file:`); rejects when no browser can take one. */
	capturePage: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
}

/** Longest one page capture may take, queueing aside. */
const CAPTURE_TIMEOUT_MS = 30_000;
/** Remote pictures and page screenshots kept, least recently used dropped first. */
const CACHE_LIMIT = 16;

let host: EmbedHost | undefined;
const remote = new Map<string, Promise<Media>>();
/** Tail of the capture queue: each capture is a browser page, so they run one at a time. */
let captures: Promise<unknown> = Promise.resolve();

/** Install (or with `undefined`, remove) the application's embed support; the host rebuilds the transcript after. */
export function setEmbedHost(next: EmbedHost | undefined): void {
	host = next;
}

/** The installed embed support, if replies draw their embeds. */
export function embedHost(): EmbedHost | undefined {
	return host;
}

/**
 * Load `embed`'s picture: an `<img>`'s source, or a screenshot of an
 * `<iframe>`'s page.
 *
 * Rejects when no {@link EmbedHost} is installed, the source names neither
 * a web address nor a file (see {@link resolveEmbedSource}), it cannot be
 * read or is no picture (see `loadMedia`), or the page's capture fails or
 * exceeds {@link CAPTURE_TIMEOUT_MS}.
 */
export function loadEmbed(embed: Embed): Promise<Media> {
	const current = host;
	if (!current) return Promise.reject(new Error("embeds are off"));
	const cwd = current.cwd();
	const target = resolveEmbedSource(embed.src, cwd);
	if (!target) return Promise.reject(new Error("not a web address or a file"));
	if (embed.kind === "img") {
		if (target.kind === "url") return cached(`img ${target.url}`, () => loadMedia(target.url, { cwd }));
		return loadMedia(target.kind === "file" ? target.path : target.uri, { cwd });
	}
	const url = embedTargetUrl(target);
	if (!url) return Promise.reject(new Error("not a web address or a file"));
	return cached(`page ${url}`, () => {
		const capture = captures.then(() => current.capturePage(url, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)));
		captures = capture.catch(() => undefined);
		return capture.then(bytes => ({ bytes, mime: "image/png" }));
	});
}

function cached(key: string, load: () => Promise<Media>): Promise<Media> {
	const hit = remote.get(key);
	if (hit) {
		// Re-insert so eviction drops the least recently used address.
		remote.delete(key);
		remote.set(key, hit);
		return hit;
	}
	if (remote.size >= CACHE_LIMIT) remote.delete(remote.keys().next().value!);
	const loading = load();
	remote.set(key, loading);
	return loading;
}
