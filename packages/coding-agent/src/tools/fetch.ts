import { repairCollapsedScheme, tryExtractEmbeddedUrlSelector } from "./details/fetch";
import type { ReadUrlToolDetails } from "./details/fetch";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type FetchImpl, getEnvApiKey, type ImageContent, type TextContent } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { resolveXaiBaseUrl, XAI_DEFAULT_BASE_URL } from "@oh-my-pi/pi-ai/providers/xai-base-url";
import { notebookToEditableText, type ReaderRemoteBackend } from "@oh-my-pi/pi-natives";
import { $env, errorMessage, USER_AGENT } from "@oh-my-pi/pi-utils";
import {
	type ArchiveFormat,
	formatArchiveEntryLines,
	listArchiveRoot,
	openArchive,
	parseArchivePathCandidates,
	sniffArchiveFormat,
} from "@oh-my-pi/pi-utils/ar";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ToolSession } from "../sdk";
import type { AgentStorageApi } from "../session/agent-storage";
import { DEFAULT_MAX_BYTES, truncateHead, truncateHeadBytes } from "./streaming-output";
import { webpExclusionForModel } from "../utils/image-input";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import { CONVERTIBLE_EXTENSIONS } from "../utils/markit";
import { configuredFirecrawlBaseUrl, findFirecrawlApiKey } from "../web/firecrawl";
import { findParallelApiKey } from "../web/parallel";
import { type ReadOutput, readUrl } from "../web/read";
import { decodeBody } from "../web/response-body";
import type { RenderResult } from "../web/scrapers/types";
import { finalizeOutput, MAX_BYTES } from "../web/scrapers/types";
import { convertWithMarkit, fetchBinary } from "../web/scrapers/utils";
import { findCredential } from "../web/search/providers/utils";
import { xaiModelChain } from "../web/search/providers/xai";
import { parseXUrl } from "../web/x";
import { applyListLimit } from "./list-limit";
import { parseTailCount } from "./path-utils";
import { type LineRange, parseLineRanges } from "./line-ranges";
import { isReadableUrlPath } from "./details/read";
import { executeJsonQuery } from "./read-json";
import type { ParsedSelector } from "./read-selector";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { listTables, looksLikeSqlite, openSqliteReadConnection, renderTableList } from "./sqlite-reader";
import { ToolAbortError } from "./tool-errors";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

import { cfgFetchEnabled, cfgToolsMaxTimeout } from "./settings";
import { cfgProvidersFetch, cfgProvidersWebKeyless } from "../session/settings";

// =============================================================================
// Types and Constants
// =============================================================================

const FETCH_DEFAULT_MAX_LINES = 300;
// MIME types markit can convert — one per registered converter (pdf, docx,
// pptx, xlsx, epub). Legacy `application/msword`, `application/vnd.ms-*`, and
// `application/rtf` are intentionally absent: markit has no converter for them.
const CONVERTIBLE_MIMES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/epub+zip",
]);

const NOTEBOOK_MIMES = new Set(["application/x-ipynb+json"]);
const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);

const SQLITE_MIMES = new Set([
	"application/vnd.sqlite3",
	"application/x-sqlite3",
	"application/sqlite3",
	"application/sqlite",
]);
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);

