import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { getMarkdownLinkUrls, TERMINAL } from "@oh-my-pi/pi-tui";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import { extractUriScheme, InternalUrlRouter, parseInternalUrl, type ResolveContext } from "./index";
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
			// Rendering must not fetch remote resources or materialize secrets:
			// only linkable schemes locate locally and cheaply.
			if (!scheme || scheme === "file" || (router.spec(scheme)?.linkable && router.canHandle(href))) {
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
					const located = await router.locate(href, context);
					if (located === null) return;
					sourcePath = located;
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
