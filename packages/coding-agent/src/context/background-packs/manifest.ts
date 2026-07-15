import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";

const SUPPORTED_MANIFEST_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const SUPPORTED_SOURCE_EXTENSIONS = new Set([
	".csv",
	".json",
	".md",
	".mdx",
	".rst",
	".toml",
	".txt",
	".xml",
	".yaml",
	".yml",
]);
const GLOB_CHARACTERS = /[*?[\]{}]/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export const MAX_BACKGROUND_PACK_MANIFESTS = 8;
export const MAX_BACKGROUND_PACK_MANIFEST_BYTES = 64 * 1024;
export const MAX_BACKGROUND_PACK_SOURCES_PER_MANIFEST = 32;
export const MAX_BACKGROUND_PACK_SOURCE_BYTES = 1024 * 1024;
export const MAX_BACKGROUND_PACK_DECODED_BYTES = 4 * 1024 * 1024;

export type BackgroundPackWarningCode =
	| "manifest-invalid"
	| "manifest-missing"
	| "manifest-unsafe"
	| "source-invalid"
	| "source-missing"
	| "source-unsupported"
	| "source-unsafe";

export interface BackgroundPackWarning {
	code: BackgroundPackWarningCode;
	manifestIndex: number;
	message: string;
}

export interface ResolvedBackgroundPack {
	name: string;
	text: string;
	contentHash: string;
	sourceCount: number;
}

export interface ResolveBackgroundPackOptions {
	agentDir: string;
	workspaceRoots: readonly string[];
}

export interface ResolveBackgroundPacksResult {
	packs: ResolvedBackgroundPack[];
	warnings: BackgroundPackWarning[];
}

interface BackgroundPackManifestV1 {
	version: 1;
	name: string;
	sources: string[];
}

interface ValidatedReadOptions {
	maximumBytes: number;
	sizeCode: BackgroundPackWarningCode;
	sizeMessage: string;
	unsafeCode: BackgroundPackWarningCode;
	unsafeMessage: string;
	isCanonicalPathSafe(path: string): boolean;
}

class ManifestResolutionError extends Error {
	constructor(
		readonly code: BackgroundPackWarningCode,
		message: string,
	) {
		super(message);
	}
}

function containsPath(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isContainedByAny(candidate: string, roots: readonly string[]): boolean {
	return roots.some(root => containsPath(root, candidate));
}

function isExplicitLocalPath(value: string): boolean {
	return value.length > 0 && (!URL_SCHEME.test(value) || path.win32.isAbsolute(value)) && !GLOB_CHARACTERS.test(value);
}

function hasTraversal(value: string): boolean {
	return value
		.replaceAll("\\", "/")
		.split("/")
		.some(segment => segment === "..");
}

function parseManifest(value: unknown): BackgroundPackManifestV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ManifestResolutionError("manifest-invalid", "manifest must be an object");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some(key => key !== "version" && key !== "name" && key !== "sources")) {
		throw new ManifestResolutionError("manifest-invalid", "manifest contains unsupported fields");
	}
	if (record.version !== 1) {
		throw new ManifestResolutionError("manifest-invalid", "manifest version must be 1");
	}
	if (typeof record.name !== "string" || record.name.trim().length === 0) {
		throw new ManifestResolutionError("manifest-invalid", "manifest name must be a non-empty string");
	}
	if (
		!Array.isArray(record.sources) ||
		record.sources.length === 0 ||
		!record.sources.every(source => typeof source === "string")
	) {
		throw new ManifestResolutionError("manifest-invalid", "manifest sources must be a non-empty string array");
	}
	if (record.sources.length > MAX_BACKGROUND_PACK_SOURCES_PER_MANIFEST) {
		throw new ManifestResolutionError("manifest-invalid", "manifest lists too many sources");
	}
	return { version: 1, name: record.name.trim(), sources: record.sources as string[] };
}

function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
	return (
		sameFile(left, right) &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.nlink === right.nlink
	);
}

function sameResolvedPath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const resolved = path.normalize(path.resolve(value));
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(left) === normalize(right);
}

async function openWithoutFollowing(filePath: string): Promise<FileHandle> {
	const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
	return await fs.open(filePath, constants.O_RDONLY | noFollow);
}