const ARCHIVE_MIMES = new Set([
	"application/zip",
	"application/x-zip-compressed",
	"application/x-tar",
	"application/tar",
	"application/gzip",
	"application/x-gzip",
]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz"]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_OUTPUT_BYTES = 300 * 1024;

// =============================================================================
// Utilities
// =============================================================================

/**
 * Normalize URL (repair a collapsed scheme, then add a scheme if one is missing).
 */
function normalizeUrl(url: string): string {
	url = repairCollapsedScheme(url);
	if (!url.match(/^https?:\/\//i)) {
		return `https://${url}`;
	}
	return url;
}

// URL line selectors mirror the file form: `:50`, `:50-100`, `:50+150`, `:5-10,20-30`, `:-60`,
// `:raw`, or `:raw:N-M` / `:N-M:raw` to combine raw mode with a range. If a URL would otherwise
// look like `host:port`, add a trailing slash before the selector (e.g. `https://example.com/:80`
// to read line 80 of the document at `https://example.com/`).

/** A readable external URL split from its trailing read selector. */
export interface ParsedReadUrlTarget {
	path: string;
	sel: ParsedSelector;
}

export function parseReadUrlTarget(readPath: string): ParsedReadUrlTarget | null {
	const repaired = repairCollapsedScheme(readPath);
	const embedded = tryExtractEmbeddedUrlSelector(repaired);
	const urlPath = embedded?.path ?? repaired;
	if (!isReadableUrlPath(urlPath)) {
		return null;
	}

	const tokens = embedded?.sels ?? [];
	const raw = tokens.some(token => token.toLowerCase() === "raw");
	let ranges: [LineRange, ...LineRange[]] | undefined;
	let tail: number | undefined;
	for (const token of tokens) {
		if (token.toLowerCase() === "raw") continue;
		if (ranges !== undefined || tail !== undefined) {
			// Two range groups on the same URL (`…:5-10:20-30`) — combine with commas instead.
			throw new ToolError(
				`URL selector has multiple range groups; combine them with commas (e.g. \`:5-10,20-30\`).`,
			);
		}
		ranges = parseLineRanges(token) ?? undefined;
		if (ranges !== undefined) continue;
		const count = parseTailCount(token);
		if (count === null) {
			// Shouldn't happen — isUrlSelectorToken vetted it. Belt-and-suspenders.
			throw new ToolError(`Invalid URL line selector: ${token}`);
		}
		tail = count;
	}

	const sel: ParsedSelector = ranges
		? { kind: "lines", ranges, raw }
		: tail !== undefined
			? { kind: "tail", count: tail, raw }
			: raw
				? { kind: "raw" }
				: { kind: "none" };
	return { path: urlPath, sel };
}

/**
 * Normalize MIME type (lowercase, strip charset/params)
 */
function normalizeMime(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

function getFilenameExtensionHint(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".tar.gz")) return ".tar.gz";
	return path.extname(filename).toLowerCase();
}

/**
 * Get extension from URL or Content-Disposition
 */
function getExtensionHint(url: string, contentDisposition?: string): string {
	// Try Content-Disposition filename first
	if (contentDisposition) {
		const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i);
		if (match) {
			const ext = getFilenameExtensionHint(match[1]);
			if (ext) return ext;
		}
	}

	// Fall back to URL path
	try {
		const pathname = new URL(url).pathname;
		const ext = getFilenameExtensionHint(pathname);
		if (ext) return ext;
	} catch {}

	return "";
}

/**
 * Check if content type is convertible via markit.
 */
