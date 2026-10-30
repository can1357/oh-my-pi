import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type ArchiveFormat,
	type ArchiveReader,
	formatArchiveEntryLines,
	openArchive,
	parseArchivePathCandidates,
} from "@oh-my-pi/pi-utils/ar";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { ToolSession } from "../sdk";
import { convertBufferWithMarkit } from "../utils/markit";
import { truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { applyListLimit } from "@oh-my-pi/pi-tui/tools/list-limit";
import { resolveReadPath } from "./path-utils";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import {
	buildInMemorySelectorResult,
	decodeUtf8Text,
	markMarkdownContentType,
	prependSuffixResolutionNotice,
	toReadTruncationStats,
} from "./read-format";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { isMultiRange, type ParsedSelector, parseSel, resolveTailSelector, selToOffsetLimit } from "./read-selector";
import { type PdfImageReadTarget, type PdfPageReadOptions, splitPdfImageReadPath } from "./read-pdf";
import { cfgReadRenderMarkdown } from "./settings";
import { formatBytes } from "@oh-my-pi/pi-tui/render/render-utils";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { RACY_STAMP_WINDOW_MS } from "./racy-stamp";

interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
}

/**
 * Formats whose reader retains only the member index: payloads are ranged
 * reads from disk. Stream containers buffer the whole archive and RAR/7z keep
 * decoded solid blocks, so caching those would pin up to their in-memory limit.
 */
const CACHEABLE_ARCHIVE_FORMATS: Partial<Record<ArchiveFormat, true>> = { tar: true, zip: true, asar: true, iso: true };

interface CachedArchiveReader {
	reader: ArchiveReader;
	ino: number;
	mtimeMs: number;
	/** Change time: moves on every write and permission change and cannot be set back, unlike mtime. */
	ctimeMs: number;
	size: number;
	entryCount: number;
}

/**
 * Recently opened archives, so paging through members does not re-read and
 * re-index the archive per read. Bounded by count and by total indexed entries;
 * an entry is reused only while the file's identity (inode, mtime, ctime, size)
 * holds, so a rewrite or a permission change reopens the archive.
 */
const archiveReaderCache = new LRUCache<string, CachedArchiveReader>({
	max: 4,
	maxSize: 200_000,
	sizeCalculation: cached => Math.max(1, cached.entryCount),
});

