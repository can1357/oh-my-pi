/**
 * Protocol handler for omp:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - omp:// - Lists all available documentation files
 * - omp://<file>.md - Reads a specific documentation file
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDocsCacheDir, logger } from "@oh-my-pi/pi-utils";
import ompDoc from "../prompts/internal-urls/omp.md" with { type: "text" };
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import { ompDocFilename, ompDocRel, ompDocsScopeEntries } from "./omp-scope";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/**
 * Handler for omp:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class OmpProtocolHandler implements ProtocolHandler {
	readonly scheme = "omp";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: true, linkable: true };

	/** Always advertised: harness docs are embedded in every build. */
	promptDoc(): string {
		return ompDoc.trim();
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const filename = ompDocFilename(url);
		// The docs root (`omp://`, `omp://docs`) names no doc. The grammar also
		// rejects absolute paths and `..` traversal.
		const docPath = ompDocRel(url);

		if (!filename || !docPath) {
			return this.#listDocs(url);
		}

		return this.#readDoc(docPath, filename, url);
	}

	/** The docs root expands to every embedded doc; a single-doc URL yields that doc (or throws when unknown). */
	async enumerate(url: InternalUrl, context?: ResolveContext): Promise<Array<{ url: string; content: string }>> {
		const docPath = ompDocRel(url);
		if (!docPath) {
			const entries = await ompDocsScopeEntries(context);
			if (entries.length === 0) {
				throw new Error("No documentation files found");
			}
			return entries;
		}
		const resource = await this.#readDoc(docPath, ompDocFilename(url), url);
		return [{ url: `omp://${docPath}`, content: resource.content }];
	}

	async complete(): Promise<UrlCompletion[]> {
		return getDocFilenames().map(value => ({ value }));
	}

	/**
	 * Cached copy of the doc behind `url`, so transcript hyperlinks have a real
	 * file to point at. `locateSync` is deliberately absent: the docs root names
	 * no file, an unknown doc yields no link at all, and the embedded corpus is
	 * a gzip blob that only `getEmbeddedDoc` can inflate — async, off the
	 * render path. Every display target still shows the `omp://` URL.
	 */
	async locate(url: InternalUrl): Promise<string | null> {
		const docPath = ompDocRel(url);
		if (!docPath) return null;
		const content = await getEmbeddedDoc(docPath);
		if (content === undefined) return null;
		return materializeOmpDoc(docPath, content);
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

	async #readDoc(docPath: string, filename: string, url: InternalUrl): Promise<InternalResource> {
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

/**
 * Materialize one embedded doc into the content-addressed read-only cache and
 * return its absolute path, or `null` when the cache is unwritable (the link
 * then falls back to plain text).
 *
 * The digest keys the doc body, not the install, so a rebuilt bundle or a dev
 * tree can never serve a stale file and concurrent renders write identical
 * bytes into distinct temp paths, racing harmlessly on the rename.
 */
async function materializeOmpDoc(docPath: string, content: string): Promise<string | null> {
	const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const target = path.join(getDocsCacheDir(), digest, docPath);
	try {
		await fs.access(target);
		return target;
	} catch {
		// Cache miss (or an unreadable entry): write it below.
	}
	// The random suffix keeps concurrent writers of the same doc from colliding
	// on one temp path before the atomic rename.
	const tempPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(tempPath, content, { mode: 0o444 });
		await fs.rename(tempPath, target);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		logger.debug("omp:// doc materialization failed", { docPath, error: String(error) });
		return null;
	}
	return target;
}
