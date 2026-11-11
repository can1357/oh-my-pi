/**
 * Published web pages: a local, versioned record of every page plus remote
 * hosting on one of two hosts:
 * - the blob-broker destinations configured in `publish.backends`;
 * - claude.ai Artifacts, used when `publish.backends` is empty and an
 *   Anthropic OAuth login is available.
 *
 * The local store under `~/.omp/agent/published/<id>/` is the source of truth
 * for listing, reading and deleting; hosts only hold the served copy. Blob
 * uploads target `<id>/index.html` (assets `<id>/<name>`), so hierarchical
 * destinations overwrite one object per page and keep its URL across updates.
 * A page keeps the host it was created on.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getPublishedDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { BlobDestinationId } from "../blob-broker/destinations";
import type { BlobPublication, BlobUploader, BlobUploadRequest } from "../blob-broker/publication";
import { destinationRuntimeConfig } from "../blob-broker/service";
import { createConfiguredUploader } from "../blob-broker/uploaders";
import type { Settings } from "../config/settings";
import { writeFileAtomically } from "../utils/atomic-file";
import markdownPageTemplate from "./markdown-page.html.txt" with { type: "text" };
import { type ClaudeArtifactsClient, claudeArtifactUrl } from "./claude-artifacts";
import { cfgPublishBackends } from "./settings";

const PAGE_ID_PATTERN = /^[0-9a-f]{32}$/;
const MANIFEST_FILE = "page.json";
const PAGE_FILE = "index.html";
const HTML_MIME = "text/html; charset=utf-8";
const MARKDOWN_EXTENSIONS: Readonly<Record<string, true>> = { ".md": true, ".markdown": true };
const HTML_EXTENSIONS: Readonly<Record<string, true>> = { ".html": true, ".htm": true };

/** One published revision of a page. */
export interface PageVersion {
	/** 1-based revision number. */
	version: number;
	/** Absolute path of the file the revision was rendered from. */
	source: string;
	/** URL the revision is served at. */
	url: string;
	/** Blob-destination publication; absent on claude.ai pages. */
	publication?: BlobPublication;
	/** claude.ai version id; the base for the next claude.ai publish. */
	claudeVersion?: string;
}

/** A file uploaded beside a page for it to reference. */
export interface PageAsset {
	/** Remote filename, unique within the page. */
	name: string;
	publication: BlobPublication;
}

/** Durable record of one page. */
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
	/** Blob-destination assets; claude.ai pages have none. */
	assets: PageAsset[];
	/** claude.ai artifact slug; set exactly for pages hosted on claude.ai. */
	claudeSlug?: string;
}

