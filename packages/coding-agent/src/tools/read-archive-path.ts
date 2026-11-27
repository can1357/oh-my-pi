import {
	type ArchiveFormat,
	archiveFormatFromPath,
	parseArchivePathCandidates,
	sniffArchiveFormat,
} from "@oh-my-pi/pi-utils/ar";
import type { ToolSession } from "../sdk";
import { resolveReadPath } from "./path-utils";
import {
	findSuffixMatchCached,
	isNotFoundError,
	isRemoteMountPath,
	type SuffixMatchCache,
} from "./read-path-resolution";
import { parseSel } from "./read-selector";

/** Existing archive and the member or selector addressed by the read. */
export interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
	/** Container format, when the file's extension does not name it (`report.docx:word/document.xml`). */
	format?: ArchiveFormat;
}

/**
 * ZIP-container documents. A bare read converts them to text; `doc.docx:word/document.xml` reads a member.
 * The lookahead requires the `:member` part.
 */
const ZIP_DOCUMENT_MEMBER_RE = /\.(?:docx|docm|dotx|xlsx|xlsm|pptx|pptm|odt|ods|odp|epub)(?=:)/gi;

const isZipHeader = (bytes: Uint8Array): boolean => sniffArchiveFormat(bytes) === "zip";
const isUnixArHeader = (bytes: Uint8Array): boolean => sniffArchiveFormat(bytes) === "ar";

/** Whether the file's first `length` bytes pass `sniff`; an unreadable file does not. */
async function hasMagic(absolutePath: string, sniff: (bytes: Uint8Array) => boolean, length: number): Promise<boolean> {
	try {
		return sniff(await Bun.file(absolutePath).slice(0, length).bytes());
	} catch {
		return false;
	}
}

/**
 * Whether the file is the archive its extension names. `.lib` also names text (SPICE models), so an `ar`
 * extension needs the `!<arch>` header; other extensions are trusted, and a mismatch fails when opened.
 */
async function claimsArchiveFormat(archivePath: string, absolutePath: string): Promise<boolean> {
	return archiveFormatFromPath(archivePath) !== "ar" || hasMagic(absolutePath, isUnixArHeader, 8);
}

/** `doc.docx:<member>` candidates: an existing ZIP file whose member part is no line selector. */
async function resolveZipDocumentMember(
	session: ToolSession,
	readPath: string,
): Promise<ResolvedArchiveReadPath | null> {
	const normalized = readPath.replace(/\\/g, "/");
	for (const match of normalized.matchAll(ZIP_DOCUMENT_MEMBER_RE)) {
		const end = (match.index ?? 0) + match[0].length;
		const subPath = normalized.slice(end + 1);
		if (subPath.length === 0 || parseSel(subPath).kind !== "none") continue;
		const absolutePath = resolveReadPath(readPath.slice(0, end), session.cwd);
		const stat = await Bun.file(absolutePath)
			.stat()
			.catch(() => null);
		if (!stat?.isFile() || !(await hasMagic(absolutePath, isZipHeader, 4))) continue;
		return { absolutePath, archiveSubPath: subPath, format: "zip" };
	}
	return null;
}

/** Resolve a candidate container path without opening it or indexing its members. */
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
			if (!(await claimsArchiveFormat(candidate.archivePath, absolutePath))) continue;
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
				if (!(await claimsArchiveFormat(candidate.archivePath, suffixMatch.absolutePath))) continue;

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

	return resolveZipDocumentMember(session, readPath);
}
