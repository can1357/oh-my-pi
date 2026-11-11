/**
 * How a layer was established. `measured`: from kernel or root-owned state that reports a confinement mechanism
 * in force, not what it permits. `declared`: from a marker any process of the same user could create (an env
 * var, a file).
 */
export type SandboxBasis = "measured" | "declared";

/** What a layer says about outbound network access. */
export type SandboxNetworkAccess = "blocked" | "filtered" | "open";

export interface SandboxNetwork {
	access: SandboxNetworkAccess;
	/** A few words for `/sandbox`, e.g. "through the nono proxy". */
	summary?: string;
}

/** Whether writes to a path succeed. `read-only` means writes are refused; reads may be refused too. */
export type SandboxWriteAccess = "writable" | "read-only" | "unknown";

/** Write access to the two places an agent writes most: the working directory and the home directory. */
export interface SandboxFileAccess {
	cwd: SandboxWriteAccess;
	home: SandboxWriteAccess;
}

/** A file or directory that holds a sandbox's policy, shown in the `/sandbox` policy-files tree. */
export interface SandboxPolicyFile {
	label: string;
	path: string;
	/** List the entries of this directory under it. */
	directory?: boolean;
}

/**
 * A fact a probe wants shown in `/sandbox` that core has no type for: a label/value row, a titled markdown
 * section, or a titled list of policy files. Core renders rows and markdown as they are and never interprets
 * them; it looks each policy file up on disk when the report is built and draws the list as a tree.
 */
export type SandboxDetail =
	| { label: string; value: string }
	| { title: string; markdown: string }
	| { title: string; files: SandboxPolicyFile[] };

/** One sandbox the process runs in, as a probe (or the generic `confined` layer) reports it. */
export interface SandboxLayer {
	/** Short stable id: `nono`, `docker`, `confined`, or a probe's own id. */
	id: string;
	/** Profile or role inside the sandbox, when the sandbox names one. */
	role?: string;
	basis: SandboxBasis;
	/** Short phrases for what the layer enforces beyond files and network, e.g. `blocked commands: rm`. */
	restrictions: string[];
	/** Write access to the working directory and home, when the layer knows it. */
	files?: SandboxFileAccess;
	network?: SandboxNetwork;
	details?: SandboxDetail[];
	/** What the probe read to decide, for `/sandbox`. */
	evidence: string[];
}

/** All observed namespace links; only six have fixed kernel init inodes. */
export type SandboxNamespaceName = "mnt" | "net" | "user" | "pid" | "uts" | "ipc" | "cgroup" | "time";

export type SandboxNamespaceState = "initial" | "non-initial" | "unknown";

export type SandboxSeccompMode = "disabled" | "strict" | "filter";

/** Validated hexadecimal masks, kept opaque rather than decoded into access claims. */
export interface SandboxCapabilities {
	inheritable?: string;
	permitted?: string;
	effective?: string;
	bounding?: string;
	ambient?: string;
}

export interface SandboxIdMapEntry {
	inside: number;
	outside: number;
	length: number;
}

/** Kernel ABI availability only: never proof this process has a Landlock domain. */
export interface SandboxLandlock {
	state: "supported" | "unsupported" | "blocked" | "disabled" | "unknown";
	abi?: number;
}

/**
 * Kernel facts about this process, the ones the `confined` layer and `/sandbox` read. Each is read, never
 * inferred: an absent field (or `unknown`) means it could not be read on this platform or kernel, not that the
 * restriction is off.
 */
export interface SandboxFacts {
	/** `NoNewPrivs` from /proc/self/status. */
	noNewPrivs?: boolean;
	/** `Seccomp` from /proc/self/status. */
	seccomp?: SandboxSeccompMode;
	/** Fixed init comparison for six namespaces; mnt/net stay unknown: nothing readable here says what the host's are. */
	namespaces: Record<SandboxNamespaceName, SandboxNamespaceState>;
	seccompFilters?: number;
	capabilities?: SandboxCapabilities;
	namespaceInodes?: Partial<Record<SandboxNamespaceName, string>>;
	namespaceIdMaps?: { uid?: SandboxIdMapEntry[]; gid?: SandboxIdMapEntry[] };
	lsm?: string[];
	lsmLabel?: string;
	cgroup?: string;
	yamaPtraceScope?: number;
	/** Present only in the status `inspectSandbox()` returns: the query needs a child process. */
	landlock?: SandboxLandlock;
	/**
	 * Listing `/` when `/` is root-owned, world-readable and on a local filesystem. `refused`: a Linux security
	 * module (Landlock, AppArmor, SELinux) refuses that, and so does an ACL entry on `/` that names the user, which
	 * the mode bits do not show. `allowed` proves nothing either way.
	 */
	rootListing: "refused" | "allowed" | "unknown";
	/** macOS: `sandbox_check(getpid(), NULL, 0)` reports a Seatbelt profile. */
	seatbelt?: boolean;
}

export interface SandboxStatus {
	platform: NodeJS.Platform;
	/** Outermost first; empty when no sandbox was found. */
	layers: SandboxLayer[];
	facts: SandboxFacts;
	/** One line per probe and per synthesized layer, in order. */
	evidence: string[];
}

/** `/` as the root-listing fact sees it. */
export interface SandboxRootListing {
	uid: number;
	mode: number;
	listing: "ok" | "EACCES" | "EPERM" | "other";
}

/**
 * Everything detection reads, so tests can point it at a fake /proc tree. Synchronous on purpose: detection reads
 * a handful of small /proc and marker files once per process, and sync reads keep probes plain functions.
 */
export interface SandboxHost {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	/** The working directory, for probes that report {@link SandboxFileAccess}. */
	cwd: string;
	/** File text, or `undefined` when it cannot be read. */
	readFile(path: string): string | undefined;
	/** Symlink target, or `undefined` when it cannot be read. */
	readLink(path: string): string | undefined;
	exists(path: string): boolean;
	/** Stat and list `/`; `undefined` when `/` cannot be stat'd. */
	rootListing(): SandboxRootListing | undefined;
	/** `sandbox_check(getpid(), NULL, 0)`; `undefined` off macOS or when it cannot be called. */
	sandboxCheck(): number | undefined;
	/**
	 * The kernel's Landlock ABI, asked from a child process. Only `inspectSandbox()` calls it. It cannot establish
	 * current-process Landlock enforcement.
	 */
	landlockAbi?(): SandboxLandlock | Promise<SandboxLandlock>;
}

/**
 * Recognizes one named sandbox. Probes run once per detection, in registration order after the built-ins.
 * `detect` may be async; a probe still pending when the detector's timeout fires is dropped, so a probe that wants
 * a fallback layer must bound its own async work.
 */
export interface SandboxProbe {
	id: string;
	detect(host: SandboxHost, signal: AbortSignal): SandboxLayer | undefined | Promise<SandboxLayer | undefined>;
	/** Details that take a process or a service to get; called only when `/sandbox` is opened. */
	report?(layer: SandboxLayer, host: SandboxHost, signal: AbortSignal): SandboxDetail[] | Promise<SandboxDetail[]>;
}