function isConvertible(mime: string, extensionHint: string): boolean {
	if (CONVERTIBLE_MIMES.has(mime)) return true;
	if (mime === "application/octet-stream" && CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	if (CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	return false;
}

function resolveImageMimeType(mime: string, extensionHint: string): string | null {
	if (mime.startsWith("image/")) return mime;
	const shouldUseExtensionHint =
		mime.length === 0 || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "unknown";
	if (!shouldUseExtensionHint) return null;
	return IMAGE_MIME_BY_EXTENSION.get(extensionHint) ?? null;
}

function isInlineImageMimeTypeSupported(mimeType: string): boolean {
	return SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType);
}

/** Audio and video have no converter; report their MIME without downloading the body. */
function shouldSkipBodyDownload(contentType: string): boolean {
	const mime = normalizeMime(contentType);
	return mime.startsWith("audio/") || mime.startsWith("video/");
}

async function remoteReaderOptions(
	settings: Settings,
	storage: AgentStorageApi | null,
): Promise<{
	remote: ReaderRemoteBackend[];
	preferRemote: boolean;
}> {
	const provider = cfgProvidersFetch.get(settings);
	const remote: ReaderRemoteBackend[] = [];
	const [parallelKey, firecrawlKey, jinaCredential] = await Promise.all([
		findParallelApiKey(storage),
		findFirecrawlApiKey(storage),
		findCredential(storage, getEnvApiKey("jina"), "jina"),
	]);
	if (parallelKey) remote.push({ kind: "parallel", apiKey: parallelKey });
	if (firecrawlKey) {
		remote.push({ kind: "firecrawl", apiKey: firecrawlKey, baseUrl: configuredFirecrawlBaseUrl() });
	}
	const jinaKey = jinaCredential?.trim() || undefined;
	if (jinaKey || cfgProvidersWebKeyless.get(settings)) {
		remote.push({ kind: "jina", apiKey: jinaKey });
	}
	const preferredIndex = remote.findIndex(({ kind }) => kind === provider);
	if (preferredIndex > 0) remote.unshift(...remote.splice(preferredIndex, 1));
	return { remote, preferRemote: provider !== "auto" && provider !== "local" };
}

/**
 * Settings and credentials the site handlers of the native reader read: the
 * GitHub token, the `providers.fetch` preference (YouTube prefers Parallel
 * under `auto`/`parallel`), and for X URLs the resolved Grok request target.
 */
async function siteReaderOptions(
	url: string,
	settings: Settings,
	modelRegistry: ModelRegistry | undefined,
	signal: AbortSignal | undefined,
): Promise<{
	siteCredentials: { site: string; token: string }[];
	siteSettings: { key: string; value: string }[];
}> {
	const siteCredentials: { site: string; token: string }[] = [];
	const githubToken = $env.GITHUB_TOKEN || $env.GH_TOKEN;
	if (githubToken) siteCredentials.push({ site: "github", token: githubToken });
	const siteSettings: { key: string; value: string }[] = [
		{ key: "providers.fetch", value: cfgProvidersFetch.get(settings) },
	];
	const x = modelRegistry ? await resolveXReader(url, settings, modelRegistry, signal) : undefined;
	if (x) {
		siteCredentials.push({ site: "x", token: x.token });
		siteSettings.push(
			{ key: "x.model", value: x.model },
			{ key: "x.provider", value: x.provider },
			{ key: "x.baseUrl", value: x.baseUrl },
		);
		for (const name in x.headers) siteSettings.push({ key: `x.header.${name}`, value: x.headers[name] });
	}
	return { siteCredentials, siteSettings };
}

/**
 * The Grok model, bearer, base URL and extra headers for reading an X URL:
 * the first model of {@link xaiModelChain} whose credential resolves (an API
 * key or a refreshed OAuth access token), never sending official xAI OAuth
 * credentials to a custom endpoint. `undefined` for other URLs and without
 * usable xAI credentials.
 */
async function resolveXReader(
	url: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
	signal: AbortSignal | undefined,
): Promise<
	{ token: string; model: string; provider: string; baseUrl: string; headers: Record<string, string> } | undefined
> {
	const target = parseXUrl(url);
	if (!target || target.kind === "unsupported") return undefined;
	for (const model of xaiModelChain(modelRegistry, settings)) {
		if (model.provider !== "xai" && model.provider !== "xai-oauth") continue;
		const customEndpoint = model.baseUrl.replace(/\/+$/, "") !== XAI_DEFAULT_BASE_URL;
		const origin = modelRegistry.authStorage.keys.source(model.provider)?.kind;
		const officialOAuthCredential =
			model.provider === "xai-oauth" &&
			!modelRegistry.hasCommandBackedApiKey(model.provider) &&
			(origin === "oauth" || origin === "env");
		if (customEndpoint && officialOAuthCredential) continue;
		try {
			const token = await resolveApiKeyOnce(modelRegistry.resolver(model), signal);
			if (!token) continue;
			const baseUrl = officialOAuthCredential
				? model.baseUrl
				: (resolveXaiBaseUrl(model.provider, model.baseUrl, token) ?? model.baseUrl);
			const headers = (await modelRegistry.resolveModelHeaders(model, signal)) ?? {};
			return { token, model: model.id, provider: model.provider, baseUrl, headers };
		} catch {
			if (signal?.aborted) throw new ToolAbortError();
		}
	}
	return undefined;
}

interface FetchImagePayload {
	data: string;
	mimeType: string;
}

type FetchRenderResult = RenderResult & {
	image?: FetchImagePayload;
};

const BINARY_SAMPLE_CHARS = 4096;
const URL_ARCHIVE_LIST_LIMIT = 500;
const URL_SQLITE_LIST_LIMIT = 500;

function sampleLooksBinary(text: string): boolean {
	const limit = Math.min(text.length, BINARY_SAMPLE_CHARS);
	if (limit === 0) return false;

	let replacementCount = 0;
	for (let index = 0; index < limit; index++) {
		const code = text.charCodeAt(index);
		if (code === 0) return true;
		if (code === 0xfffd) replacementCount++;
	}

	return replacementCount >= 3 && replacementCount / limit > 0.01;
}

function isNotebookHint(mime: string, extensionHint: string): boolean {
	return NOTEBOOK_MIMES.has(mime) || NOTEBOOK_EXTENSIONS.has(extensionHint);
}

function isSqliteHint(mime: string, extensionHint: string): boolean {
	return SQLITE_MIMES.has(mime) || SQLITE_EXTENSIONS.has(extensionHint);
}

function isArchiveHint(mime: string, extensionHint: string): boolean {
	return ARCHIVE_MIMES.has(mime) || ARCHIVE_EXTENSIONS.has(extensionHint);
}

function getArchiveFormatHint(mime: string, extensionHint: string): ArchiveFormat | undefined {
	if (extensionHint === ".zip" || mime === "application/zip" || mime === "application/x-zip-compressed") {
		return "zip";
	}
	if (extensionHint === ".tar" || mime === "application/x-tar" || mime === "application/tar") {
		return "tar";
	}
	if (
		extensionHint === ".tar.gz" ||
		extensionHint === ".tgz" ||
		extensionHint === ".gz" ||
		mime === "application/gzip" ||
		mime === "application/x-gzip"
	) {
		return "tar.gz";
	}
	return undefined;
}

function binaryContentType(mime: string): string {
	return mime || "application/octet-stream";
}

function buildBinaryNotice(finalUrl: string, mime: string, byteLength?: number, notes?: readonly string[]): string {
	const size = byteLength === undefined ? "unknown size" : formatBytes(byteLength);
	// Why no text came out (a refused download, a failed conversion) belongs with the notice: a ranged read shows no notes.
	const failure = notes?.filter(note => /failed|no usable output/i.test(note)).at(-1);
	return `[Binary content: ${binaryContentType(mime)}, ${size}${failure ? `; ${failure}` : ""}] ${finalUrl}`;
}

function buildBinaryPayloadResult(
	url: string,
	finalUrl: string,
	mime: string,
	method: string,
	content: string,
	fetchedAt: string,
	notes: string[],
): FetchRenderResult {
	return {
		url,
		finalUrl,
		contentType: binaryContentType(mime),
		method,
		content: finalizeOutput(content),
		fetchedAt,
		truncated: false,
		notes,
	};
}

async function withTempBinaryFile<T>(
	prefix: string,
	extension: string,
	bytes: Uint8Array,
	readTempFile: (tempPath: string) => Promise<T>,
): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const tempPath = path.join(tempDir, `payload${extension}`);
	try {
		await Bun.write(tempPath, bytes);
		return await readTempFile(tempPath);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function renderNotebookPayload(bytes: Uint8Array, displayUrl: string): Promise<string> {
	return withTempBinaryFile("omp-url-notebook-", ".ipynb", bytes, async tempPath =>
		notebookToEditableText(await Bun.file(tempPath).text(), displayUrl),
	);
}

async function renderSqlitePayload(bytes: Uint8Array): Promise<string> {
	return withTempBinaryFile("omp-url-sqlite-", ".sqlite", bytes, async tempPath => {
		let db: Database | null = null;
		try {
			db = await openSqliteReadConnection(tempPath);
			const listLimit = applyListLimit(listTables(db), { limit: URL_SQLITE_LIST_LIMIT });
			return renderTableList(listLimit.items);
		} finally {
			db?.close();
		}
	});
}

async function tryRenderBinaryPayload(
	url: string,
	finalUrl: string,
	mime: string,
	extHint: string,
	bytes: Uint8Array,
	fetchedAt: string,
	notes: string[],
): Promise<FetchRenderResult> {
	if (isNotebookHint(mime, extHint)) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"notebook",
				await renderNotebookPayload(bytes, finalUrl),
				fetchedAt,
				notes,
			);
		} catch (error) {
			notes.push(`Notebook rendering failed: ${errorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, bytes.byteLength, notes),
				fetchedAt,
				notes,
			);
		}
	}

	if (isSqliteHint(mime, extHint) || looksLikeSqlite(bytes)) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"sqlite",
				await renderSqlitePayload(bytes),
				fetchedAt,
				notes,
			);
		} catch (error) {
			notes.push(`SQLite rendering failed: ${errorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, bytes.byteLength, notes),
				fetchedAt,
				notes,
			);
		}
	}

	const hintedArchiveFormat = getArchiveFormatHint(mime, extHint);
	const shouldArchiveSniff = hintedArchiveFormat !== undefined || !isConvertible(mime, extHint);
	const archiveFormat = hintedArchiveFormat ?? (shouldArchiveSniff ? sniffArchiveFormat(bytes) : undefined);
	if (archiveFormat) {
		try {
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"archive",
				await listArchiveRoot(bytes, archiveFormat, { limit: URL_ARCHIVE_LIST_LIMIT }),
				fetchedAt,
				notes,
			);
		} catch (error) {
			notes.push(`Archive rendering failed: ${errorMessage(error)}`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime, bytes.byteLength, notes),
				fetchedAt,
				notes,
			);
		}
	}

	return buildBinaryPayloadResult(
		url,
		finalUrl,
		mime,
		"binary",
		buildBinaryNotice(finalUrl, mime, bytes.byteLength, notes),
		fetchedAt,
		notes,
	);
}

