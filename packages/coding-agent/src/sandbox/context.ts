/**
 * Filesystem probing behind the sandbox policy: the {@link SandboxPolicyContext} the runtime gathers
 * (the I/O `policy.ts` leaves out) and the realpath checks that keep grants canonical.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { sandboxDiscoverPaths, type VcsGitRepoInfo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { expandTilde, getNativesDir, logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { getPackageDir } from "../config";
import { definedEnv } from "./env";
import {
	compactPaths,
	homebrewCellar,
	installRoot,
	isWithin,
	pathComponents,
	splitAbsolutePath,
	tooBroadPrefix,
} from "./platform";
import type { ResolvedFsPolicy, SandboxPolicyContext } from "./policy";

/** Realpath of `p`, or `undefined` when it does not exist. */
export function realpathIfExists(p: string): string | undefined {
	try {
		return fs.realpathSync(p);
	} catch {
		return undefined;
	}
}

/**
 * Existing entries of `paths`, realpath'd. With `access`, entries the invoking user cannot access
 * that way are dropped too: bubblewrap refuses a whole request naming a path such as `/root`.
 */
function existingReal(paths: readonly string[], access?: number): string[] {
	const out: string[] = [];
	for (const p of paths) {
		const real = realpathIfExists(p);
		if (real === undefined) continue;
		if (access !== undefined) {
			try {
				fs.accessSync(real, access);
			} catch {
				continue;
			}
		}
		out.push(real);
	}
	return out;
}

/**
 * Root of the JS tree omp runs from, so hoisted dependencies and monorepo siblings stay readable:
 * in an installed layout the outermost `node_modules` directory above the package, in a checkout
 * the nearest ancestor holding `.git` (the package directory when there is none). `undefined` for
 * compiled binaries.
 */
function sourceRoot(): string | undefined {
	const packageDir = getPackageDir();
	if (!packageDir) return undefined;
	const segments = packageDir.split(path.sep);
	const nodeModules = segments.indexOf("node_modules");
	if (nodeModules !== -1) return segments.slice(0, nodeModules + 1).join(path.sep);
	for (let dir = packageDir; dir !== path.dirname(dir); dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
	}
	return packageDir;
}

/**
 * Directory of the loaded `pi_natives` addon. `@oh-my-pi/pi-natives` does not export the loaded
 * addon's path, so this is the package's `native/` directory, where a checkout or npm install loads
 * it from; compiled binaries extract it under {@link getNativesDir}, which is added separately.
 */
export function nativeAddonDir(): string | undefined {
	try {
		const entry = url.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-natives"));
		return fs.existsSync(entry) ? path.dirname(entry) : undefined;
	} catch {
		return undefined;
	}
}

/** Git metadata outside the workspace that contained git reads (`read`) and writes (`write`) to commit. */
interface GitGrant {
	read: string;
	write: string[];
}

/** Common-dir stores a linked worktree's commits and fetches write: objects, refs and reflogs. */
const LINKED_WORKTREE_STORES = ["objects", "refs", "logs", "reftable"] as const;

/**
 * Git metadata contained git needs to commit, when it lies outside the workspace; `undefined`
 * otherwise. Covers a linked worktree rooted at the workspace and a workspace that is a strict
 * subdirectory of a checkout: an ordinary one (its `.git` directory, which git writes at its root)
 * or a linked worktree. Never granted for a repository rooted at the filesystem root, the home
 * directory or an ancestor of it (a dotfiles repo at `~`).
 *
 * A linked worktree's common dir is shared with the main checkout and every other worktree, so it is
 * readable but only its object, ref and reflog stores are writable, plus this worktree's own
 * `worktrees/<name>` (index, HEAD). Its `hooks/`, `config` and other worktrees' metadata stay
 * read-only: host git in the main checkout runs those, and the worktree's diff never shows them.
 *
 * The workspace's `.git` metadata is writable by contained processes, so a linked worktree's common
 * dir is accepted only when it has the real linked-worktree shape: the git dir is
 * `<commonDir>/worktrees/<name>` outside the workspace, and its `gitdir` back-pointer (written by
 * git, outside the workspace) names the worktree's `.git` entry.
 */