async function readValidatedRegularFile(
	lexicalPath: string,
	initialStats: Stats,
	initialRealPath: string,
	options: ValidatedReadOptions,
): Promise<Uint8Array> {
	let handle: FileHandle;
	try {
		handle = await openWithoutFollowing(lexicalPath);
	} catch {
		throw new ManifestResolutionError(options.unsafeCode, options.unsafeMessage);
	}

	try {
		const openedStats = await handle.stat();
		const openedPathStats = await fs.lstat(lexicalPath);
		const openedRealPath = await fs.realpath(lexicalPath);
		if (
			!openedStats.isFile() ||
			openedStats.nlink !== 1 ||
			!sameFile(initialStats, openedStats) ||
			!sameFile(openedPathStats, openedStats) ||
			!sameResolvedPath(initialRealPath, openedRealPath) ||
			!options.isCanonicalPathSafe(openedRealPath)
		) {
			throw new ManifestResolutionError(options.unsafeCode, options.unsafeMessage);
		}
		if (openedStats.size > options.maximumBytes) {
			throw new ManifestResolutionError(options.sizeCode, options.sizeMessage);
		}

		const buffer = new Uint8Array(options.maximumBytes + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}

		const finalStats = await handle.stat();
		const finalPathStats = await fs.lstat(lexicalPath);
		const finalRealPath = await fs.realpath(lexicalPath);
		if (
			!sameSnapshot(openedStats, finalStats) ||
			!sameFile(finalPathStats, finalStats) ||
			finalPathStats.nlink !== 1 ||
			!sameResolvedPath(openedRealPath, finalRealPath) ||
			!options.isCanonicalPathSafe(finalRealPath)
		) {
			throw new ManifestResolutionError(options.unsafeCode, options.unsafeMessage);
		}
		if (offset > options.maximumBytes) {
			throw new ManifestResolutionError(options.sizeCode, options.sizeMessage);
		}
		return buffer.slice(0, offset);
	} catch (error) {
		if (error instanceof ManifestResolutionError) throw error;
		throw new ManifestResolutionError(options.unsafeCode, options.unsafeMessage);
	} finally {
		await handle.close().catch(() => {});
	}
}

async function resolveRealRoots(roots: readonly string[]): Promise<string[]> {
	return await Promise.all(
		roots.map(async root => {
			try {
				return await fs.realpath(root);
			} catch {
				return root;
			}
		}),
	);
}