// =============================================================================
// Main Render Function
// =============================================================================

/**
 * Main render function implementing the full pipeline
 */
async function renderUrl(
	url: string,
	timeout: number,
	raw: boolean,
	settings: Settings,
	signal: AbortSignal | undefined,
	storage: AgentStorageApi | null,
	modelRegistry: ModelRegistry | undefined,
	fetchOverride?: FetchImpl,
	excludeWebP?: true,
): Promise<FetchRenderResult> {
	const fetchedAt = new Date().toISOString();
	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	// Handle internal protocol URLs (e.g., pi-internal://) - return empty
	if (url.startsWith("pi-internal://")) {
		return {
			url,
			finalUrl: url,
			contentType: "text/plain",
			method: "internal",
			content: "",
			fetchedAt,
			truncated: false,
			notes: ["Internal protocol URL - no external content"],
		};
	}

	url = normalizeUrl(url);

	const output = await readUrl(url, {
		raw,
		hidden: "reachable",
		browser: !raw,
		sites: !raw,
		apiUserAgent: USER_AGENT,
		nowMs: Date.now(),
		...(!raw && (await siteReaderOptions(url, settings, modelRegistry, signal))),
		...(!raw && (await remoteReaderOptions(settings, storage))),
		timeoutMs: timeout * 1000,
		signal,
		fetch: fetchOverride,
		skipBody: shouldSkipBodyDownload,
	});
	const finalUrl = output.url || url;
	const notes = output.notes;
	const contentType = output.responseHeaders.find(({ name }) => name.toLowerCase() === "content-type")?.value;
	const mime = normalizeMime(output.contentType ?? contentType ?? "") || "unknown";
	if (output.status === 204) {
		return {
			url,
			finalUrl,
			contentType: mime,
			method: "no-content",
			content: "",
			fetchedAt,
			truncated: false,
			notes: [...notes, "HTTP 204 No Content"],
		};
	}
	if (output.kind === "blob") {
		return renderBlob(url, finalUrl, output, timeout, signal, fetchedAt, excludeWebP);
	}
	const wall = output.verdict === "wall";
	const challenge = wall && (output.status ?? 0) >= 200 && (output.status ?? 0) < 300;
	if (output.kind === "failed" || (wall && !raw)) {
		return {
			url,
			finalUrl,
			contentType: mime,
			method: challenge ? "blocked" : "failed",
			content: "",
			fetchedAt,
			truncated: false,
			notes: [
				output.status ? `Failed to fetch URL (HTTP ${output.status})` : "Failed to fetch URL",
				...notes,
				...(output.error ? [`Cause: ${output.error}`] : []),
			],
		};
	}
	return {
		url,
		finalUrl,
		contentType: mime,
		method: output.strategy ?? (raw ? "raw" : "local"),
		content: raw ? (output.content ?? "") : finalizeOutput(output.content ?? ""),
		fetchedAt,
		truncated: output.truncated ?? false,
		notes,
	};
}

