import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { getMarkdownLinkUrls, TERMINAL } from "@oh-my-pi/pi-tui";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import {
	extractUriScheme,
	InternalUrlRouter,
	LocalProtocolHandler,
	memoryRootsFromRegistry,
	parseInternalUrl,
	type ResolveContext,
	resolveLocalUrlToPath,
	resolveMemoryUrlToPath,
} from "./index";
import { expandPath } from "../tools/path-utils";

/**
 * Resolve Markdown hyperlinks to existing local resources or absolute file URLs.
 * Relative paths use the calling session's cwd; missing, virtual, and remote targets stay unchanged.
 */
export async function resolveMarkdownLinkTargets(
	texts: readonly string[],
	context?: ResolveContext,
): Promise<ReadonlyMap<string, string>> {
	const targets = new Map<string, string>();
	const urls = new Set<string>();
	const router = InternalUrlRouter.instance();
	for (const text of texts) {
		for (const href of getMarkdownLinkUrls(text)) {
			if (!href || /[\x00-\x1f\x7f]/.test(href) || /^(?:#|\?|\/\/)/.test(href)) continue;
			const scheme = extractUriScheme(href);
			// Rendering must not fetch remote resources or materialize secrets.
			if (
				!scheme ||
				scheme === "file" ||
				(/^(?:agent|artifact|history|local|memory|omp|rule|skill):\/\//i.test(href) && router.canHandle(href))
			) {
				urls.add(href);
			}
		}
	}
	await Promise.all(
		[...urls].map(async href => {
			try {
				let sourcePath: string;
				let suffix: string;
				if (router.canHandle(href)) {
					const resource = await router.resolve(href, { ...context, pathOnly: true, skipDirectoryListing: true });
					if (!resource.sourcePath) return;
					sourcePath = resource.sourcePath;
					suffix = parseInternalUrl(href).hash;
				} else {
					const suffixIndex = href.search(/[?#]/);
					const filePath = suffixIndex < 0 ? href : href.slice(0, suffixIndex);
					suffix = suffixIndex < 0 ? "" : href.slice(suffixIndex);
					const decoded =
						extractUriScheme(href) === "file" ? url.fileURLToPath(href) : decodeURIComponent(filePath);
					sourcePath = path.resolve(context?.cwd ?? process.cwd(), expandPath(decoded));
				}
				const stat = await fs.stat(sourcePath);
				if (!stat.isFile() && !stat.isDirectory()) return;
				targets.set(href, fileUriForTerminal(sourcePath, undefined, TERMINAL.id) + suffix);
			} catch {
				// A model-authored link may be incomplete, stale, or outside the resource root.
			}
		}),
	);
	return targets;
}

/**
 * Synchronously resolve a filesystem-backed internal URL (e.g. `local://foo.md`,
 * `memory://root/notes.md`) to its absolute filesystem path. Returns `undefined`
 * for inputs that aren't fs-backed, aren't resolvable in the current session
 * registry, or fail to parse.
 *
 * Used by renderers to wrap fs-backed internal URLs in OSC 8 hyperlinks even
 * when the resolved path isn't yet available from tool result details (e.g.
 * during the call/streaming phase before a result lands).
 *
 * Async-resolved schemes (`artifact://`, `agent://`, `skill://`, `rule://`,
 * `omp://`) are not handled here — those rely on `details.resolvedPath` set
 * by the read tool's router resolution.
 */
export function tryResolveInternalUrlSync(input: string): string | undefined {
	try {
		if (input.startsWith("local://")) {
			const opts = LocalProtocolHandler.resolveOptions();
			if (!opts) return undefined;
			return resolveLocalUrlToPath(input, opts);
		}
		if (input.startsWith("memory://")) {
			const url = parseInternalUrl(input);
			const roots = memoryRootsFromRegistry();
			for (const root of roots) {
				try {
					return resolveMemoryUrlToPath(url, root);
				} catch {
					// Try the next root; some sessions may not have this namespace mounted.
				}
			}
			return undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
