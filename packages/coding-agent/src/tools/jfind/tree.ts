/**
 * The searchable file set and its model-facing listing. Files are listed once
 * up front (the cascade judges every candidate by name before reading any), so
 * the tree is a flat list of eligible files rather than a lazily expanded
 * directory graph. Eligibility deny-lists build noise, lockfiles, binaries, and
 * obvious credential material.
 */
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { buildPathTree, type PathTreeInput, walkPathTree } from "@oh-my-pi/pi-utils";

/** One eligible file under the search root. */
export interface FileEntry {
	/** Absolute path. */
	path: string;
	/** Root-relative display path with `/` separators. */
	rel: string;
	size: number;
}

const DENY_DIRS: Record<string, true> = {
	".git": true,
	node_modules: true,
	target: true,
	dist: true,
	build: true,
	out: true,
	".next": true,
	".nuxt": true,
	".turbo": true,
	".cache": true,
	__pycache__: true,
	".venv": true,
	venv: true,
	".tox": true,
	coverage: true,
	".idea": true,
	".vscode": true,
	".gradle": true,
	".mypy_cache": true,
	".pytest_cache": true,
	".ruff_cache": true,
	".parcel-cache": true,
};

const DENY_FILES: Record<string, true> = {
	"Cargo.lock": true,
	"package-lock.json": true,
	"yarn.lock": true,
	"pnpm-lock.yaml": true,
	"bun.lock": true,
	"bun.lockb": true,
	"poetry.lock": true,
	"Pipfile.lock": true,
	"composer.lock": true,
	"Gemfile.lock": true,
	"go.sum": true,
	"flake.lock": true,
	".DS_Store": true,
	"Thumbs.db": true,
};

/** Credential files by exact name. Never listed or read, even when hidden files are included. */
const SECRET_FILES: Record<string, true> = {
	".env": true,
	".envrc": true,
	".netrc": true,
	".npmrc": true,
	".pypirc": true,
	".pgpass": true,
	".boto": true,
	".s3cfg": true,
	".dockercfg": true,
	".git-credentials": true,
	".htpasswd": true,
	htpasswd: true,
	credentials: true,
	"credentials.json": true,
	"client_secret.json": true,
	"service-account.json": true,
	id_rsa: true,
	id_dsa: true,
	id_ecdsa: true,
	id_ed25519: true,
};

/** Credential files by extension: keys, certificate stores, encrypted vaults, and infrastructure state that embeds secrets. */
const SECRET_EXT = [
	"pem",
	"key",
	"p12",
	"pfx",
	"jks",
	"keystore",
	"bks",
	"ppk",
	"kdbx",
	"gpg",
	"pgp",
	"asc",
	"der",
	"crt",
	"cer",
	"tfvars",
	"tfvars.json",
	"tfstate",
	"tfstate.backup",
];

const BINARY_EXT = [
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"ico",
	"bmp",
	"tiff",
	"psd",
	"svg",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"zip",
	"gz",
	"tgz",
	"tar",
	"bz2",
	"xz",
	"zst",
	"7z",
	"rar",
	"pdf",
	"mp3",
	"mp4",
	"mov",
	"avi",
	"mkv",
	"wav",
	"ogg",
	"flac",
	"wasm",
	"so",
	"dylib",
	"dll",
	"exe",
	"o",
	"a",
	"class",
	"jar",
	"pyc",
	"pyo",
	"bin",
	"dat",
	"db",
	"sqlite",
	"sqlite3",
	"lock",
	"map",
	"min.js",
	"min.css",
	"snap",
	"pb",
	"onnx",
	"safetensors",
	"parquet",
	"arrow",
	"ipynb",
];

const ENV_TEMPLATES: Record<string, true> = {
	".env.example": true,
	".env.sample": true,
	".env.template": true,
	".env.dist": true,
};

/** `lower` ends with `.<ext>` for some `ext` in `exts`. */
function hasExt(lower: string, exts: readonly string[]): boolean {
	return exts.some(ext => lower.length > ext.length && lower.endsWith(`.${ext}`));
}

/** Credential material: exact names, `.env.*` variants (except committed templates), and key/vault extensions. */
function secret(name: string): boolean {
	if (Object.hasOwn(SECRET_FILES, name)) return true;
	if (name.startsWith(".env.")) return !Object.hasOwn(ENV_TEMPLATES, name);
	return hasExt(name.toLowerCase(), SECRET_EXT);
}

/** Whether a root-relative regular file is searchable. */
export function eligibleFile(rel: string, size: number, includeHidden: boolean): boolean {
	if (size <= 0) return false;
	const segments = rel.split("/");
	const name = segments[segments.length - 1]!;
	for (let i = 0; i < segments.length - 1; i++) {
		const dir = segments[i]!;
		if (Object.hasOwn(DENY_DIRS, dir) || (!includeHidden && dir.startsWith("."))) return false;
	}
	if (!includeHidden && name.startsWith(".")) return false;
	return !Object.hasOwn(DENY_FILES, name) && !secret(name) && !hasExt(name.toLowerCase(), BINARY_EXT);
}

export interface ListFilesOptions {
	includeHidden: boolean;
	signal?: AbortSignal;
}

/**
 * Every eligible, non-gitignored regular file under `root`, in path order.
 * Symlinks are never followed.
 */
export async function listFiles(root: string, options: ListFilesOptions): Promise<FileEntry[]> {
	// `sortByMtime` is the walker mode that stats entries, which is the only
	// way the native glob reports sizes; the order is re-established below.
	const result = await natives.glob({
		pattern: "*",
		path: root,
		recursive: true,
		fileType: natives.FileType.File,
		hidden: options.includeHidden,
		gitignore: true,
		sortByMtime: true,
		signal: options.signal,
	});
	const entries: FileEntry[] = [];
	for (const match of result.matches) {
		const size = match.size ?? 0;
		if (!eligibleFile(match.path, size, options.includeHidden)) continue;
		entries.push({ path: path.join(root, match.path), rel: match.path, size });
	}
	entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	return entries;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `812 B`, `3.4 KB`, … */
export function humanSize(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/**
 * Model-facing listing of `entries` as a prefix-folded directory tree: one `#`
 * per depth, `# dir/` headers, and every file line tagged with its question key
 * (`# e017 name (size)`), with a blank line before every directory header and
 * every root-level file after the first line.
 */
export function renderTree(entries: readonly FileEntry[], tagOf: (index: number) => string): string {
	const inputs: PathTreeInput[] = entries.map((entry, index) => ({
		path: entry.rel,
		isDir: false,
		key: String(index),
	}));
	let out = "";
	let emitted = false;
	for (const event of walkPathTree(buildPathTree(inputs))) {
		if (emitted && (event.kind === "dir" || event.depth === 0)) out += "\n";
		emitted = true;
		const hashes = "#".repeat(event.depth + 1);
		if (event.kind === "dir") {
			out += `${hashes} ${event.name}/\n`;
			continue;
		}
		const index = Number(event.key);
		out += `${hashes} ${tagOf(index)} ${event.name} (${humanSize(entries[index]!.size)})\n`;
	}
	return out;
}