async function renderBlob(
	url: string,
	finalUrl: string,
	output: ReadOutput,
	timeout: number,
	signal: AbortSignal | undefined,
	fetchedAt: string,
	excludeWebP?: true,
): Promise<FetchRenderResult> {
	const mime = normalizeMime(output.mime ?? "");
	const notes = [...output.notes];
	const bytes = output.bytes;
	if (!bytes || output.truncated || (bytes.byteLength === 0 && shouldSkipBodyDownload(mime))) {
		return {
			...buildBinaryPayloadResult(
				url,
				finalUrl,
				mime,
				"binary",
				buildBinaryNotice(finalUrl, mime),
				fetchedAt,
				notes,
			),
			truncated: output.truncated ?? false,
		};
	}
	const disposition = output.responseHeaders.find(header => header.name.toLowerCase() === "content-disposition");
	const extHint = getExtensionHint(finalUrl, disposition?.value) || output.extension || "";
	const imageMimeType = resolveImageMimeType(mime, extHint);
	if (imageMimeType && isInlineImageMimeTypeSupported(imageMimeType)) {
		const oversized = (note: string) => {
			notes.push(note);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				imageMimeType,
				"image-too-large",
				`Fetched image content (${imageMimeType}), but it is too large to inline render.`,
				fetchedAt,
				notes,
			);
		};
		if (bytes.byteLength > MAX_INLINE_IMAGE_SOURCE_BYTES) {
			return oversized(
				`Image exceeds inline source limit (${bytes.byteLength} bytes > ${MAX_INLINE_IMAGE_SOURCE_BYTES} bytes)`,
			);
		}
		const resized = await resizeImage(
			{
				type: "image",
				data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toBase64(),
				mimeType: imageMimeType,
			},
			{ maxBytes: MAX_INLINE_IMAGE_OUTPUT_BYTES, excludeWebP },
		);
		if (!(resized.originalWidth > 0 && resized.originalHeight > 0 && resized.width > 0 && resized.height > 0)) {
			notes.push(`Fetched payload could not be decoded as ${imageMimeType}; returning text metadata only`);
			return buildBinaryPayloadResult(
				url,
				finalUrl,
				imageMimeType,
				"image-invalid",
				`Fetched payload was labeled ${imageMimeType}, but bytes were not a valid image.`,
				fetchedAt,
				notes,
			);
		}
		if (resized.buffer.length > MAX_INLINE_IMAGE_OUTPUT_BYTES) {
			return oversized(
				`Image exceeds inline output limit after resize (${resized.buffer.length} bytes > ${MAX_INLINE_IMAGE_OUTPUT_BYTES} bytes)`,
			);
		}
		const dimensions = formatDimensionNote(resized);
		const content = `Fetched image content (${resized.mimeType}).${dimensions ? `\n${dimensions}` : ""}`;
		return {
			...buildBinaryPayloadResult(url, finalUrl, resized.mimeType, "image", content, fetchedAt, notes),
			image: { data: resized.data, mimeType: resized.mimeType },
		};
	}
	if (imageMimeType) {
		notes.push(
			`Image MIME type ${imageMimeType} is unsupported for inline model serialization; returning text metadata only`,
		);
	} else if (isConvertible(mime, extHint)) {
		const converted = await convertWithMarkit(bytes, extHint, timeout, signal);
		if (converted.ok && converted.content.trim().length > 50) {
			notes.push("Converted with markit");
			return buildBinaryPayloadResult(url, finalUrl, mime, "markit", converted.content, fetchedAt, notes);
		}
		notes.push(
			converted.ok
				? "markit conversion produced no usable output"
				: converted.error
					? `markit conversion failed: ${converted.error}`
					: "markit conversion failed",
		);
	}
	return tryRenderBinaryPayload(url, finalUrl, mime, extHint, bytes, fetchedAt, notes);
}

