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
import { resolveContainedPath, resolveContainedPathSync } from "../discovery/contained-path";
import ompDoc from "../prompts/internal-urls/omp.md" with { type: "text" };
import { getDocFilenames, getDocsDiskRoot, getEmbeddedDoc } from "./docs-index";
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
 * Repo `docs/` tree the embedded corpus is generated from. Only the
 * docs-index-owned root ({@link getDocsDiskRoot}) is ever probed: resolving
 * `docs/` relative to this module would land in the consumer's own tree
 * (their project's `docs/`, `node_modules/docs`) on installs where the
 * corpus is embedded.
 */
function docFileOnDisk(docPath: string): string | undefined {
	const root = getDocsDiskRoot();
	if (root === null || !getDocFilenames().includes(docPath)) return undefined;
	const resolution = resolveContainedPathSync(root, path.resolve(root, docPath));
	return resolution.status === "ok" ? resolution.realPath : undefined;
}

/** File a doc URL may link to, or `undefined` for the docs root and doc-less URLs. */
function docFileFor(url: InternalUrl): string | undefined {
	const docPath = ompDocRel(url);
	return docPath.length > 0 ? docFileOnDisk(docPath) : undefined;
}

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
	 * File a doc is read from in a source checkout, so sync render paths still
	 * have one to open. Most installs ship the corpus embedded and have nothing
	 * to name here: materializing a copy needs the embedded body, which only
	 * {@link getEmbeddedDoc} can inflate — off the render path.
	 */
	locateSync(url: InternalUrl): string | undefined {
		try {
			return docFileFor(url);
		} catch {
			// Malformed URLs locate to nothing, never throw, in a render path.
			return undefined;
		}
	}

	/**
	 * Cached copy of the doc behind `url`, so a transcript hyperlink has a real
	 * file to point at in every install, not only source checkouts. The docs
	 * root names no file, an unknown doc yields no link at all, and the embedded
	 * corpus is a gzip blob that only {@link getEmbeddedDoc} can inflate — async,
	 * off the render path, where {@link locateSync} cannot follow.
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
	const root = getDocsCacheDir();
	const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const target = path.resolve(root, digest, docPath);
	// The doc path is joined into the cache root, so containment is proven
	// before the write: a URL escaping the root (an absolute or `..` path)
	// degrades to a plain-text link instead of writing outside the cache.
	// `missing` is the ordinary cache miss, which the write below fills.
	if ((await resolveContainedPath(root, target)).status === "outside") return null;
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