function gitGrant(
	info: VcsGitRepoInfo | undefined,
	workspace: string,
	home: string,
	platform: NodeJS.Platform,
): GitGrant | undefined {
	try {
		if (!info) return undefined;
		// A symlinked entry would let a contained process point the comparison at another worktree.
		const entryStat = fs.lstatSync(info.gitEntryPath);
		if (entryStat.isSymbolicLink()) return undefined;
		const entry = realpathIfExists(info.gitEntryPath);
		if (!entry) return undefined;
		const repoRoot = path.dirname(entry);
		if (repoRoot === path.dirname(repoRoot) || isWithin(home, repoRoot, platform)) return undefined;
		const atWorkspace = isWithin(workspace, repoRoot, platform) && isWithin(repoRoot, workspace, platform);
		if (!isWithin(workspace, repoRoot, platform)) return undefined;
		const gitDir = realpathIfExists(info.gitDir);
		const commonDir = realpathIfExists(info.commonDir);
		if (!gitDir || !commonDir) return undefined;
		if (entryStat.isDirectory()) {
			// Ordinary checkout: at the workspace root its `.git` is already writable.
			if (atWorkspace || gitDir !== entry || commonDir !== entry) return undefined;
			return { read: entry, write: [entry] };
		}
		if (gitDir === commonDir) return undefined;
		const worktrees = path.dirname(gitDir);
		if (path.basename(worktrees) !== "worktrees" || path.dirname(worktrees) !== commonDir) return undefined;
		if (isWithin(gitDir, workspace, platform)) return undefined;
		const backPointer = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
		if (realpathIfExists(path.resolve(gitDir, backPointer)) !== entry) return undefined;
		// A store replaced by a symlink would carry the grant out of the common dir.
		const stores = LINKED_WORKTREE_STORES.map(store => path.join(commonDir, store)).filter(
			store => realpathIfExists(store) === store,
		);
		return { read: commonDir, write: [gitDir, ...stores] };
	} catch (error) {
		logger.debug("sandbox: git dir lookup failed", { workspace, error: String(error) });
		return undefined;
	}
}

/** Most symlinks {@link toolInstallRoots} examines across the `PATH` directories. */
const MAX_TOOL_LINKS = 4096;
/** Most read roots {@link toolInstallRoots} returns. */
const MAX_TOOL_ROOTS = 512;
/**
 * Fewest sibling roots outside home {@link toolInstallRoots} folds into their parent: TeX Live links
 * each script to its own `texmf-dist/scripts/<package>`, and every policy entry costs a realpath.
 */
const MIN_FOLDED_SIBLINGS = 8;
/** Fewest path components a parent needs for {@link foldSiblingRoots} to fold siblings into it. */
const MIN_FOLDED_PARENT_DEPTH = 3;
/** Most symlinks one {@link trustedRealpath} follows (Linux's own limit). */
const MAX_LINK_HOPS = 40;
/** Deepest `[include]` nesting {@link gitConfigRoots} follows. */
const MAX_GIT_INCLUDE_DEPTH = 5;

