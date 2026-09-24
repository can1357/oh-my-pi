/**
 * Linux cgroup-v2 placement for external tool workloads.
 *
 * An interactive session and the heavy tools it launches must not share one
 * memory budget. A tool that holds the aggregate at `memory.high` stalls the
 * event loop in `mem_cgroup_handle_over_high`, so the UI that would cancel it
 * stops responding and the only remaining options are killing the whole
 * session or raising its limits (dotfiles#41). Placement fixes that by moving
 * external payloads into a separate delegated leaf before they start: the
 * control process keeps its own budget, and a runaway workload is bounded by
 * the leaf's limits instead of throttling the controls.
 *
 * The contract has three parts:
 *   - {@link configureToolCgroup} takes the CLI-provided path (or inherits
 *     `OMP_TOOL_CGROUP`) and validates it once, fail-closed.
 *   - {@link resolveToolCgroup} returns the target when a spawned child still
 *     needs to be moved into it.
 *   - {@link wrapToolCommand} prepends the frozen `/bin/sh` bootstrap.
 *
 * Scope: resource containment for cooperative same-user processes. This is not
 * a hostile-code sandbox — the leaf and the payload have the same owner.
 *
 * Side-effect free on import. Nothing is placed unless a leaf was explicitly
 * configured, so absent configuration leaves existing behavior untouched on
 * every platform.
 */

