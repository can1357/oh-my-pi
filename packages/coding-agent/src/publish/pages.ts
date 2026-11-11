/**
 * Published web pages: a local, versioned record of every page plus remote
 * hosting on one of two hosts:
 * - claude.ai Artifacts, used when `publish.backends` is empty and an
 *   Anthropic OAuth login is available;
 * - object storage configured in `publish.backends`.
 *
 * The local store under `~/.omp/agent/published/<id>/` is the source of truth
 * for listing, reading and deleting; hosts only hold the served copy. A page
 * is bound to the host (claude.ai account or blob destination) that created
 * it, and every later operation goes there. Blob destinations must replace
 * objects in place and delete them: a page is one object at
 * `<prefix>/<id>/index.html` with assets beside it, so its URL never changes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getPublishedDir, isEnoent, untilAborted } from "@oh-my-pi/pi-utils";
import type { BlobDestinationId } from "../blob-broker/destinations";
import type { BlobPublication, BlobUploader, BlobUploadRequest } from "../blob-broker/publication";
import { destinationRuntimeConfig } from "../blob-broker/service";
import { createConfiguredUploader } from "../blob-broker/uploaders";
import type { Settings } from "../config/settings";
import { writeFileAtomically } from "../utils/atomic-file";
import { type ClaudeAccount, type ClaudeArtifactsClient, claudeArtifactUrl } from "./claude-artifacts";
import markdownPageTemplate from "./markdown-page.html.txt" with { type: "text" };
import { cfgPublishBackends } from "./settings";

const PAGE_ID_PATTERN = /^[0-9a-f]{32}$/;
const MANIFEST_FILE = "page.json";
const PAGE_FILE = "index.html";
const HTML_MIME = "text/html; charset=utf-8";
const MARKDOWN_EXTENSIONS: Readonly<Record<string, true>> = { ".md": true, ".markdown": true };
const HTML_EXTENSIONS: Readonly<Record<string, true>> = { ".html": true, ".htm": true };

/** Upper bound for one publish operation's network round trips. */
const OPERATION_TIMEOUT_MS = 120_000;

/** The caller's cancellation, bounded so a stalled host cannot hang the tool. */
function operationSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** One published revision of a page. */
export interface PageVersion {
	/** 1-based revision number. */
	version: number;
	/** Absolute path of the file the revision was rendered from. */
	source: string;
	/** URL the revision is served at. */
	url: string;
	/** claude.ai version id; the base for the next claude.ai publish. */
	claudeVersion?: string;
}

/** A file uploaded beside a page for it to reference. */
export interface PageAsset {
	/** Remote filename, unique within the page. */
	name: string;
	publication: BlobPublication;
}

/** Durable record of one page. Exactly one of `claudeSlug` and `destination` is set. */
export interface PublishedPage {
	/** 128-bit random hex id; also the remote folder name. */
	id: string;
	title: string;
	/** Project the page was created from; scopes `list`. */
	projectDir: string;
	updatedAt: number;
	/** Pinned pages list first and refuse deletion. */
	pinned: boolean;
	/** Oldest first; never empty. */
	versions: PageVersion[];
	/** Files beside a blob page; claude.ai pages have none. */
	assets: PageAsset[];
	/** claude.ai artifact slug. */
	claudeSlug?: string;
	/** Anthropic account that owns the claude.ai artifact; later calls must use it. */
	claudeOwner?: ClaudeAccount;
	/** Blob destination hosting the page. */
	destination?: BlobDestinationId;
	/** The page object on `destination`, replaced in place by every version. */
	object?: BlobPublication;
}

/** Outcome of deleting a page's remote copies. */
export interface PageRemoval {
	/** Whether the local record was deleted: every remote deletion succeeded. */
	removed: boolean;
	/** URLs deleted remotely. */
	deleted: string[];
	/** Per-URL deletion failures. */
	errors: string[];
}

/** Render a source file into the HTML that gets published. */
export function renderPageSource(
	source: string,
	text: string,
	title: string | undefined,
): { html: string; title: string } {
	const extension = path.extname(source).toLowerCase();
	if (MARKDOWN_EXTENSIONS[extension]) {
		const resolvedTitle = title ?? /^#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1] ?? path.basename(source, extension);
		const html = markdownPageTemplate
			.replace("{{title}}", Bun.escapeHTML(resolvedTitle))
			.replace("{{body}}", () => Bun.markdown.html(text, { headings: { ids: true } }));
		return { html, title: resolvedTitle };
	}
	if (!HTML_EXTENSIONS[extension]) {
		throw new Error(`Only .html, .htm, .md and .markdown files can be published, got ${path.basename(source)}`);
	}
	// A <title> may span lines; the record and listings keep one line.
	const ownTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, " ").trim();
	return { html: text, title: title ?? (ownTitle || path.basename(source, extension)) };
}