// =============================================================================
// Tool Definition
// =============================================================================

export interface ReadUrlEntry {
	artifactId?: string;
	artifactPath?: string;
	details: ReadUrlToolDetails;
	image?: FetchImagePayload;
	output: string;
	content: string;
}

async function findArtifactPath(session: ToolSession, artifactId: string): Promise<string | null> {
	const artifactsDir = session.getArtifactsDir?.();
	if (!artifactsDir) return null;

	try {
		const files = await fs.readdir(artifactsDir);
		const match = files.find(file => file.startsWith(`${artifactId}.`));
		return match ? path.join(artifactsDir, match) : null;
	} catch {
		return null;
	}
}

async function persistReadUrlArtifact(
	session: ToolSession,
	output: string,
): Promise<{ id?: string; path?: string } | undefined> {
	const artifact = await session.allocateOutputArtifact?.();
	if (!artifact?.path) return undefined;
	await Bun.write(artifact.path, output);
	return artifact;
}

async function ensureReadUrlArtifact(session: ToolSession, entry: ReadUrlEntry): Promise<ReadUrlEntry> {
	if (entry.artifactId && entry.artifactPath) return entry;
	if (entry.artifactId) {
		const artifactPath = await findArtifactPath(session, entry.artifactId);
		if (artifactPath) return { ...entry, artifactPath };
	}
	const artifact = await persistReadUrlArtifact(session, entry.output);
	return artifact?.id ? { ...entry, artifactId: artifact.id, artifactPath: artifact.path } : entry;
}

function readUrlContentExtension(finalUrl: string): string {
	try {
		const ext = getFilenameExtensionHint(new URL(finalUrl).pathname);
		return ext && /^\.[a-z0-9][a-z0-9+.-]{0,15}$/i.test(ext) ? ext : ".txt";
	} catch {
		return ".txt";
	}
}

