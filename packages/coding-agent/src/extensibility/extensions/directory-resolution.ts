import * as fs from "node:fs";
import * as path from "node:path";
import { hasFsCode, isEacces, isEnoent, isRecord } from "@oh-my-pi/pi-utils";

/** Selected extension files and whether a manifest suppresses convention fallback. */
export interface ExtensionDirectoryResolution {
	/** Whether package.json declares a non-empty omp/pi extensions array. */
	declared: boolean;
	/** Existing files selected by the authoritative manifest or directory conventions. */
	files: string[];
}

/** Source-specific suffix, ordering, and error policies for extension discovery. */
export interface ExtensionDirectoryResolutionOptions {
	/** Ordered index filenames accepted for convention-based directory resolution. */
	indexNames: readonly string[];
	/** Selects direct child files during a one-level scan. */
	isScanFile(name: string): boolean;
	/** Preserve callers whose public ordering requires a sorted directory scan. */
	sortChildren?: boolean;
	/** Preserve callers that surface unexpected stat failures instead of skipping them. */
	throwUnexpectedStatErrors?: boolean;
	/** Receives malformed/unreadable manifest and directory scan diagnostics. */
	onReadError?: (filePath: string, error: unknown) => void;
}

function isUnavailable(error: unknown): boolean {
	return isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM") || hasFsCode(error, "ENOTDIR");
}

/** Select the first loadable index file using the caller's suffix and error policy. */
export function findExtensionDirectoryIndex(
	dir: string,
	indexNames: readonly string[],
	options: { throwUnexpectedStatErrors?: boolean } = {},
): string | null {
	for (const name of indexNames) {
		const candidate = path.join(dir, name);
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch (error) {
			if (options.throwUnexpectedStatErrors && !isUnavailable(error)) throw error;
		}
	}
	return null;
}

function readDeclaredManifestEntries(
	dir: string,
	options: ExtensionDirectoryResolutionOptions,
): ExtensionDirectoryResolution {
	const packageJsonPath = path.join(dir, "package.json");
	let raw: string;
	try {
		raw = fs.readFileSync(packageJsonPath, "utf8");
	} catch (error) {
		if (!isUnavailable(error)) options.onReadError?.(packageJsonPath, error);
		return { declared: false, files: [] };
	}

	let pkg: unknown;
	try {
		pkg = JSON.parse(raw);
	} catch (error) {
		options.onReadError?.(packageJsonPath, error);
		return { declared: false, files: [] };
	}

	const manifest = isRecord(pkg) ? (pkg.omp ?? pkg.pi) : undefined;
	const entries = isRecord(manifest) ? manifest.extensions : undefined;
	if (!Array.isArray(entries) || entries.length === 0) {
		return { declared: false, files: [] };
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const candidate = path.resolve(dir, entry);
		let stats: fs.Stats;
		try {
			stats = fs.statSync(candidate);
		} catch (error) {
			if (options.throwUnexpectedStatErrors && !isUnavailable(error)) throw error;
			continue;
		}
		if (stats.isDirectory()) {
			const index = findExtensionDirectoryIndex(candidate, options.indexNames, options);
			if (index) files.push(index);
		} else {
			// Manifest paths are explicit, so they are not restricted by scan suffix policy.
			files.push(candidate);
		}
	}
	return { declared: true, files };
}

/**
 * Resolve an extension directory using manifest, index, then one-level scan
 * precedence. A declared manifest is authoritative even when none of its
 * entries resolve, so convention fallback never hides stale or missing entries.
 */
export function resolveExtensionDirectory(
	dir: string,
	options: ExtensionDirectoryResolutionOptions,
): ExtensionDirectoryResolution {
	const manifest = readDeclaredManifestEntries(dir, options);
	if (manifest.declared) return manifest;

	const directIndex = findExtensionDirectoryIndex(dir, options.indexNames, options);
	if (directIndex) return { declared: false, files: [directIndex] };

	let children: string[];
	try {
		children = fs.readdirSync(dir);
	} catch (error) {
		if (!isUnavailable(error)) options.onReadError?.(dir, error);
		return { declared: false, files: [] };
	}
	if (options.sortChildren) children.sort();

	const files: string[] = [];
	for (const child of children) {
		const childPath = path.join(dir, child);
		let stats: fs.Stats;
		try {
			// stat follows symlinks, preserving configured and installed package behavior.
			stats = fs.statSync(childPath);
		} catch (error) {
			if (options.throwUnexpectedStatErrors && !isUnavailable(error)) throw error;
			continue;
		}
		if (stats.isDirectory()) {
			const childManifest = readDeclaredManifestEntries(childPath, options);
			if (childManifest.declared) {
				files.push(...childManifest.files);
				continue;
			}
			const index = findExtensionDirectoryIndex(childPath, options.indexNames, options);
			if (index) files.push(index);
		} else if (options.isScanFile(child)) {
			files.push(childPath);
		}
	}
	return { declared: false, files };
}