/** Remote-safe asset filename derived from a local path. */
export function assetName(filePath: string): string {
	const name = path
		.basename(filePath)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[.-]+/, "");
	if (!name) throw new Error(`Cannot derive an asset name from ${filePath}`);
	if (name === PAGE_FILE || name === MANIFEST_FILE) throw new Error(`Asset name ${name} is reserved; rename the file`);
	return name;
}

/** Filesystem store of page records and their revision contents. */
export class PageStore {
	constructor(readonly root: string) {}

	#dir(id: string): string {
		if (!PAGE_ID_PATTERN.test(id)) throw new Error(`Invalid page id: ${id}`);
		return path.join(this.root, id);
	}

	async load(id: string): Promise<PublishedPage | null> {
		try {
			return (await Bun.file(path.join(this.#dir(id), MANIFEST_FILE)).json()) as PublishedPage;
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async save(page: PublishedPage): Promise<void> {
		const dir = this.#dir(page.id);
		await fs.mkdir(dir, { recursive: true });
		await writeFileAtomically(path.join(dir, MANIFEST_FILE), `${JSON.stringify(page, null, "\t")}\n`);
	}

	async list(): Promise<PublishedPage[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.root);
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const pages = await Promise.all(entries.filter(name => PAGE_ID_PATTERN.test(name)).map(id => this.load(id)));
		return pages.filter(page => page !== null);
	}

	/** Resolve a page by id or by any URL it was served at. */
	async find(ref: string): Promise<PublishedPage | null> {
		const trimmed = ref.trim();
		if (PAGE_ID_PATTERN.test(trimmed)) return this.load(trimmed);
		for (const page of await this.list()) {
			if (page.versions.some(version => version.url === trimmed)) return page;
			if (page.assets.some(asset => asset.publication.url === trimmed)) return page;
		}
		return null;
	}

	async writeVersion(id: string, version: number, html: string): Promise<void> {
		await Bun.write(this.versionPath(id, version), html);
	}

	/** Local file holding a version's published HTML. */
	versionPath(id: string, version: number): string {
		return path.join(this.#dir(id), `v${version}.html`);
	}

	async remove(id: string): Promise<void> {
		await fs.rm(this.#dir(id), { recursive: true, force: true });
	}
}

/** Optional collaborators of a {@link PagePublisher}. */
export interface PagePublisherOptions {
	store?: PageStore;
	/** claude.ai host; used for new pages while `publish.backends` is empty. */
	claude?: ClaudeArtifactsClient;
}

/** An uploader able to host pages: it replaces objects in place and deletes them. */
type PageUploader = BlobUploader & Required<Pick<BlobUploader, "remove">>;

/** Publishes pages to claude.ai or to object storage. */
export class PagePublisher {
	readonly store: PageStore;
	#settings: Settings;
	#claude: ClaudeArtifactsClient | undefined;

	constructor(settings: Settings, options: PagePublisherOptions = {}) {
		this.#settings = settings;
		this.store = options.store ?? new PageStore(getPublishedDir(settings.getAgentDir()));
		this.#claude = options.claude;
	}

	#requireClaude(): ClaudeArtifactsClient {
		if (!this.#claude) {
			throw new Error(
				"No publish destination: set publish.backends, or log in to Anthropic with OAuth to publish to claude.ai",
			);
		}
		return this.#claude;
	}

	#uploader(destination: BlobDestinationId): PageUploader {
		const uploader = createConfiguredUploader(destination, destinationRuntimeConfig(this.#settings, destination));
		if (!uploader?.overwrites || !uploader.remove) {
			throw new Error(`${destination} cannot host pages: it does not replace and delete uploads in place`);
		}
		return uploader as PageUploader;
	}

	/** Upload to one destination; failures name it, since a page never moves to another. */
	async #uploadTo(
		destination: BlobDestinationId,
		request: BlobUploadRequest,
		signal: AbortSignal,
	): Promise<BlobPublication> {
		try {
			const uploader = this.#uploader(destination);
			return await untilAborted(signal, () => uploader.upload(request));
		} catch (error) {
			throw new Error(`${destination}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}

	/** Place a new page on the first destination in the chain that accepts it. */
	async #uploadNew(
		request: BlobUploadRequest,
		signal: AbortSignal,
	): Promise<{ destination: BlobDestinationId; object: BlobPublication }> {
		const chain = cfgPublishBackends.get(this.#settings) as BlobDestinationId[];
		const failures: string[] = [];
		for (const destination of chain) {
			try {
				return { destination, object: await this.#uploadTo(destination, request, signal) };
			} catch (error) {
				if (signal.aborted) throw error;
				failures.push((error as Error).message);
			}
		}
		throw new Error(`Every publish destination failed:\n${failures.join("\n")}`);
	}

	/**
	 * Publish `html` as a new page, or as the next revision of `existing` on
	 * the host that created it. New pages go to claude.ai exactly when no
	 * destination is configured. `force` overwrites a claude.ai version
	 * published elsewhere since.
	 */
	async publish(options: {
		html: string;
		title: string;
		source: string;
		projectDir: string;
		existing?: PublishedPage;
		force?: boolean;
		signal?: AbortSignal;
	}): Promise<{ page: PublishedPage; version: PageVersion }> {
		const signal = operationSignal(options.signal);
		const page: PublishedPage = options.existing ?? {
			id: crypto.getRandomValues(new Uint8Array(16)).toHex(),
			title: options.title,
			projectDir: options.projectDir,
			updatedAt: 0,
			pinned: false,
			versions: [],
			assets: [],
		};
		const previous = page.versions.at(-1);
		const onClaude = options.existing
			? page.claudeSlug !== undefined
			: cfgPublishBackends.get(this.#settings).length === 0;
		let html = options.html;
		let hosted: Pick<PageVersion, "url" | "claudeVersion">;
		if (onClaude) {
			// claude.ai only serves content that sniffs as an HTML document.
			if (!/^\s*<!doctype html/i.test(html)) html = `<!DOCTYPE html>\n${html}`;
			const deployment = await this.#requireClaude().deploy({
				slug: page.claudeSlug,
				owner: page.claudeOwner,
				baseVersion: previous?.claudeVersion,
				title: options.title,
				content: html,
				force: options.force,
				signal,
			});
			page.claudeSlug = deployment.slug;
			page.claudeOwner = deployment.owner;
			hosted = { url: claudeArtifactUrl(deployment.slug), claudeVersion: deployment.version };
		} else {
			const request: BlobUploadRequest = {
				bytes: new TextEncoder().encode(html),
				mimeType: HTML_MIME,
				extension: "html",
				filename: PAGE_FILE,
				folder: page.id,
			};
			const placed = page.destination
				? { destination: page.destination, object: await this.#uploadTo(page.destination, request, signal) }
				: await this.#uploadNew(request, signal);
			page.destination = placed.destination;
			page.object = placed.object;
			hosted = { url: placed.object.url };
		}
		const version: PageVersion = { version: (previous?.version ?? 0) + 1, source: options.source, ...hosted };
		await this.store.writeVersion(page.id, version.version, html);
		page.versions.push(version);
		page.title = options.title;
		page.updatedAt = Date.now();
		await this.store.save(page);
		return { page, version };
	}

	/** Upload a file beside `page`, replacing a same-named asset in place. */
	async uploadAsset(
		page: PublishedPage,
		name: string,
		bytes: Uint8Array,
		mimeType: string,
		signal?: AbortSignal,
	): Promise<PageAsset> {
		if (!page.destination) {
			throw new Error(
				"claude.ai pages take no separate assets; inline them in the HTML (<style>, <script>, data: URIs)",
			);
		}
		const publication = await this.#uploadTo(
			page.destination,
			{ bytes, mimeType, extension: path.extname(name).slice(1), filename: name, folder: page.id },
			operationSignal(signal),
		);
		const asset: PageAsset = { name, publication };
		page.assets = [...page.assets.filter(existing => existing.name !== name), asset];
		page.updatedAt = Date.now();
		await this.store.save(page);
		return asset;
	}

	/** Pin or unpin locally; claude.ai pages also pin to the claude.ai sidebar. */
	async setPinned(page: PublishedPage, pinned: boolean, signal?: AbortSignal): Promise<void> {
		if (page.claudeSlug) {
			await this.#requireClaude().setPinned(page.claudeSlug, page.claudeOwner, pinned, operationSignal(signal));
		}
		page.pinned = pinned;
		await this.store.save(page);
	}

	/**
	 * Delete every remote copy of `page`, then its local record. The record
	 * stays when a deletion fails so the call can be retried.
	 */
	async remove(page: PublishedPage, signal?: AbortSignal): Promise<PageRemoval> {
		const bounded = operationSignal(signal);
		const result: PageRemoval = { removed: false, deleted: [], errors: [] };
		const attempt = async (url: string, run: () => Promise<void>): Promise<void> => {
			try {
				await run();
				result.deleted.push(url);
			} catch (error) {
				result.errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		if (page.claudeSlug) {
			const slug = page.claudeSlug;
			await attempt(claudeArtifactUrl(slug), () => this.#requireClaude().remove(slug, page.claudeOwner, bounded));
		}
		if (page.destination) {
			const objects = [...(page.object ? [page.object] : []), ...page.assets.map(asset => asset.publication)];
			let uploader: PageUploader | undefined;
			try {
				uploader = this.#uploader(page.destination);
			} catch (error) {
				result.errors.push(`${page.destination}: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (uploader) {
				for (const object of objects) {
					await attempt(object.url, () => untilAborted(bounded, () => uploader.remove(object)));
				}
			}
		}
		if (result.errors.length === 0) {
			await this.store.remove(page.id);
			result.removed = true;
		}
		return result;
	}
}