async function materializeReadUrlContent(session: ToolSession, entry: ReadUrlEntry, raw: boolean): Promise<string> {
	// Without a session file there is no artifacts dir; a per-process temp dir still gives grep a file.
	const root = session.getArtifactsDir?.();
	const dir = root ? path.join(root, "url-search") : path.join(os.tmpdir(), "omp-url-search", String(process.pid));
	await fs.mkdir(dir, { recursive: true });
	const hash = Bun.hash(`${raw ? "raw" : "rendered"}:${entry.details.finalUrl}`).toString(36);
	const contentPath = path.join(dir, `${hash}${readUrlContentExtension(entry.details.finalUrl)}`);
	await Bun.write(contentPath, entry.content);
	return contentPath;
}

/** Fetch and render a URL for a read or search operation. */
export async function fetchReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
	options?: { ensureArtifact?: boolean },
): Promise<ReadUrlEntry> {
	const { path: url, raw = false } = params;

	const effectiveTimeout = clampTimeout("fetch", 30, cfgToolsMaxTimeout.get(session.settings));

	if (signal?.aborted) {
		throw new ToolAbortError();
	}

	const storage = session.settings.getStorage();
	const render = (target: string) =>
		renderUrl(
			target,
			effectiveTimeout,
			raw,
			session.settings,
			signal,
			storage,
			session.modelRegistry,
			session.fetch,
			webpExclusionForModel(session.getActiveModel?.()),
		);
	let result =
		(raw ? null : await renderUrlArchiveMember(url, effectiveTimeout, signal)) ??
		(raw ? null : await renderUrlJsonQuery(url, render, signal)) ??
		(await render(url));
	if (result.truncated) {
		const cutNote = `Response body exceeded ${formatBytes(MAX_BYTES)} and was cut mid-stream; content is incomplete`;
		result = { ...result, notes: [...result.notes, cutNote] };
	}
	const output = buildUrlReadOutput(result, result.content, raw);
	const artifact = options?.ensureArtifact ? await persistReadUrlArtifact(session, output) : undefined;

	return {
		artifactId: artifact?.id,
		artifactPath: artifact?.path,
		details: {
			kind: "url",
			url: result.url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: result.method,
			raw: raw || undefined,
			truncated: Boolean(result.truncated),
			notes: result.notes,
		},
		image: result.image,
		output,
		content: result.content,
	};
}