async function openArchiveCached(absolutePath: string): Promise<ArchiveReader> {
	// The clock is read before the stat, so a change landing between the two counts as recent.
	const checkedAtMs = Date.now();
	// A vanished or unreadable archive is reported by the opener, as it always has been.
	const stat = await Bun.file(absolutePath)
		.stat()
		.catch(() => null);
	if (!stat) return openArchive(absolutePath);
	const cached = archiveReaderCache.get(absolutePath);
	if (
		cached &&
		cached.ino === stat.ino &&
		cached.mtimeMs === stat.mtimeMs &&
		cached.ctimeMs === stat.ctimeMs &&
		cached.size === stat.size
	) {
		return cached.reader;
	}
	const reader = await openArchive(absolutePath);
	if (!CACHEABLE_ARCHIVE_FORMATS[reader.format] || checkedAtMs - stat.ctimeMs < RACY_STAMP_WINDOW_MS) {
		archiveReaderCache.delete(absolutePath);
		return reader;
	}
	let entryCount = 0;
	for (const _entry of reader.indexEntries()) entryCount++;
	archiveReaderCache.set(absolutePath, {
		reader,
		ino: stat.ino,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		size: stat.size,
		entryCount,
	});
	return reader;
}
export async function resolveArchiveReadPath(
	session: ToolSession,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedArchiveReadPath | null> {
	const candidates = parseArchivePathCandidates(readPath);
	for (const candidate of candidates) {
		let absolutePath = resolveReadPath(candidate.archivePath, session.cwd);
		let suffixResolution: { from: string; to: string } | undefined;

		try {
			const stat = await Bun.file(absolutePath).stat();
			if (stat.isDirectory()) continue;
			return {
				absolutePath,
				archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
				suffixResolution,
			};
		} catch (error) {
			if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

			const suffixMatch = await findSuffixMatchCached(session, suffixCache, candidate.archivePath, signal);
			if (!suffixMatch) continue;

			try {
				const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
				if (retryStat.isDirectory()) continue;

				absolutePath = suffixMatch.absolutePath;
				suffixResolution = { from: candidate.archivePath, to: suffixMatch.displayPath };
				return {
					absolutePath,
					archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
					suffixResolution,
				};
			} catch (retryError) {
				if (!isNotFoundError(retryError)) {
					throw retryError;
				}
			}
		}
	}

	return null;
}
async function readArchiveDirectory(
	archive: ArchiveReader,
	archivePath: string,
	subPath: string,
	sel: ParsedSelector,
	details: ReadToolDetails,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const DEFAULT_LIMIT = 500;
	const allEntries = archive.listDirectory(subPath);
	// Selectors address entries with line semantics: `a.zip:dir:50` starts the
	// listing at the 50th entry, `a.zip:dir:-20` lists the last 20.
	const { offset, limit } = selToOffsetLimit(resolveTailSelector(sel, allEntries.length));
	const effectiveLimit = limit ?? DEFAULT_LIMIT;
	const entries = offset !== undefined && offset > 1 ? allEntries.slice(offset - 1) : allEntries;

	const listLimit = applyListLimit(entries, { limit: effectiveLimit });
	const limitedEntries = listLimit.items;
	const limitMeta = listLimit.meta;

	for (let index = 0; index < limitedEntries.length; index++) {
		throwIfAborted(signal);
	}
	const results = formatArchiveEntryLines(limitedEntries);

	const output = results.length > 0 ? results.join("\n") : "(empty archive directory)";
	const text = prependSuffixResolutionNotice(output, details.suffixResolution);
	const truncation = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
	const directoryDetails: ReadToolDetails = { ...details, isDirectory: true };
	const resultBuilder = toolResult<ReadToolDetails>(directoryDetails).text(truncation.content);
	resultBuilder.sourcePath(archivePath).limits({ resultLimit: limitMeta.resultLimit?.reached });
	if (truncation.truncated) {
		directoryDetails.truncation = toReadTruncationStats(truncation);
		resultBuilder.truncation(truncation, { direction: "head" });
	}
	return resultBuilder.done();
}

export async function readArchive(
	session: ToolSession,
	readPath: string,
	parsedSel: ParsedSelector,
	resolvedArchivePath: ResolvedArchiveReadPath,
	readPdfPage: (options: PdfPageReadOptions) => Promise<AgentToolResult<ReadToolDetails>>,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);
	const archive = await openArchiveCached(resolvedArchivePath.absolutePath);
	throwIfAborted(signal);

	const details: ReadToolDetails = markMarkdownContentType(
		session,
		{
			resolvedPath: resolvedArchivePath.absolutePath,
			suffixResolution: resolvedArchivePath.suffixResolution,
		},
		resolvedArchivePath.archiveSubPath,
	);

	let archiveSubPath = resolvedArchivePath.archiveSubPath;
	let sel = parsedSel;
	let pdfImageRead: PdfImageReadTarget | null = null;
	let node = archive.getNode(archiveSubPath);
	if (!node && archiveSubPath) {
		// `archive.zip:500` / `archive.zip:raw`: the whole subPath is a
		// selector on the archive root, not a member name. Member names take
		// precedence (getNode above); fall back to root + selector.
		const wholeSel = parseSel(archiveSubPath);
		if (wholeSel.kind !== "none") {
			node = archive.getNode("");
			archiveSubPath = "";
			sel = wholeSel;
		}
	}
	if (!node && sel.kind === "none") {
		const candidate = splitPdfImageReadPath(archiveSubPath);
		const pdfNode = candidate ? archive.getNode(candidate.pdfPath) : undefined;
		if (candidate && pdfNode && !pdfNode.isDirectory) {
			pdfImageRead = candidate;
			archiveSubPath = candidate.pdfPath;
			node = pdfNode;
		}
	}
	if (!node) {
		throw new ToolError(`Path '${readPath}' not found inside archive`);
	}

	if (node.isDirectory) {
		if (isMultiRange(sel)) {
			throw new ToolError("Multi-range line selectors are not supported for archive directory listings.");
		}
		return readArchiveDirectory(archive, resolvedArchivePath.absolutePath, archiveSubPath, sel, details, signal);
	}

	const entry = await archive.readFile(archiveSubPath);
	throwIfAborted(signal);
	if (entry.path.toLowerCase().endsWith(".pdf")) {
		const memberPath = `${resolvedArchivePath.absolutePath}:${entry.path}`;
		const pdfDetails: ReadToolDetails = { ...details, resolvedPath: memberPath, fileSize: entry.size };
		if (pdfImageRead) {
			// Only the selected, extraction-bounded member is materialized, under
			// an owned name rather than any untrusted archive path.
			await using scratch = await TempDir.create("@omp-read-archive-pdf-");
			const pdfPath = scratch.join("member.pdf");
			await Bun.write(pdfPath, entry.bytes);
			throwIfAborted(signal);
			const result = await readPdfPage({
				readPath,
				absolutePdfPath: pdfPath,
				page: pdfImageRead.page,
				pdfFileSize: entry.size,
				suffixResolution: resolvedArchivePath.suffixResolution,
				signal,
			});
			return toolResult<ReadToolDetails>({ ...result.details, ...pdfDetails })
				.content(result.content)
				.sourcePath(memberPath)
				.done();
		}
		const converted = await convertBufferWithMarkit(entry.bytes, ".pdf", signal);
		if (!converted.ok) {
			return toolResult<ReadToolDetails>(pdfDetails)
				.text(
					prependSuffixResolutionNotice(
						`[Cannot read .pdf file: ${converted.error || "conversion failed"}]`,
						resolvedArchivePath.suffixResolution,
					),
				)
				.sourcePath(memberPath)
				.done();
		}
		pdfDetails.contentType = cfgReadRenderMarkdown.get(session.settings) ? "text/markdown" : undefined;
		const result = await buildInMemorySelectorResult(session, converted.content, sel, {
			details: pdfDetails,
			sourcePath: memberPath,
			entityLabel: "document",
			immutable: true,
		});
		const firstText = result.content.find((content): content is TextContent => content.type === "text");
		if (firstText) {
			firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
		}
		return result;
	}
	const text = decodeUtf8Text(entry.bytes);
	if (text === null) {
		return toolResult<ReadToolDetails>(details)
			.text(
				prependSuffixResolutionNotice(
					`[Cannot read binary archive entry '${entry.path}' (${formatBytes(entry.size)})]`,
					resolvedArchivePath.suffixResolution,
				),
			)
			.sourcePath(resolvedArchivePath.absolutePath)
			.done();
	}

	// Archive members are immutable: there is no edit path for bytes inside
	// an archive, and a hashline tag keyed to the archive file would invite
	// (and fail) edits while clobbering sibling members' snapshots.
	const result = await buildInMemorySelectorResult(session, text, sel, {
		details,
		sourcePath: resolvedArchivePath.absolutePath,
		entityLabel: "archive entry",
		immutable: true,
	});
	const firstText = result.content.find((content): content is TextContent => content.type === "text");
	if (firstText) {
		firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
	}
	return result;
}
