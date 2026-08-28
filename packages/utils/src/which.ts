// OS-agnostic "which" helper with robust macOS toolchain lookup and flexible cache control.
//
// - Falls back to macOS Xcode/CLT toolchain directories if standard `Bun.which()` fails on Darwin.
//   Resolves the active developer directory via $DEVELOPER_DIR / /var/db/xcode_select_link symlink
//   to avoid spawning xcrun subprocesses.
// - Supports four cache modes (`none`, `fresh`, `ro`, `cached`) for control over discovery cost and determinism.
// - Computes a stable cache key from command + options to avoid redundant lookups within a process.
// - Returns path to resolved binary or null if not found.
//

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type CacheKey = string | bigint | number;

// Tools shipped by Xcode / Command Line Tools that callers actually look up.
// Keeps the set small so darwinWhich can fast-reject non-Xcode commands without
// touching the filesystem.  Only needs entries for binaries that live *exclusively*
// in toolchain dirs (not on a typical $PATH).
const XCODE_BINS = new Set([
	// Compilers & driver aliases
	"clang",
	"clang++",
	"gcc",
	"g++",
	"cc",
	"c++",
	"cpp",
	"c89",
	"c99",
	"swift",
	"swiftc",
	"swift-frontend",
	// Language servers (LSP)
	"clangd",
	"sourcekit-lsp",
	// Linker & archive tools
	"ld",
	"ld-classic",
	"ar",
	"ranlib",
	"libtool",
	"as",
	"lipo",
	"install_name_tool",
	"codesign_allocate",
	// Build utilities
	"make",
	"gnumake",
	"m4",
	"flex",
	"bison",
	"yacc",
	"lex",
	// VCS (CLT ships git)
	"git",
	"git-receive-pack",
	"git-upload-pack",
	"git-upload-archive",
	"git-shell",
	"scalar",
	// Debugger
	"lldb",
	"lldb-dap",
	// Binary inspection
	"nm",
	"otool",
	"objdump",
	"strings",
	"strip",
	"size",
	"dsymutil",
	"dwarfdump",
	"lipo",
	"vtool",
	// Clang tooling
	"clang-format",
	"swift-format",
]);

// Prefixes for versioned binaries (e.g. python3.9, pip3.12, pydoc3.9, 2to3-3.9)
const XCODE_BIN_PREFIXES = ["python", "pip", "pydoc", "2to3"];

function isXcodeBin(command: string): boolean {
	if (XCODE_BINS.has(command)) return true;
	for (const prefix of XCODE_BIN_PREFIXES) {
		if (command.startsWith(prefix)) return true;
	}
	return false;
}

// Resolve the active Xcode developer directory once, without spawning any process.
// Priority: $DEVELOPER_DIR env → /var/db/xcode_select_link symlink → common fallback paths.
function getDeveloperDirs(): string | null {
	// 1. Explicit env override
	const envDir = process.env.DEVELOPER_DIR;
	if (envDir && fs.existsSync(envDir)) {
		return envDir;
	}

	// 2. xcode-select stores the active path as a symlink
	try {
		return fs.readlinkSync("/var/db/xcode_select_link");
	} catch {
		// symlink may not exist on minimal installs
	}
	// 3. Common locations
	for (const candidate of ["/Applications/Xcode.app/Contents/Developer", "/Library/Developer/CommandLineTools"]) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

// Build the list of extra toolchain bin directories to check on macOS.
// Computed lazily once from the resolved developer directory.
let macosToolPaths: Map<string, string> | undefined;
function getMacosToolPaths(): Map<string, string> {
	if (macosToolPaths) return macosToolPaths;
	const paths: string[] = [
		// Always check Command Line Tools (may be independent of Xcode)
		"/Library/Developer/CommandLineTools/usr/bin",
	];
	const devDir = getDeveloperDirs();
	if (devDir) {
		paths.push(path.join(devDir, "usr/bin"), path.join(devDir, "Toolchains/XcodeDefault.xctoolchain/usr/bin"));
	}

	// Deduplicate (e.g. devDir may already be CommandLineTools)
	macosToolPaths = new Map<string, string>();
	for (const dir of Array.from(new Set(paths))) {
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() || entry.isSymbolicLink()) {
					if (macosToolPaths.has(entry.name)) {
						continue;
					}
					macosToolPaths.set(entry.name, path.join(dir, entry.name));
				}
			}
		} catch {
			// dir doesn't exist or isn't readable
		}
	}
	return macosToolPaths;
}

// Map: cache key -> resolved binary path or null (not found)
const toolCache = new Map<CacheKey, string | null>();

/**
 * Cache policy for which lookups.
 */
export const enum WhichCachePolicy {
	/**
	 * Use cached result if available.
	 */
	Cached = 0,
	/**
	 * Bypass cache and perform a new lookup.
	 */
	Bypass,
	/**
	 * Always update cache.
	 */
	Fresh,
	/**
	 * Read-only, serves from cache if present, but doesn't write.
	 */
	ReadOnly,
}

// Extension: additional cache policy for tool path lookup
export interface WhichOptions extends Bun.WhichOptions {
	/**
	 * Cache policy for the lookup.
	 * Defaults to `WhichCachePolicy.Fresh`.
	 */
	cache?: WhichCachePolicy;
}

// Darwin-specific "which" shim: consult Xcode/CLT toolchain directories after $PATH.
// Uses cached directory listings instead of per-command existsSync or xcrun subprocesses.
function darwinWhich(command: string, options?: Bun.WhichOptions): string | null {
	const regular = Bun.which(command, options);
	if (regular) return regular;
	if (isXcodeBin(command)) {
		return getMacosToolPaths().get(command) ?? null;
	}
	return null;
}

// Which function that incorporates Darwin Xcode logic if platform reports as 'darwin'
export const whichFresh = os.platform() === "darwin" ? darwinWhich : Bun.which;

// Derive stable cache key from command and lookup options
function cacheKey(command: string, options?: Bun.WhichOptions): CacheKey {
	if (!options) return command;
	if (!options.cwd && !options.PATH) return command;
	let h = Bun.hash(command);
	if (options.cwd) h = Bun.hash(options.cwd, h);
	if (options.PATH) h = Bun.hash(options.PATH, h);
	return h;
}

/**
 * Locate binary on PATH (with flexible caching).
 *
 * @param command - Binary name to resolve
 * @param options - Bun.WhichOptions plus `cache` control
 * @returns Filesystem path if found, else null
 */
export function $which(command: string, options?: WhichOptions): string | null {
	const cachePolicy = options?.cache ?? WhichCachePolicy.Cached;
	const lookupOptions =
		options?.PATH !== undefined || process.env.PATH === undefined ? options : { ...options, PATH: process.env.PATH };
	let key: CacheKey | undefined;

	if (cachePolicy !== WhichCachePolicy.Bypass) {
		key = cacheKey(command, lookupOptions);
		if (cachePolicy !== WhichCachePolicy.Fresh) {
			const cached = toolCache.get(key);
			if (cached !== undefined) return cached;
		}
	}

	const result = whichFresh(command, lookupOptions);
	if (key != null && cachePolicy !== WhichCachePolicy.ReadOnly) {
		toolCache.set(key, result);
	}
	return result;
}