async function resolveManifest(
	configuredPath: string,
	options: ResolveBackgroundPackOptions,
	workspaceRoots: readonly string[],
	realRoots: readonly string[],
): Promise<ResolvedBackgroundPack> {
	const entry = configuredPath.trim();
	if (!isExplicitLocalPath(entry)) {
		throw new ManifestResolutionError("manifest-invalid", "manifest path must be an explicit local file");
	}
	if (!SUPPORTED_MANIFEST_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
		throw new ManifestResolutionError("manifest-invalid", "manifest file type is not supported");
	}
	const lexicalManifest = path.resolve(options.agentDir, entry);
	if (isContainedByAny(lexicalManifest, workspaceRoots)) {
		throw new ManifestResolutionError("manifest-unsafe", "manifest is inside the active workspace");
	}

	let manifestStat: Stats;
	let manifestPath: string;
	try {
		manifestStat = await fs.lstat(lexicalManifest);
		manifestPath = await fs.realpath(lexicalManifest);
	} catch {
		throw new ManifestResolutionError("manifest-missing", "manifest file was not found");
	}
	if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) {
		throw new ManifestResolutionError("manifest-unsafe", "manifest must be a regular non-symlink file");
	}
	if (isContainedByAny(manifestPath, realRoots)) {
		throw new ManifestResolutionError("manifest-unsafe", "manifest resolves inside the active workspace");
	}

	let manifest: BackgroundPackManifestV1;
	try {
		const manifestBytes = await readValidatedRegularFile(lexicalManifest, manifestStat, manifestPath, {
			maximumBytes: MAX_BACKGROUND_PACK_MANIFEST_BYTES,
			sizeCode: "manifest-invalid",
			sizeMessage: "manifest exceeds the safe size limit",
			unsafeCode: "manifest-unsafe",
			unsafeMessage: "manifest changed or is not a single-link regular file",
			isCanonicalPathSafe: candidate => !isContainedByAny(candidate, realRoots),
		});
		manifest = parseManifest(YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
	} catch (error) {
		if (error instanceof ManifestResolutionError) throw error;
		throw new ManifestResolutionError("manifest-invalid", "manifest is not valid YAML or JSON");
	}

	const manifestDir = path.dirname(lexicalManifest);
	const realManifestDir = await fs.realpath(manifestDir);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const texts: string[] = [];
	let totalDecodedBytes = 0;
	for (const source of manifest.sources) {
		const configuredSource = source.trim();
		if (
			!isExplicitLocalPath(configuredSource) ||
			path.isAbsolute(configuredSource) ||
			hasTraversal(configuredSource)
		) {
			throw new ManifestResolutionError("source-invalid", "every source must be an explicit relative file");
		}
		if (!SUPPORTED_SOURCE_EXTENSIONS.has(path.extname(configuredSource).toLowerCase())) {
			throw new ManifestResolutionError("source-unsupported", "source file type is not supported");
		}
		const lexicalSource = path.resolve(manifestDir, configuredSource);
		if (!containsPath(manifestDir, lexicalSource) || isContainedByAny(lexicalSource, workspaceRoots)) {
			throw new ManifestResolutionError("source-unsafe", "source escapes the pack or enters the active workspace");
		}

		let sourceStat: Stats;
		let sourcePath: string;
		try {
			sourceStat = await fs.lstat(lexicalSource);
			sourcePath = await fs.realpath(lexicalSource);
		} catch {
			throw new ManifestResolutionError("source-missing", "source file was not found");
		}
		if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
			throw new ManifestResolutionError("source-unsafe", "source must be a regular non-symlink file");
		}
		if (!containsPath(realManifestDir, sourcePath) || isContainedByAny(sourcePath, realRoots)) {
			throw new ManifestResolutionError(
				"source-unsafe",
				"source resolves outside the pack or inside the active workspace",
			);
		}
		let sourceText: string;
		let sourceBytes: Uint8Array;
		try {
			sourceBytes = await readValidatedRegularFile(lexicalSource, sourceStat, sourcePath, {
				maximumBytes: MAX_BACKGROUND_PACK_SOURCE_BYTES,
				sizeCode: "source-invalid",
				sizeMessage: "source exceeds the safe size limit",
				unsafeCode: "source-unsafe",
				unsafeMessage: "source changed or is not a single-link regular file",
				isCanonicalPathSafe: candidate =>
					containsPath(realManifestDir, candidate) && !isContainedByAny(candidate, realRoots),
			});
			sourceText = decoder.decode(sourceBytes);
		} catch (error) {
			if (error instanceof ManifestResolutionError) throw error;
			throw new ManifestResolutionError("source-unsupported", "source is not valid UTF-8 text");
		}
		totalDecodedBytes += sourceBytes.byteLength + (texts.length > 0 ? 2 : 0);
		if (totalDecodedBytes > MAX_BACKGROUND_PACK_DECODED_BYTES) {
			throw new ManifestResolutionError("source-invalid", "pack exceeds the safe decoded size limit");
		}
		texts.push(sourceText);
	}

	const text = texts.join("\n\n");
	return {
		name: manifest.name,
		text,
		contentHash: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
		sourceCount: texts.length,
	};
}

export async function resolveBackgroundPackManifests(
	manifestPaths: unknown,
	options: ResolveBackgroundPackOptions,
): Promise<ResolveBackgroundPacksResult> {
	if (!Array.isArray(manifestPaths)) {
		return {
			packs: [],
			warnings: [
				{
					code: "manifest-invalid",
					manifestIndex: 0,
					message: "Background packs skipped: configuration is invalid.",
				},
			],
		};
	}
	if (manifestPaths.length > MAX_BACKGROUND_PACK_MANIFESTS) {
		return {
			packs: [],
			warnings: [
				{
					code: "manifest-invalid",
					manifestIndex: 0,
					message: "Background packs skipped: too many manifests are configured.",
				},
			],
		};
	}
	const workspaceRoots = [...new Set(options.workspaceRoots.map(root => path.resolve(root)))];
	const realRoots = await resolveRealRoots(workspaceRoots);
	const packs: ResolvedBackgroundPack[] = [];
	const warnings: BackgroundPackWarning[] = [];
	for (const [manifestIndex, configuredPath] of manifestPaths.entries()) {
		if (typeof configuredPath !== "string") {
			warnings.push({
				code: "manifest-invalid",
				manifestIndex,
				message: `Background pack ${manifestIndex + 1} skipped: manifest path is invalid.`,
			});
			continue;
		}
		try {
			packs.push(await resolveManifest(configuredPath, options, workspaceRoots, realRoots));
		} catch (error) {
			const failure =
				error instanceof ManifestResolutionError
					? error
					: new ManifestResolutionError("manifest-invalid", "manifest could not be resolved safely");
			warnings.push({
				code: failure.code,
				manifestIndex,
				message: `Background pack ${manifestIndex + 1} skipped: ${failure.message}.`,
			});
		}
	}
	return { packs, warnings };
}