import type { Stats } from "node:fs";
import { accessSync, constants, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import * as path from "node:path";

/** Internal variable carrying the resolved placement path to child processes. */
export const TOOL_CGROUP_ENV = "OMP_TOOL_CGROUP";

/** Literal prefix every bootstrap-side placement failure prints to stderr. */
export const PLACEMENT_FAILURE_PREFIX = "omp: tool cgroup placement failed";

/** `statfs` type of a cgroup-v2 superblock. */
const CGROUP2_SUPER_MAGIC = 0x63677270;

/** Interpreter used by the frozen bootstrap. */
const PLACEMENT_SHELL = "/bin/sh";

/** `$0` of the bootstrap; it exists only so shell diagnostics are readable. */
const PLACEMENT_PROGRAM = "omp-workload";

/**
 * Frozen bootstrap. `-p` keeps bash from sourcing `BASH_ENV` and from importing
 * function definitions out of the payload environment before placement happens;
 * the payload still receives that environment intact.
 *
 * Arity or placement failure exits 125 without executing the payload, so a
 * caller can never observe a "placed" command that was actually uncontained.
 */
const PLACEMENT_SCRIPT = [
	`if [ "$#" -lt 2 ]; then echo "${PLACEMENT_FAILURE_PREFIX}" >&2; exit 125; fi`,
	`if ! echo 0 > "$1/cgroup.procs"; then echo "${PLACEMENT_FAILURE_PREFIX}" >&2; exit 125; fi`,
	"shift",
	'exec "$@"',
].join("\n");

interface Placement {
	/** Canonical absolute path of the delegated leaf. */
	readonly path: string;
	/** Whether this process already runs inside `path`, so children inherit it. */
	readonly contained: boolean;
}

let configured: Placement | undefined;

/**
 * Configure placement from the CLI option or, when absent, the inherited
 * environment.
 *
 * A CLI path that contradicts an inherited `OMP_TOOL_CGROUP` is rejected
 * instead of widening a nested session's allowance. Validation is fail-closed:
 * a configured target that is not a usable cgroup-v2 leaf throws, naming the
 * path, before any command is dispatched.
 */
export function configureToolCgroup(target?: string): void {
	const requested = target?.trim() || undefined;
	const inherited = process.env[TOOL_CGROUP_ENV]?.trim() || undefined;

	if (requested && inherited && requested !== inherited) {
		throw new Error(
			`tool cgroup conflict: --tool-cgroup=${requested} contradicts inherited ${TOOL_CGROUP_ENV}=${inherited}`,
		);
	}

	const effective = requested ?? inherited;
	if (!effective) {
		configured = undefined;
		return;
	}

	// Re-validating the same target on every spawn is pure syscall overhead, and
	// accepting a second, different target would widen an allowance that is
	// already in effect for this process tree.
	if (configured) {
		if (configured.path === effective) return;
		throw new Error(
			`tool cgroup conflict: already configured with ${configured.path}, refusing ${canonicalizeTarget(effective)}`,
		);
	}

	const canonical = canonicalizeTarget(effective);
	const own = currentCgroupPath();
	configured = {
		path: canonical,
		contained: own === canonical || own?.startsWith(`${canonical}${path.sep}`) === true,
	};
	// Inherited by every child, so a nested agent launch cannot start a fresh
	// allowance by dropping the flag or inventing its own path.
	process.env[TOOL_CGROUP_ENV] = canonical;
}

/**
 * Validated placement target for a child that still has to be moved into it.
 *
 * Returns `undefined` when placement is disabled — no configuration — or when
 * this process already runs inside the target, where children inherit
 * membership and a bootstrap would only move the payload upward into the wider
 * leaf.
 */
export function resolveToolCgroup(): string | undefined {
	if (!configured) configureToolCgroup(undefined);
	if (!configured || configured.contained) return undefined;
	return configured.path;
}

/**
 * Prepend the placement bootstrap to `command`.
 *
 * Returns the original arguments when no placement is required, so uninvolved
 * spawns keep their exact argv. Otherwise every original element stays a
 * separate argument: no shell word-splitting touches the payload.
 */
export function wrapToolCommand(command: readonly string[]): string[] {
	const target = resolveToolCgroup();
	if (!target) return [...command];
	return [PLACEMENT_SHELL, "-p", "-c", PLACEMENT_SCRIPT, PLACEMENT_PROGRAM, target, ...command];
}

/**
 * Resolve and validate a delegated leaf, returning its canonical path.
 *
 * Every check fails closed: an unvalidated target could otherwise be accepted
 * by the bootstrap and silently widen or void containment.
 */
function canonicalizeTarget(candidate: string): string {
	if (process.platform !== "linux") {
		throw new Error(`tool cgroup ${candidate}: cgroup-v2 placement is Linux-only (got ${process.platform})`);
	}
	if (!path.isAbsolute(candidate)) throw new Error(`tool cgroup ${candidate}: path must be absolute`);

	const uid = process.getuid?.();
	const euid = process.geteuid?.();
	const gid = process.getgid?.();
	const egid = process.getegid?.();
	if (
		uid === undefined ||
		euid === undefined ||
		gid === undefined ||
		egid === undefined ||
		uid !== euid ||
		gid !== egid
	) {
		throw new Error(
			`tool cgroup ${candidate}: real/effective ids differ (uid=${uid}/${euid} gid=${gid}/${egid}); ` +
				"ownership checks would not describe the identity that writes cgroup.procs",
		);
	}

	const mount = readCgroup2Mount();
	let canonical: string;
	try {
		canonical = realpathSync(candidate);
	} catch (error) {
		throw new Error(`tool cgroup ${candidate}: ${(error as NodeJS.ErrnoException).code ?? "cannot resolve"}`);
	}

	if (canonical !== mount.point && !canonical.startsWith(`${mount.point}${path.sep}`)) {
		throw new Error(`tool cgroup ${candidate}: not under the cgroup-v2 mount at ${mount.point}`);
	}

	// Filesystem identity, not the path spelling: an ordinary directory that
	// merely contains a file named `cgroup.procs` must not be accepted.
	if (statfsSync(canonical).type !== CGROUP2_SUPER_MAGIC) {
		throw new Error(`tool cgroup ${candidate}: not on a cgroup-v2 filesystem`);
	}

	const dir = statSync(canonical);
	if (!dir.isDirectory()) throw new Error(`tool cgroup ${candidate}: not a directory`);
	if (dir.dev !== statSync(mount.point).dev) {
		throw new Error(`tool cgroup ${candidate}: crosses a filesystem boundary below ${mount.point}`);
	}
	if (dir.uid !== euid || dir.gid !== egid) {
		throw new Error(`tool cgroup ${candidate}: owned by ${dir.uid}:${dir.gid}, expected ${euid}:${egid}`);
	}

	const procs = path.join(canonical, "cgroup.procs");
	let procsStat: Stats;
	try {
		procsStat = statSync(procs);
	} catch (error) {
		throw new Error(`tool cgroup ${candidate}: ${(error as NodeJS.ErrnoException).code ?? "missing"} for ${procs}`);
	}
	if (!procsStat.isFile() || procsStat.size !== 0) {
		throw new Error(`tool cgroup ${candidate}: ${procs} is not a cgroup.procs`);
	}
	if (procsStat.uid !== euid || procsStat.gid !== egid) {
		throw new Error(
			`tool cgroup ${candidate}: ${procs} owned by ${procsStat.uid}:${procsStat.gid}, expected ${euid}:${egid}`,
		);
	}
	try {
		accessSync(procs, constants.W_OK);
	} catch {
		throw new Error(`tool cgroup ${candidate}: ${procs} is not writable by ${euid}`);
	}

	let controllers: string;
	try {
		controllers = readFileSync(path.join(canonical, "cgroup.controllers"), "utf8");
	} catch {
		throw new Error(`tool cgroup ${candidate}: ${canonical} is not a cgroup directory`);
	}
	if (!controllers.split(/\s+/).includes("memory")) {
		throw new Error(
			`tool cgroup ${candidate}: no memory controller (controllers: ${controllers.trim() || "none"}); ` +
				"enable it in the parent's cgroup.subtree_control first",
		);
	}
	if (!statSync(path.join(canonical, "memory.max")).isFile()) {
		throw new Error(`tool cgroup ${candidate}: memory.max is unavailable, so no limit would apply`);
	}

	const subtree = readFileSync(path.join(canonical, "cgroup.subtree_control"), "utf8").trim();
	if (subtree !== "") {
		throw new Error(
			`tool cgroup ${candidate}: ${canonical} already delegates ${subtree}; place workloads in a leaf, not a parent`,
		);
	}

	try {
		accessSync(PLACEMENT_SHELL, constants.X_OK);
	} catch {
		throw new Error(`tool cgroup ${candidate}: ${PLACEMENT_SHELL} is missing or not executable`);
	}

	return canonical;
}

/** The unified-hierarchy mount, resolved from `/proc/self/mountinfo`. */
function readCgroup2Mount(): { point: string; root: string } {
	let mountinfo: string;
	try {
		mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
	} catch (error) {
		throw new Error(`tool cgroup: cannot read /proc/self/mountinfo: ${(error as Error).message}`);
	}

	for (const line of mountinfo.split("\n")) {
		const fields = line.split(" ");
		const separator = fields.indexOf("-");
		if (separator < 0 || fields[separator + 1] !== "cgroup2") continue;
		// Storage paths land in mount points, so the kernel's octal escapes are
		// load-bearing (a space arrives as \040).
		const decoded = fields.map(field =>
			field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))),
		);
		return { root: decoded[3], point: realpathSync(decoded[4]) };
	}
	throw new Error("tool cgroup: no cgroup-v2 mount in /proc/self/mountinfo; cgroup-v2 is required");
}

/**
 * The cgroup this process belongs to, as an absolute filesystem path.
 *
 * `undefined` when the current cgroup is not reachable through the visible
 * mount (a container with a narrowed mount root); callers then place the child
 * rather than assuming it already inherits membership.
 */
function currentCgroupPath(): string | undefined {
	const mount = readCgroup2Mount();
	let selfCgroup: string;
	try {
		selfCgroup = readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		return undefined;
	}

	const line = selfCgroup.split("\n").find(entry => entry.startsWith("0::"));
	if (!line) return undefined;
	const hierarchyPath = line.slice(3).trim();
	if (!hierarchyPath.startsWith(mount.root)) return undefined;

	const relative = hierarchyPath.slice(mount.root.length).replace(/^\/+/, "");
	return relative ? path.join(mount.point, relative) : mount.point;
}