/** A `q` that reads as a jq filter (`.items[0]`, `[.[] | .id]`, `keys`) rather than a search term. */
const JQ_FILTER_RE =
	/^\s*(?:\.|\[|\{|(?:keys|length|to_entries|paths|first|last|add|flatten)\b|(?:map|select|has|sort_by|group_by)\()/;

/**
 * An http(s) URL whose `q` is a jq filter (`https://api.example.com/items.json?q=.items[0]`): the filter runs over
 * the JSON the URL without it returns, as `?q=` does on local files. Null when `q` is no filter or the response is
 * no JSON, so the URL is fetched as written, `q` and all.
 */
async function renderUrlJsonQuery(
	url: string,
	render: (target: string) => Promise<FetchRenderResult>,
	signal: AbortSignal | undefined,
): Promise<FetchRenderResult | null> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	// Percent-decoded only, never form-decoded: jq's `+` stays a `+`.
	const pairs = parsed.search.slice(1).split("&");
	const index = pairs.findIndex(pair => pair.startsWith("q="));
	if (index === -1) return null;
	let query = pairs[index].slice(2);
	try {
		query = decodeURIComponent(query);
	} catch {
		// A filter with a bare `%` (jq modulo) is not valid percent-encoding; take it verbatim.
	}
	if (!JQ_FILTER_RE.test(query)) return null;
	pairs.splice(index, 1);
	parsed.search = pairs.length > 0 ? `?${pairs.join("&")}` : "";
	const result = await render(parsed.href);
	if (!result.contentType.includes("json")) return null;
	const scratch = path.join(os.tmpdir(), `omp-url-json-${crypto.randomUUID()}.json`);
	await Bun.write(scratch, result.content);
	try {
		const content = await executeJsonQuery(scratch, { query, raw: false, compact: false }, signal);
		return { ...result, url, content, notes: [...result.notes, `Applied jq filter ${query} to ${parsed.href}`] };
	} finally {
		await fs.rm(scratch, { force: true });
	}
}

/**
 * A member of an archive URL (`https://…/pkg.whl:pkg/__init__.py`, `…/src.tar.gz:dir/`), read from the downloaded
 * archive as local archives are: a file's text, or a directory's listing. Null when the URL names no member or the
 * download is no archive, so the URL is fetched as written.
 */
async function renderUrlArchiveMember(
	url: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<FetchRenderResult | null> {
	const candidate = parseArchivePathCandidates(url).find(
		entry => entry.subPath !== "" && isReadableUrlPath(entry.archivePath),
	);
	if (!candidate) return null;
	const archiveUrl = candidate.archivePath;
	const binary = await fetchBinary(archiveUrl, timeout, signal);
	if (!binary.ok) return null;
	const mime = normalizeMime(binary.contentType ?? "");
	const format =
		sniffArchiveFormat(binary.buffer) ??
		getArchiveFormatHint(mime, getExtensionHint(archiveUrl, binary.contentDisposition));
	if (!format) return null;
	const archive = await openArchive({ bytes: binary.buffer, format });
	const node = archive.getNode(candidate.subPath);
	if (!node) {
		throw new ToolError(`${archiveUrl} has no member ${JSON.stringify(candidate.subPath)}.`);
	}
	const fetchedAt = new Date().toISOString();
	const notes = [`Read archive member ${candidate.subPath} of ${archiveUrl}`];
	if (node.isDirectory) {
		const lines = formatArchiveEntryLines(archive.listDirectory(candidate.subPath));
		return {
			url,
			finalUrl: url,
			contentType: "text/plain",
			method: "archive",
			content: lines.length > 0 ? lines.join("\n") : "(empty archive directory)",
			fetchedAt,
			truncated: false,
			notes,
		};
	}
	const file = await archive.readFile(candidate.subPath);
	const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
	const text = decodeBody(bytes, "text/plain");
	const binaryMember = sampleLooksBinary(text);
	return {
		url,
		finalUrl: url,
		contentType: binaryMember ? "application/octet-stream" : "text/plain",
		method: "archive",
		content: binaryMember ? buildBinaryNotice(url, "application/octet-stream", file.size) : text,
		fetchedAt,
		truncated: false,
		notes,
	};
}

/** Materialize rendered URL body text to a local file for tools that require filesystem paths. */
export async function materializeReadUrlToFile(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<{ path: string; details: ReadUrlToolDetails }> {
	if (!cfgFetchEnabled.get(session.settings)) {
		throw new ToolError("URL reads are disabled by settings.");
	}
	const entry = await fetchReadUrl(session, params, signal);
	const contentPath = await materializeReadUrlContent(session, entry, params.raw ?? false);
	return { path: contentPath, details: entry.details };
}

function buildUrlReadOutput(result: FetchRenderResult, content: string, raw: boolean): string {
	if (raw) return content;
	let output = "";
	output += `URL: ${result.finalUrl}\n`;
	output += `Content-Type: ${result.contentType}\n`;
	output += `Method: ${result.method}\n`;
	if (result.notes.length > 0) {
		output += `Notes: ${result.notes.join("; ")}\n`;
	}
	output += `\n---\n\n`;
	output += content;
	return output;
}

export async function executeReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadUrlToolDetails>> {
	let entry = await fetchReadUrl(session, params, signal);
	let truncation = truncateHead(entry.output, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: FETCH_DEFAULT_MAX_LINES,
	});
	if (truncation.firstLineExceedsLimit) {
		// `truncateHead` keeps whole lines only, so a minified page's first line left the body empty.
		// Show that line's head instead, as file reads do; the budget's bytes all lie inside it.
		const preview = truncateHeadBytes(entry.output, DEFAULT_MAX_BYTES);
		const newline = entry.output.indexOf("\n");
		truncation = {
			...truncation,
			content: preview.text,
			totalBytes: Buffer.byteLength(newline === -1 ? entry.output : entry.output.slice(0, newline), "utf-8"),
			outputLines: preview.bytes > 0 ? 1 : 0,
			outputBytes: preview.bytes,
		};
	}
	const needsArtifact = truncation.truncated;
	if (needsArtifact && !entry.artifactId) {
		entry = await ensureReadUrlArtifact(session, entry);
	}
	const output = needsArtifact ? truncation.content : entry.output;
	const details: ReadUrlToolDetails = {
		...entry.details,
		truncated: Boolean(entry.details.truncated || needsArtifact),
	};

	const contentBlocks: Array<TextContent | ImageContent> = [{ type: "text", text: output }];
	if (entry.image) {
		contentBlocks.push({ type: "image", data: entry.image.data, mimeType: entry.image.mimeType });
	}

	const resultBuilder = toolResult(details).content(contentBlocks).sourceUrl(details.finalUrl);
	if (needsArtifact) {
		resultBuilder.truncation(truncation, { direction: "head", artifactId: entry.artifactId });
	}

	return resultBuilder.done();
}