/** Outcome of deleting a page's remote copies. */
export interface PageRemoval {
	/** Whether the local record was removed (every remote copy is gone). */
	removed: boolean;
	/** URLs deleted remotely. */
	deleted: string[];
	/** URLs whose destination offers no deletion; they stay online. */
	stranded: string[];
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
	const ownTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
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

/** Where a page is hosted, for display: `claude.ai` or its latest blob destination. */
export function pageHost(page: PublishedPage): string | undefined {
	return page.claudeSlug ? "claude.ai" : page.versions.at(-1)?.publication?.destination;
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
		await Bun.write(path.join(this.#dir(id), `v${version}.html`), html);
	}

	async readVersion(id: string, version: number): Promise<string> {
		return Bun.file(path.join(this.#dir(id), `v${version}.html`)).text();
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

/** Publishes pages to claude.ai or through the configured destination chain. */
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

	#uploader(destination: BlobDestinationId): BlobUploader {
		const uploader = createConfiguredUploader(destination, destinationRuntimeConfig(this.#settings, destination));
		if (!uploader) {
			throw new Error(`${destination} serves from the running omp process and cannot host durable pages`);
		}
		return uploader;
	}

	/**
	 * Upload through the chain, trying `preferred` (the page's current
	 * destination) first so an update keeps its URL whenever it can.
	 */
	async #upload(request: BlobUploadRequest, preferred: BlobDestinationId | undefined): Promise<BlobPublication> {
		const chain = cfgPublishBackends.get(this.#settings) as BlobDestinationId[];
		if (chain.length === 0) throw new Error("No publish destination is configured (publish.backends is empty)");
		const order = preferred && chain.includes(preferred) ? [preferred, ...chain.filter(d => d !== preferred)] : chain;
		const errors: string[] = [];
		for (const destination of order) {
			try {
				return await this.#uploader(destination).upload(request);
			} catch (error) {
				errors.push(`${destination}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new Error(`Every publish destination failed:\n${errors.join("\n")}`);
	}

	/**
	 * Publish `html` as a new page, or as the next revision of `existing`.
	 * New pages go to claude.ai exactly when no destination is configured;
	 * existing pages stay on their host. `force` overwrites a claude.ai
	 * version published elsewhere since.
	 */
	async publish(options: {
		html: string;
		title: string;
		source: string;
		projectDir: string;
		existing?: PublishedPage;
		force?: boolean;
	}): Promise<{ page: PublishedPage; version: PageVersion; previousUrl: string | undefined }> {
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
		let hosted: Pick<PageVersion, "url" | "publication" | "claudeVersion">;
		let html = options.html;
		if (onClaude) {
			// claude.ai only serves content that sniffs as an HTML document.
			if (!/^\s*<!doctype html/i.test(html)) html = `<!DOCTYPE html>\n${html}`;
			const deployment = await this.#requireClaude().deploy({
				slug: page.claudeSlug,
				baseVersion: previous?.claudeVersion,
				title: options.title,
				content: html,
				force: options.force,
			});
			page.claudeSlug = deployment.slug;
			hosted = { url: claudeArtifactUrl(deployment.slug), claudeVersion: deployment.version };
		} else {
			const publication = await this.#upload(
				{
					bytes: new TextEncoder().encode(html),
					mimeType: HTML_MIME,
					extension: "html",
					filename: PAGE_FILE,
					folder: page.id,
				},
				previous?.publication?.destination,
			);
			hosted = { url: publication.url, publication };
		}
		const version: PageVersion = { version: (previous?.version ?? 0) + 1, source: options.source, ...hosted };
		await this.store.writeVersion(page.id, version.version, html);
		page.versions.push(version);
		page.title = options.title;
		page.updatedAt = Date.now();
		await this.store.save(page);
		return { page, version, previousUrl: previous?.url };
	}

	/** Upload a file into `page`'s remote folder, replacing a same-named asset. */
	async uploadAsset(page: PublishedPage, name: string, bytes: Uint8Array, mimeType: string): Promise<PageAsset> {
		if (page.claudeSlug) {
			throw new Error(
				"claude.ai pages take no separate assets; inline them in the HTML (<style>, <script>, data: URIs)",
			);
		}
		const replaced = page.assets.find(asset => asset.name === name);
		const publication = await this.#upload(
			{ bytes, mimeType, extension: path.extname(name).slice(1), filename: name, folder: page.id },
			replaced?.publication.destination ?? page.versions.at(-1)?.publication?.destination,
		);
		const asset: PageAsset = { name, publication };
		page.assets = [...page.assets.filter(existing => existing.name !== name), asset];
		page.updatedAt = Date.now();
		await this.store.save(page);
		return asset;
	}

	/** Pin or unpin locally; claude.ai pages also pin to the claude.ai sidebar. */
	async setPinned(page: PublishedPage, pinned: boolean): Promise<void> {
		if (page.claudeSlug) await this.#requireClaude().setPinned(page.claudeSlug, pinned);
		page.pinned = pinned;
		await this.store.save(page);
	}

	/**
	 * Delete every remote copy of `page`, then its local record. The record
	 * stays when a deletion fails so the call can be retried.
	 */
	async remove(page: PublishedPage): Promise<PageRemoval> {
		const result: PageRemoval = { removed: false, deleted: [], stranded: [], errors: [] };
		if (page.claudeSlug) {
			const url = claudeArtifactUrl(page.claudeSlug);
			try {
				await this.#requireClaude().remove(page.claudeSlug);
				result.deleted.push(url);
			} catch (error) {
				result.errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const seen = new Set<string>();
		const publications = [
			...page.versions.flatMap(version => (version.publication ? [version.publication] : [])),
			...page.assets.map(asset => asset.publication),
		];
		for (const publication of publications) {
			const identity = `${publication.destination}\0${publication.remoteId ?? publication.url}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			try {
				if (await this.#removePublication(publication)) result.deleted.push(publication.url);
				else result.stranded.push(publication.url);
			} catch (error) {
				result.errors.push(`${publication.url}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (result.errors.length === 0) {
			await this.store.remove(page.id);
			result.removed = true;
		}
		return result;
	}

	/** `false` when the destination offers no way to delete the publication. */
	async #removePublication(publication: BlobPublication): Promise<boolean> {
		let uploader: BlobUploader | undefined;
		try {
			uploader = this.#uploader(publication.destination);
		} catch {
			// Destination no longer configured; a captured delete request may still work.
		}
		if (uploader?.remove) {
			await uploader.remove(publication);
			return true;
		}
		const action = publication.delete;
		if (!action) return false;
		const response = await fetch(action.url, {
			method: action.method,
			...(action.headers !== undefined ? { headers: action.headers } : {}),
			...(action.body !== undefined ? { body: action.body } : {}),
		});
		await response.body?.cancel();
		if (!response.ok && response.status !== 404) throw new Error(`delete failed with HTTP ${response.status}`);
		return true;
	}
}
