import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { extractUriScheme, parseInternalUrl, type ResolveContext } from "./index";
import { contextUrlRouter } from "./context";
import { expandPath } from "../tools/path-utils";
import { terminalIdentity } from "@oh-my-pi/pi-tui/driver/session";
import { fileUriForTerminal } from "../utils/file-links";

/**
 * Resolve Markdown link destinations (as extracted by `getMarkdownLinkUrls`)
 * to existing local resources or absolute file URLs. Relative paths use the
 * calling session's cwd; missing, virtual, and remote targets stay unchanged.
 */
export async function resolveMarkdownLinkHrefs(
	hrefs: Iterable<string>,
	context?: ResolveContext,
): Promise<ReadonlyMap<string, string>> {
	const targets = new Map<string, string>();
	const urls = new Set<string>();
	const router = contextUrlRouter(context);
	for (const href of hrefs) {
		if (!href || /[\x00-\x1f\x7f]/.test(href) || /^(?:#|\?|\/\/)/.test(href)) continue;
		const scheme = extractUriScheme(href);
		// Rendering must not fetch remote resources or materialize secrets:
		// only linkable schemes locate locally and cheaply.
		if (!scheme || scheme === "file" || (router.spec(scheme)?.linkable && router.canHandle(href))) {
			urls.add(href);
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
				const target = fileUriForTerminal(sourcePath, undefined, terminalIdentity().id);
				if (!target) return;
				targets.set(href, target + suffix);
			} catch {
				// A model-authored link may be incomplete, stale, or outside the resource root.
			}
		}),
	);
	return targets;
}