/** Whether the regular file `file` has an execute bit. */
function isExecutableFile(file: string): boolean {
	try {
		const stat = fs.statSync(file);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/** Whether `file` is a regular file (through symlinks); `false` on any error. */
function isRegularFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Real path of the absolute path `p`, resolved one component and one symlink at a time: `undefined`
 * when it does not exist, cannot be read, follows more than {@link MAX_LINK_HOPS} links, or any step
 * reads an entry of a directory inside `untrusted` (real paths: the workspace, the private temp dir),
 * or `p` or a link target is a Windows device-namespace path other than a drive or a share. A
 * contained process can re-point a link there, so a grant resolved through one would be its choice.
 * Each directory is checked by its real path, not its spelling (`\\?\C:\ws`, a mapped drive for a
 * share, an 8.3 short name, a Unicode-normalization variant): the walk only ever extends it by
 * entries that are no link, so a contained process cannot steer that realpath.
 * The result is then canonicalized by the filesystem (`realpath`): the walk keeps each component as
 * written, so a `PATH` entry or link target spelling `/USERS/me/bin` on a case-insensitive volume
 * must not slip past the case-sensitive known-root and too-broad checks the callers apply.
 * `seen` memoizes the entries looked up (their link target, `null` for none) and `canonical` the
 * directories' real paths (`undefined` for none) across one probe's calls.
 */
export function trustedRealpath(
	p: string,
	untrusted: readonly string[],
	platform: NodeJS.Platform,
	seen = new Map<string, string | null>(),
	canonical = new Map<string, string | undefined>(),
): string | undefined {
	if (!path.isAbsolute(p)) return undefined;
	// String prefixes, not `isWithin`: this runs for every component of every link scanned.
	// Case-insensitive where the filesystem usually is (Windows, macOS): over-matching is the safe side.
	const fold = (dir: string): string => (platform === "win32" || platform === "darwin" ? dir.toLowerCase() : dir);
	const roots = untrusted.map(root => fold(path.resolve(root)));
	// Fails closed: a directory the walk reached but `realpath` cannot resolve counts as untrusted.
	const inUntrusted = (dir: string): boolean => {
		let real = canonical.get(dir);
		if (!canonical.has(dir)) {
			real = realpathIfExists(dir);
			canonical.set(dir, real);
		}
		if (real === undefined) return true;
		const folded = fold(real);
		return roots.some(root => folded === root || folded.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
	};
	const start = splitAbsolutePath(p, platform);
	if (start === undefined) return undefined;
	let resolved = start.root;
	const pending = start.components.reverse();
	let hops = 0;
	while (pending.length > 0) {
		const name = pending.pop() as string;
		if (name === ".") continue;
		if (name === "..") {
			resolved = path.dirname(resolved);
			continue;
		}
		if (inUntrusted(resolved)) return undefined;
		const next = path.join(resolved, name);
		let target = seen.get(next);
		if (target === undefined) {
			try {
				target = fs.lstatSync(next).isSymbolicLink() ? fs.readlinkSync(next) : null;
			} catch {
				return undefined;
			}
			seen.set(next, target);
		}
		if (target === null) {
			resolved = next;
			continue;
		}
		if (++hops > MAX_LINK_HOPS) return undefined;
		const jump = path.isAbsolute(target)
			? splitAbsolutePath(target, platform)
			: { root: undefined, components: pathComponents(target, platform) };
		if (jump === undefined) return undefined;
		if (jump.root !== undefined) resolved = jump.root;
		pending.push(...jump.components.reverse());
	}
	return realpathIfExists(resolved);
}

/**
 * Read roots that let the symlinked tools in the `PATH` directories `toolDirs` start when they
 * resolve outside the readable roots. A link to an executable inside a Homebrew Cellar grants the
 * Cellar once (`/opt/homebrew/bin/python3` → `Cellar/python@3.x/<ver>/bin/python3`, whose
 * `Frameworks/` and dependency kegs dyld then loads through `<prefix>/opt/*`); any other its
 * {@link installRoot}. At least {@link MIN_FOLDED_SIBLINGS} roots outside `home` with one parent
 * fold into that parent (see {@link foldSiblingRoots}). Directories are deduplicated by real path and
 * scanned in order; every chain is resolved by {@link trustedRealpath}, so nothing resolved through
 * the workspace or the private temp dir (`untrusted`) is granted. Non-executables and links
 * resolving inside `readable` are skipped; at most {@link MAX_TOOL_LINKS} links are examined and
 * {@link MAX_TOOL_ROOTS} roots kept. Nothing on Windows.
 *
 * Known limit: a `PATH` directory writable through `allowWrite` or a session write grant is not
 * treated as untrusted, so a contained process can plant a link there that the next gather follows.
 */
export function toolInstallRoots(
	toolDirs: readonly string[],
	readable: readonly string[],
	untrusted: readonly string[],
	home: string,
	platform: NodeJS.Platform,
): string[] {
	if (platform === "win32") return [];
	const known = [...readable, ...existingReal(readable)];
	const untrustedReal = [...untrusted, ...existingReal(untrusted)];
	const roots = new Set<string>();
	const scanned = new Set<string>();
	const seen = new Map<string, string | null>();
	const canonical = new Map<string, string | undefined>();
	let examined = 0;
	scan: for (const dir of toolDirs) {
		const realDir = trustedRealpath(dir, untrustedReal, platform, seen, canonical);
		if (realDir === undefined || scanned.has(realDir)) continue;
		scanned.add(realDir);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(realDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isSymbolicLink()) continue;
			if (examined === MAX_TOOL_LINKS) {
				logger.debug("sandbox: PATH tool scan stopped at its link limit", { limit: MAX_TOOL_LINKS, dir: realDir });
				break scan;
			}
			examined++;
			const real = trustedRealpath(path.join(realDir, entry.name), untrustedReal, platform, seen, canonical);
			if (real === undefined || known.some(root => isWithin(real, root, platform)) || !isExecutableFile(real)) {
				continue;
			}
			const root = homebrewCellar(real, home, platform) ?? installRoot(real, home, platform);
			if (root === undefined || roots.has(root)) continue;
			if (roots.size === MAX_TOOL_ROOTS) {
				logger.debug("sandbox: PATH tool scan stopped at its root limit", { limit: MAX_TOOL_ROOTS, dir: realDir });
				break scan;
			}
			roots.add(root);
		}
	}
	return foldSiblingRoots(roots, home, platform);
}

/**
 * `roots` with every group of at least {@link MIN_FOLDED_SIBLINGS} siblings (one parent) replaced by
 * that parent, unless the parent is inside `home`, too broad a grant, or fewer than
 * {@link MIN_FOLDED_PARENT_DEPTH} levels deep (`/usr/local` never; `/usr/local/texlive` may).
 */
export function foldSiblingRoots(roots: Iterable<string>, home: string, platform: NodeJS.Platform): string[] {
	const byParent = new Map<string, string[]>();
	for (const root of roots) {
		const parent = path.dirname(root);
		const siblings = byParent.get(parent);
		if (siblings) siblings.push(root);
		else byParent.set(parent, [root]);
	}
	return [...byParent].flatMap(([parent, siblings]) =>
		siblings.length >= MIN_FOLDED_SIBLINGS &&
		parent.split(path.sep).filter(Boolean).length >= MIN_FOLDED_PARENT_DEPTH &&
		!isWithin(parent, home, platform) &&
		!tooBroadPrefix(parent, home, platform, true)
			? [parent]
			: siblings,
	);
}

/**
 * Files the plain `path = <value>` lines of the `[include]` and `[includeIf "…"]` sections of the git
 * config `configFile` (as git opened it; its content read from `real`) name: `~/` expanded, relative
 * values against `configFile`'s directory, as git resolves them. Other forms (quoted escapes,
 * continuation lines, `~user`, `%(prefix)`, a key on the header line) are skipped.
 */
function gitIncludePaths(configFile: string, real: string, home: string): string[] {
	let text: string;
	try {
		text = fs.readFileSync(real, "utf8");
	} catch {
		return [];
	}
	let inInclude = false;
	const out: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			inInclude = /^\[\s*(?:include|includeif\s+"[^"\\]*")\s*\]$/i.test(line);
			continue;
		}
		const match = inInclude ? /^path\s*=\s*(.*)$/i.exec(line) : null;
		if (!match) continue;
		let value = match[1].replace(/\s+[#;].*$/, "");
		if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		if (!value || /["\\]/.test(value) || value.startsWith("%(")) continue;
		if (value === "~" || value.startsWith("~/")) value = path.join(home, value.slice(1));
		else if (value.startsWith("~")) continue;
		// Not `path.resolve`: git resolves `..` after following links, so it stays for `trustedRealpath`.
		out.push(path.isAbsolute(value) ? value : path.dirname(configFile) + path.sep + value);
	}
	return out;
}

/**
 * `<prefix>/etc/gitconfig`, the system config of the first executable `git` in `pathDirs` when it
 * resolves into a Homebrew Cellar (by {@link trustedRealpath}); `undefined` otherwise.
 */
function homebrewGitConfig(
	pathDirs: readonly string[],
	home: string,
	untrusted: readonly string[],
	platform: NodeJS.Platform,
): string | undefined {
	const git = pathDirs.map(dir => path.join(dir, "git")).find(isExecutableFile);
	const real = git === undefined ? undefined : trustedRealpath(git, untrusted, platform);
	const cellar = real === undefined ? undefined : homebrewCellar(real, home, platform);
	return cellar && path.join(path.dirname(cellar), "etc", "gitconfig");
}

/**
 * Regular files of the global git configuration that exist, realpath'd, never a directory (the XDG
 * git directory also holds `credentials`): `~/.gitconfig`; `config`, `ignore` and `attributes` of
 * `$XDG_CONFIG_HOME/git` (default `~/.config/git`); the file `$GIT_CONFIG_GLOBAL` names (absolute
 * paths only; `/dev/null`, the usual way to disable it, is no regular file); `<prefix>/etc/gitconfig`
 * when the first `git` in `pathDirs` is a Homebrew link. The config files' plain `[include]` and
 * `[includeIf]` paths are followed too, at most {@link MAX_GIT_INCLUDE_DEPTH} levels deep. Each is
 * resolved by {@link trustedRealpath}: nothing reached through `untrusted` is granted.
 */
export function gitConfigRoots(
	home: string,
	env: Readonly<Record<string, string | undefined>>,
	pathDirs: readonly string[],
	untrusted: readonly string[],
	platform: NodeJS.Platform,
): string[] {
	const untrustedReal = [...untrusted, ...existingReal(untrusted)];
	const xdg =
		env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
	const configs = [path.join(home, ".gitconfig"), path.join(xdg, "git", "config")];
	// A relative value is skipped: `trustedRealpath` takes absolute paths only.
	if (env.GIT_CONFIG_GLOBAL) configs.push(env.GIT_CONFIG_GLOBAL);
	const system = homebrewGitConfig(pathDirs, home, untrustedReal, platform);
	if (system !== undefined) configs.push(system);
	const granted = new Set<string>();
	const seen = new Map<string, string | null>();
	const canonical = new Map<string, string | undefined>();
	const grant = (file: string, includeDepth: number | undefined): void => {
		const real = trustedRealpath(file, untrustedReal, platform, seen, canonical);
		if (real === undefined || granted.has(real) || !isRegularFile(real)) return;
		granted.add(real);
		if (includeDepth === undefined || includeDepth >= MAX_GIT_INCLUDE_DEPTH) return;
		for (const include of gitIncludePaths(file, real, home)) grant(include, includeDepth + 1);
	};
	for (const config of configs) grant(config, 0);
	for (const name of ["ignore", "attributes"]) grant(path.join(xdg, "git", name), undefined);
	return [...granted];
}

/** Everything in {@link SandboxPolicyContext} except the per-request extras. */
export type BaseContext = Omit<SandboxPolicyContext, "extraRead" | "extraWrite" | "protectedPaths"> & {
	/**
	 * Read-only roots of `readScope: workspace` only, probed on the first call and then kept (see
	 * `ReadRootsContext.workspaceRead` in ./platform).
	 */
	workspaceRead: () => readonly string[];
	git?: GitGrant;
	/** Protected paths of the workspace and its git metadata, without `core.hooksPath` (the runtime adds it). */
	protectedPaths: string[];
	/**
	 * Unprotected git metadata the identity watch records only as a symlink, existing or not: the
	 * `worktrees` of the common dir and of every submodule git dir. Contained `git worktree add`
	 * creates it as a real directory; a link there would redirect host git's worktree writes.
	 */
	linkWatchedPaths: string[];
};

/** Git dir entries host git runs code from, is configured by, or is redirected by (`commondir`, `gitdir`). */
const PROTECTED_GIT_ENTRIES = ["config", "config.worktree", "hooks", "commondir", "gitdir"] as const;
/** Entries of each linked worktree's `<commonDir>/worktrees/<name>` that configure or redirect its git. */
const PROTECTED_WORKTREE_ENTRIES = ["commondir", "gitdir", "config.worktree"] as const;
/** Workspace-root entries omp turns into host code or host spawns (extensions, hooks, MCP/LSP/DAP config). */
const PROTECTED_PROJECT_ENTRIES = [
	...[".omp", ".claude", ".codex", ".gemini", ".cursor", ".vscode", ".windsurf", ".opencode"],
	...["mcp.json", ".mcp.json", "opencode.json", "opencode.jsonc"],
	...["lsp", "dap"].flatMap(base => ["json", "yaml", "yml"].flatMap(ext => [`${base}.${ext}`, `.${base}.${ext}`])),
];

/** Child directories of `dir` (never through a symlink); none when it cannot be read. */
function childDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter(entry => entry.isDirectory())
			.map(entry => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

/**
 * Appends to `out` every submodule git dir below `modules`. Git stores a submodule under its name,
 * which may hold slashes (`modules/vendor/lib`): a directory holding `config` or `HEAD` is a git
 * dir, whose own `modules/` holds its nested submodules; any other directory is a name prefix.
 */
function collectSubmoduleGitDirs(modules: string, out: string[]): void {
	for (const dir of childDirs(modules)) {
		if (fs.existsSync(path.join(dir, "config")) || fs.existsSync(path.join(dir, "HEAD"))) {
			out.push(dir);
			collectSubmoduleGitDirs(path.join(dir, "modules"), out);
		} else {
			collectSubmoduleGitDirs(dir, out);
		}
	}
}

/**
 * `core.worktree` of the git dir `gitDir`, in the plain form `git submodule` writes: a `[core]`
 * header without subsection, then `worktree = <value>` (key case-insensitive, value trimmed, one
 * pair of double quotes stripped). Any other form (includes, subsections, escapes, continuation
 * lines, several values, the header-line form `[core] worktree = x`) yields `undefined`. Safe to
 * trust: the config is a protected path, so contained processes cannot write it; an unrecognised
 * form only leaves that checkout's `.git` pointer unprotected. Never runs git: the context is
 * gathered synchronously.
 */
function coreWorktree(gitDir: string): string | undefined {
	let text: string;
	try {
		text = fs.readFileSync(path.join(gitDir, "config"), "utf8");
	} catch {
		return undefined;
	}
	let section: string | undefined;
	const values: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.endsWith("\\")) return undefined;
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			section = line.toLowerCase();
			if (section.startsWith("[include")) return undefined;
			continue;
		}
		const match = /^worktree\s*=\s*(.*)$/i.exec(line);
		if (section === "[core]" && match) values.push(match[1]);
	}
	if (values.length !== 1) return undefined;
	let value = values[0];
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
	return value && !/["\\#;]/.test(value) ? value : undefined;
}

/** The `.git` pointer file of the checkout `gitDir`'s `core.worktree` names, when it lies inside `workspace`. */
function checkoutPointer(gitDir: string, workspace: string): string | undefined {
	const worktree = coreWorktree(gitDir);
	if (worktree === undefined) return undefined;
	const pointer = path.join(path.resolve(gitDir, worktree), ".git");
	if (!isWithin(pointer, workspace, process.platform)) return undefined;
	return fs.lstatSync(pointer, { throwIfNoEntry: false })?.isFile() ? pointer : undefined;
}

/**
 * {@link BaseContext.protectedPaths}: paths inside the workspace or its git metadata that omp loads
 * or runs outside the sandbox, so contained processes must not write them (existing or not): the
 * project config entries at the workspace root; the workspace's `.git` entry when it is a file (a
 * gitdir pointer), or when the workspace has no repository (missing: a contained `git init` creates
 * one host git would run); in each git dir {@link PROTECTED_GIT_ENTRIES}, and the existing ones of
 * every submodule git dir found below its `modules/`, plus the `.git` pointer file of that
 * submodule's checkout (by its `core.worktree`) inside the workspace; the existing
 * {@link PROTECTED_WORKTREE_ENTRIES} of every linked worktree of the common dir. Lexical paths: the
 * runtime adds what each resolves to at policy time.
 * {@link BaseContext.linkWatchedPaths}: `worktrees` of the common dir and of every submodule git dir
 * the same walk finds (lexical, under the realpath'd git dirs).
 */
function guardedPaths(
	workspace: string,
	info: VcsGitRepoInfo | undefined,
): Pick<BaseContext, "protectedPaths" | "linkWatchedPaths"> {
	const entries = PROTECTED_PROJECT_ENTRIES.map(entry => path.join(workspace, entry));
	const linkWatched: string[] = [];
	const gitEntry = info?.gitEntryPath ?? path.join(workspace, ".git");
	if (!info || fs.lstatSync(gitEntry, { throwIfNoEntry: false })?.isFile()) entries.push(gitEntry);
	const gitDirs = new Set(
		[info?.gitDir, info?.commonDir].flatMap(dir => (dir === undefined ? [] : (realpathIfExists(dir) ?? []))),
	);
	for (const dir of gitDirs) {
		const submodules: string[] = [];
		collectSubmoduleGitDirs(path.join(dir, "modules"), submodules);
		for (const entry of PROTECTED_GIT_ENTRIES) entries.push(path.join(dir, entry));
		for (const base of submodules) {
			linkWatched.push(path.join(base, "worktrees"));
			for (const entry of PROTECTED_GIT_ENTRIES) {
				const target = path.join(base, entry);
				if (fs.existsSync(target)) entries.push(target);
			}
			const pointer = checkoutPointer(base, workspace);
			if (pointer !== undefined) entries.push(pointer);
		}
	}
	const commonDir = info && realpathIfExists(info.commonDir);
	if (commonDir) linkWatched.push(path.join(commonDir, "worktrees"));
	for (const worktree of commonDir ? childDirs(path.join(commonDir, "worktrees")) : []) {
		for (const entry of PROTECTED_WORKTREE_ENTRIES) {
			const target = path.join(worktree, entry);
			if (fs.existsSync(target)) entries.push(target);
		}
	}
	return {
		protectedPaths: [...new Set(entries.map(entry => path.resolve(entry)))],
		linkWatchedPaths: [...new Set(linkWatched)],
	};
}

/** The workspace's git repository, or `undefined` outside one (or when the lookup fails). */
function workspaceGitInfo(workspace: string): VcsGitRepoInfo | undefined {
	try {
		return vcs.gitInfo(workspace) ?? undefined;
	} catch (error) {
		logger.debug("sandbox: git dir lookup failed", { workspace, error: String(error) });
		return undefined;
	}
}

/**
 * Synchronous (once per runtime and private temp dir) so the runtime's effective policy can stay
 * synchronous. `tmpdir` is the runtime's private temp dir, the only writable temp root.
 * `workspaceRead` probes the `PATH` tools and git configuration on its first call, which only a
 * `readScope: workspace` policy makes, with the environment of this gather.
 */
export function gatherContext(workspace: string, tmpdir: string): BaseContext {
	const platform = process.platform;
	const home = resolveEquivalentPath(os.homedir());
	const rootEntries = platform === "win32" ? [] : fs.readdirSync("/").map(name => path.posix.join("/", name));
	const discovered = sandboxDiscoverPaths(definedEnv(process.env));
	// What a contained omp (sandbox host, eval workers) must read to start; always readable.
	const runtimePaths = compactPaths(
		[path.dirname(process.execPath), nativeAddonDir(), sourceRoot()].filter((p): p is string => !!p),
		platform,
	);
	runtimePaths.push(getNativesDir());
	const info = workspaceGitInfo(workspace);
	const { PATH, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL } = process.env;
	const pathDirs = (PATH ?? "").split(path.delimiter).filter(entry => path.isAbsolute(entry));
	let workspaceRead: string[] | undefined;
	const probeWorkspaceRead = (): string[] => {
		const untrusted = [workspace, tmpdir];
		// MXC drops the PATH entries it does not grant (system directories readable anyway).
		const toolDirs = pathDirs.filter(dir => discovered.readonlyPaths.some(entry => isWithin(dir, entry, platform)));
		const readable = [workspace, ...discovered.readonlyPaths, ...runtimePaths];
		return compactPaths(
			[
				...toolInstallRoots(toolDirs, readable, untrusted, home, platform),
				...gitConfigRoots(home, { XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL }, pathDirs, untrusted, platform),
			],
			platform,
		);
	};
	return {
		workspace,
		home,
		tmpdir,
		platform,
		rootEntries,
		discovered,
		runtimePaths,
		workspaceRead: () => (workspaceRead ??= probeWorkspaceRead()),
		git: gitGrant(info, workspace, home, platform),
		...guardedPaths(workspace, info),
	};
}

/**
 * Resolved `core.hooksPath` of the workspace's repository (`~` expanded, relative to the repository
 * root, as host git resolves it; not canonicalized), or `undefined` when unset or outside a repository.
 * `previous` while host git refuses the repository (its metadata is ledgered): it stays protected.
 */
export async function gitHooksPath(workspace: string, previous?: string): Promise<string | undefined> {
	try {
		const info = vcs.gitInfo(workspace);
		const value = info ? await vcs.git(workspace)?.configGet("core.hooksPath") : undefined;
		if (!info || !value) return undefined;
		return path.resolve(info.repoRoot, expandTilde(value));
	} catch (error) {
		if (vcs.isVcsError(error) && error.code === "Refused") return previous;
		logger.debug("sandbox: core.hooksPath lookup failed", { workspace, error: String(error) });
		return undefined;
	}
}

/** Whether `canonical` exists, is not a symlink, and still resolves to itself. */
export function stillCanonical(canonical: string): boolean {
	const stat = fs.lstatSync(canonical, { throwIfNoEntry: false });
	return stat !== undefined && !stat.isSymbolicLink() && realpathIfExists(canonical) === canonical;
}

/**
 * Recreates a missing canonical write grant as an empty directory, never through a symlink: only
 * while its parent still resolves to itself. Best effort; a grant that stays missing is simply not
 * materialised.
 */
export function recreateMissingGrant(grant: string): void {
	const parent = path.dirname(grant);
	if (realpathIfExists(parent) !== parent) return;
	try {
		fs.mkdirSync(grant);
	} catch (error) {
		logger.debug("sandbox: recreating a missing session write grant failed", { path: grant, error: String(error) });
	}
}

/**
 * `policy` restricted to existing paths the user can access, each realpath'd (macOS `/tmp` →
 * `/private/tmp`), then compacted again; readable entries inside a writable one are dropped, and so
 * are those at or under a denied path (a mount-based backend would reopen it with the deeper entry).
 *
 * The existing protected paths inside a writable root are carved out as read-only entries (the
 * backend's most-specific-path rule lets them win), except one a writable entry names exactly
 * (the backend resolves an exact tie read-only). Each writable entry at or below a protected
 * path stays an entry of its own (the deeper entry wins again), although compacting folded it
 * into a wider root. Every directory between a carve-out and its writable root is a writable
 * entry of its own too: a mount-based backend makes it a mount point, so a contained process
 * cannot rename it away (`mv .git .git-old`) and plant a writable replacement. Nothing at or
 * under a denied path is carved out (nor gets such directories): the deeper entry would reopen
 * the denied mount, which already blocks writes. `protectedPaths` keeps every entry, existing or
 * not: omp's own file tools refuse writes to missing ones too. The lift rule is also encoded in
 * `resolveFsPolicy` (./policy) and `SandboxRuntime#pathDenial`: keep the three in step.
 */
export function materialize(policy: ResolvedFsPolicy, platform: NodeJS.Platform): ResolvedFsPolicy {
	const { R_OK, W_OK } = fs.constants;
	const writable = existingReal(policy.readwritePaths, R_OK | W_OK);
	const roots = compactPaths(writable, platform);
	const deniedPaths = compactPaths(existingReal(policy.deniedPaths), platform);
	const readonlyPaths = compactPaths(existingReal(policy.readonlyPaths, R_OK), platform).filter(
		entry =>
			!roots.some(rw => isWithin(entry, rw, platform)) &&
			!deniedPaths.some(denied => isWithin(entry, denied, platform)),
	);
	const existingProtected = existingReal(policy.protectedPaths.map(({ real }) => real));
	const carved = new Set(
		existingProtected.filter(
			entry =>
				!writable.includes(entry) &&
				roots.some(rw => isWithin(entry, rw, platform)) &&
				!deniedPaths.some(denied => isWithin(entry, denied, platform)),
		),
	);
	const extraWritable = new Set<string>();
	for (const entry of carved) {
		// The deepest writable entry holding it (its own entry too: a folded grant of `.git` must stay
		// a mount point); directories below that one are writable through it.
		const container = writable
			.filter(rw => isWithin(entry, rw, platform))
			.reduce((deepest, rw) => (rw.length > deepest.length ? rw : deepest));
		let between = [container];
		for (let dir = path.dirname(entry); dir !== container && isWithin(dir, container, platform);) {
			// Inside another carve-out a directory is read-only: never make it writable.
			if (carved.has(dir)) between = [container];
			else between.push(dir);
			dir = path.dirname(dir);
		}
		for (const dir of between) extraWritable.add(dir);
	}
	// Grants at or below a protected path (also one named through a symlink, never carved).
	for (const entry of writable) {
		if (!roots.includes(entry) && existingProtected.some(protectedPath => isWithin(entry, protectedPath, platform))) {
			extraWritable.add(entry);
		}
	}
	return {
		readwritePaths: [...roots, ...[...extraWritable].filter(entry => !roots.includes(entry))],
		readonlyPaths: [...readonlyPaths, ...carved],
		deniedPaths,
		protectedPaths: policy.protectedPaths,
	};
}
