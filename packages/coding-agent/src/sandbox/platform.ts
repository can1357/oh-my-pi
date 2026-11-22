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

/** Non-empty components of `p`, split on every separator `platform` accepts (both on Windows). */
export function pathComponents(p: string, platform: NodeJS.Platform): string[] {
	return p.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean);
}

/** Windows device-namespace prefix: `\\?\` or `\\.\`, either separator. */
const WIN32_DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/;
/** Drive (`C:`) after a device-namespace prefix. */
const WIN32_DEVICE_DRIVE = /^([A-Za-z]:)(?:[\\/]+|$)/;
/** Share (`UNC\srv\share`) after a `\\?\` prefix. */
const WIN32_DEVICE_UNC = /^UNC[\\/]+([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/i;

/**
 * `p` (absolute for `platform`) as its root and the components after it, in order. The root is
 * taken once: `C:\`, `C:/` or `\\server\share\` on Windows, `/` elsewhere; only the remainder is
 * split, so a walk never revisits the drive or the share. A Windows device-namespace spelling maps to
 * its plain root (`\\?\C:\`, `\\.\C:\` → `C:\`; `\\?\UNC\srv\share\` → `\\srv\share\`); any other
 * device-namespace root (`\\.\pipe\`, `\\?\Volume{…}\`) is `undefined`.
 */
export function splitAbsolutePath(
	p: string,
	platform: NodeJS.Platform,
): { root: string; components: string[] } | undefined {
	if (platform === "win32") {
		const prefix = WIN32_DEVICE_PREFIX.exec(p);
		if (prefix) {
			const rest = p.slice(prefix[0].length);
			const drive = WIN32_DEVICE_DRIVE.exec(rest);
			if (drive) return { root: `${drive[1]}\\`, components: pathComponents(rest.slice(drive[0].length), platform) };
			const unc = prefix[0][2] === "?" ? WIN32_DEVICE_UNC.exec(rest) : null;
			if (unc) {
				return {
					root: `\\\\${unc[1]}\\${unc[2]}\\`,
					components: pathComponents(rest.slice(unc[0].length), platform),
				};
			}
			return undefined;
		}
	}
	const { root } = pathApi(platform).parse(p);
	return { root, components: pathComponents(p.slice(root.length), platform) };
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
 * equal-or-wider entry of the list. First-seen order is kept. Linear in the entries times their
 * depth: each entry's ancestors are looked up in a set.
 */
export function compactPaths(paths: readonly string[], platform: NodeJS.Platform): string[] {
	const api = pathApi(platform);
	const fold = (p: string): string => (platform === "win32" ? p.toLowerCase() : p);
	const candidates: string[] = [];
	for (const entry of paths) {
		if (entry.length === 0) continue;
		const normalized = trimSeparator(api.normalize(entry), platform);
		if (isFilesystemRoot(normalized, platform)) continue;
		candidates.push(normalized);
	}
	const keys = new Set(candidates.map(fold));
	const kept = new Set<string>();
	const result: string[] = [];
	for (const candidate of candidates) {
		const key = fold(candidate);
		// Equal entries: keep the first occurrence only.
		if (kept.has(key)) continue;
		let covered = false;
		for (let dir = api.dirname(candidate); !isFilesystemRoot(dir, platform); dir = api.dirname(dir)) {
			if (keys.has(fold(dir))) {
				covered = true;
				break;
			}
			if (api.dirname(dir) === dir) break;
		}
		if (covered) continue;
		kept.add(key);
		result.push(candidate);
	}
	return result;
}

/** Directory names a tool's install prefix sits above: `<prefix>/bin/tool`, `<prefix>/libexec/bin/tool`. */
const PREFIX_SUBDIRS: Record<string, true> = { bin: true, sbin: true, libexec: true };

/**
 * Whether a read grant of `dir` is too broad for a tool's install prefix: a filesystem root, a direct
 * child of it, the home directory or an ancestor of it, or (with `homeChild`) a direct child of home.
 */
export function tooBroadPrefix(dir: string, home: string, platform: NodeJS.Platform, homeChild: boolean): boolean {
	const api = pathApi(platform);
	return (
		isFilesystemRoot(dir, platform) ||
		isFilesystemRoot(api.dirname(dir), platform) ||
		isWithin(home, dir, platform) ||
		(homeChild && api.dirname(dir) === home)
	);
}

/**
 * Install prefix of the executable whose real path is `real`: its directory, widened to the parent
 * while that directory is a `bin`/`sbin`/`libexec` (`<prefix>/libexec/bin/tool`, whose libraries lie
 * in `<prefix>/lib`). Never widened to a filesystem root, a direct child of the root, the home
 * directory, an ancestor of it or a direct child of it (`~/.cargo`, whose `credentials.toml` the tool
 * never needs). `undefined` when the directory itself is a filesystem root, a direct child of the
 * root, the home directory or an ancestor of it (`~/script.sh`, `/opt/tool`), or a direct child of
 * home other than `bin`/`sbin`/`libexec` (`~/Documents/x.sh`): no grant is narrow enough. A direct
 * child of home named `bin`/`sbin`/`libexec` is granted as is (`~/bin/tool` → `~/bin`). Windows
 * never widens.
 */
export function installRoot(real: string, home: string, platform: NodeJS.Platform): string | undefined {
	const api = pathApi(platform);
	let root = api.dirname(real);
	if (platform === "win32") return root;
	if (tooBroadPrefix(root, home, platform, false)) return undefined;
	if (api.dirname(root) === home && !Object.hasOwn(PREFIX_SUBDIRS, api.basename(root))) return undefined;
	while (Object.hasOwn(PREFIX_SUBDIRS, api.basename(root))) {
		const parent = api.dirname(root);
		if (tooBroadPrefix(parent, home, platform, true)) break;
		root = parent;
	}
	return root;
}

/**
 * The Homebrew Cellar (`<prefix>/Cellar`) holding the real path `real`, unless that would be too
 * broad a grant (see {@link installRoot}); `undefined` outside one, and on Windows.
 */
export function homebrewCellar(real: string, home: string, platform: NodeJS.Platform): string | undefined {
	if (platform === "win32") return undefined;
	const api = pathApi(platform);
	for (let dir = api.dirname(real); api.dirname(dir) !== dir; dir = api.dirname(dir)) {
		if (api.basename(dir) === "Cellar") return tooBroadPrefix(dir, home, platform, true) ? undefined : dir;
	}
	return undefined;
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
	/**
	 * Read-only roots of `workspace` scope only, beyond the discovered tool directories: what the
	 * symlinked tools in the `PATH` directories need to start and the global git configuration. A
	 * function, so the probing behind it runs for `workspace` scope only; `all` already reads them
	 * (or, on Windows, ignores them).
	 */
	workspaceRead?: () => readonly string[];
}

/**
 * Directories contained processes may read for `readScope`, never a filesystem root.
 * - `all`: POSIX → the root's children minus device/virtual trees (and, on macOS, the hidden
 *   `/.vol`-style special entries); Windows → the discovered tool/profile paths plus the user profile.
 * - `workspace`: the workspace, the discovered tool paths, omp's runtime paths, and `workspaceRead`.
 */
export function readRoots(platform: NodeJS.Platform, readScope: SandboxReadScope, ctx: ReadRootsContext): string[] {
	if (readScope === "workspace") {
		return compactPaths(
			[ctx.workspace, ...ctx.discovered.readonlyPaths, ...ctx.runtimePaths, ...(ctx.workspaceRead?.() ?? [])],
			platform,
		);
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
