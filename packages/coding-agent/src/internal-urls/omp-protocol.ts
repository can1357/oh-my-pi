/**
 * Protocol handler for omp:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - omp:// - Lists all available documentation files
 * - omp://<file>.md - Reads a specific documentation file
 */
import * as path from "node:path";
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

/**
 * Handler for omp:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class OmpProtocolHandler implements ProtocolHandler {
	readonly scheme = "omp";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		// Extract filename from host + path
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const filename = host ? (pathname && pathname !== "/" ? host + pathname : host) : "";

		if (!filename) {
			return this.#listDocs(url);
		}

		return this.#readDoc(filename, url);
	}

	async complete(): Promise<UrlCompletion[]> {
		return getDocFilenames().map(value => ({ value }));
	}

	async #listDocs(url: InternalUrl): Promise<InternalResource> {
		const filenames = getDocFilenames();
		if (filenames.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = filenames.map(f => `- [${f}](omp://${f})`).join("\n");
		const content = `# Documentation\n\n${filenames.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(filename: string, url: InternalUrl): Promise<InternalResource> {
		// Validate: no traversal, no absolute paths
		if (path.isAbsolute(filename)) {
			throw new Error("Absolute paths are not allowed in omp:// URLs");
		}

		const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
			throw new Error("Path traversal (..) is not allowed in omp:// URLs");
		}

		const docPath =
			normalized === "docs" ? "" : normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
		if (!docPath) {
			return this.#listDocs(url);
		}

		const content = await getEmbeddedDoc(docPath);
		if (content === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = getDocFilenames()
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse omp:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}
