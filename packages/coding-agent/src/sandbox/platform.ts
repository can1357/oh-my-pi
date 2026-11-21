/**
 * Per-OS knowledge for the sandbox: the filesystem policy and the packages behind the host
 * commands network modes need. Every policy function is pure and takes the platform explicitly,
 * so one host can compute (and test) the policy of every OS.
 */
import * as path from "node:path";
import type { SandboxReadScope } from "./types";

/** Path module matching `platform`'s separators and rules. */
export function pathApi(platform: NodeJS.Platform): typeof path.posix {
	return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Package that ships each host command MXC's bubblewrap network modes need, in display order.
 * Commands not listed here are shown under their own name.
 */
const NETWORK_COMMAND_PACKAGES: Record<string, string> = {
	slirp4netns: "slirp4netns",
	nsenter: "util-linux",
	unshare: "util-linux",
	ip: "iproute2",
	iptables: "iptables",
	ip6tables: "iptables",
	"iptables-restore": "iptables",
	"ip6tables-restore": "iptables",
};

/** Distinct packages providing `commands`, in the table's order; unknown commands last, as their own name. */
export function networkPackages(commands: readonly string[]): string[] {
	const packages = new Set<string>();
	for (const [command, pkg] of Object.entries(NETWORK_COMMAND_PACKAGES)) {
		if (commands.includes(command)) packages.add(pkg);
	}
	for (const command of commands) {
		if (!Object.hasOwn(NETWORK_COMMAND_PACKAGES, command)) packages.add(command);
	}
	return [...packages];
}

/** Whether `p` is a filesystem root (`/`, `C:\`, `\\server\share\`); never a valid policy path. */
export function isFilesystemRoot(p: string, platform: NodeJS.Platform): boolean {
	const api = pathApi(platform);
	const normalized = api.normalize(p);
	const root = api.parse(normalized).root;
	return root !== "" && trimSeparator(normalized, platform) === trimSeparator(root, platform);
}

/** Whether `child` equals `parent` or lies under it. Windows compares case-insensitively. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
	const api = pathApi(platform);
	const fold = (p: string): string => (platform === "win32" ? p.toLowerCase() : p);
	const relative = api.relative(fold(parent), fold(child));
	if (relative === "") return true;
	return relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

/**
 * Normalized, de-duplicated `paths` without filesystem roots and without entries nested under an
 * equal-or-wider entry of the list. First-seen order is kept.
 */
export function compactPaths(paths: readonly string[], platform: NodeJS.Platform): string[] {
	const api = pathApi(platform);
	const candidates: string[] = [];
	for (const entry of paths) {
		if (entry.length === 0) continue;
		const normalized = trimSeparator(api.normalize(entry), platform);
		if (isFilesystemRoot(normalized, platform)) continue;
		candidates.push(normalized);
	}
	const result: string[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const covered = candidates.some(
			(other, otherIndex) =>
				otherIndex !== index &&
				isWithin(candidate, other, platform) &&
				// Equal entries: keep the first occurrence only.
				(!isWithin(other, candidate, platform) || otherIndex < index),
		);
		if (!covered) result.push(candidate);
	}
	return result;
}

/**
 * Root children that are device/virtual trees; each backend mounts or allows what it needs of them.
 * Linux `/tmp` is left to bubblewrap's private tmpfs: a read-only bind of the host's would still let
 * contained processes connect to the control sockets there (tmux, ssh-agent, X11).
 */
const EXCLUDED_ROOT_CHILDREN: Partial<Record<NodeJS.Platform, readonly string[]>> = {
	darwin: ["/dev"],
	linux: ["/dev", "/proc", "/sys", "/run", "/tmp"],
};
const DEFAULT_EXCLUDED_ROOT_CHILDREN: readonly string[] = ["/dev", "/proc", "/sys", "/run"];

interface ReadRootsContext {
	workspace: string;
	/** The user's home directory (the user profile on Windows). */
	home: string;
	/** Existing children of the filesystem root, as names or absolute paths (POSIX only). */
	rootEntries: readonly string[];
	/** Directories MXC's policy helpers discover (`sandboxDiscoverPaths`). */
	discovered: { readonlyPaths: readonly string[]; readwritePaths: readonly string[] };
	/** Paths a contained omp (sandbox host, eval workers) must read to start. */
	runtimePaths: readonly string[];
}

/**
 * Directories contained processes may read for `readScope`, never a filesystem root.
 * - `all`: POSIX → the root's children minus device/virtual trees (and, on macOS, the hidden
 *   `/.vol`-style special entries); Windows → the discovered tool/profile paths plus the user profile.
 * - `workspace`: the workspace, the discovered tool paths, and omp's runtime paths.
 */
export function readRoots(platform: NodeJS.Platform, readScope: SandboxReadScope, ctx: ReadRootsContext): string[] {
	if (readScope === "workspace") {
		return compactPaths([ctx.workspace, ...ctx.discovered.readonlyPaths, ...ctx.runtimePaths], platform);
	}
	if (platform === "win32") {
		return compactPaths([...ctx.discovered.readonlyPaths, ctx.home], platform);
	}
	const excluded = EXCLUDED_ROOT_CHILDREN[platform] ?? DEFAULT_EXCLUDED_ROOT_CHILDREN;
	const children = ctx.rootEntries
		.map(entry => path.posix.resolve("/", entry))
		.filter(
			entry =>
				path.posix.dirname(entry) === "/" &&
				!excluded.includes(entry) &&
				!(platform === "darwin" && path.posix.basename(entry).startsWith(".")),
		);
	return compactPaths(children, platform);
}

function trimSeparator(p: string, platform: NodeJS.Platform): string {
	const api = pathApi(platform);
	const root = api.parse(p).root;
	let end = p.length;
	while (end > root.length && (p[end - 1] === api.sep || p[end - 1] === "/")) end--;
	return p.slice(0, end);
}
