import type { SandboxSubject } from "@oh-my-pi/pi-agent-core";

export type SandboxMode = "workspace-write" | "read-only";
export type SandboxNetworkMode = "allowlist" | "deny" | "allow";
export type SandboxScope = "bash" | "eval" | "exec";
export type SandboxReadScope = "all" | "workspace";

/** Effective configuration after the project-may-only-tighten rule. */
export interface SandboxConfig {
	enabled: boolean;
	mode: SandboxMode;
	scope: readonly SandboxScope[];
	fallback: "warn" | "block";
	readScope: SandboxReadScope;
	allowWrite: readonly string[];
	allowRead: readonly string[];
	denyRead: readonly string[];
	networkMode: SandboxNetworkMode;
	allowedHosts: readonly string[];
	/** Windows: drive roots of the policy paths are enumerable (whole-volume listing and metadata). */
	listDrives: boolean;
	/** Windows: contained commands may connect to loopback in `allowlist` and `deny` modes. */
	loopback: boolean;
	/** Project-layer values that were dropped because they would loosen the sandbox. */
	ignored: readonly { id: string; reason: string }[];
}

export interface SandboxResultMeta {
	backend: string;
	mode: SandboxMode;
	network: SandboxNetworkMode;
	/** Hosts the egress proxy refused during this call. */
	blockedHosts?: string[];
	/** The output looks like a filesystem denial by the sandbox. */
	denied?: boolean;
	/**
	 * Windows: a program exited with STATUS_DLL_INIT_FAILED (0xC0000142), how a program the sandbox
	 * cannot host fails to start.
	 */
	startFailed?: boolean;
}

/** The subset of Bun's Subprocess the spawn sites use. */
export interface SandboxChild {
	readonly pid: number;
	readonly stdin: { write(data: string | Uint8Array): void; flush(): void; end(): void };
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	kill(): void;
}

export type HostApproval = "once" | "session" | "always" | "deny";

export type SandboxHostApprover = (host: string, port: number) => Promise<HostApproval>;

/** `exec`: an action omp performs on the host that the sandbox cannot contain; granted per session only. */
export type SandboxAccessKind = SandboxSubject["kind"];

/** Access kinds backed by a list setting, which an `always` answer appends to. */
export type SandboxListKind = Exclude<SandboxAccessKind, "exec">;

export interface SandboxAccessInput {
	kind: SandboxAccessKind;
	target: string;
	/** What the agent is trying to do and why it needs this target: one or two plain sentences, written for the user. */
	intent: string;
	/** The command that needs the access (failed or about to run), verbatim. */
	command?: string;
	/** What the agent will do instead if the request is denied. */
	alternative?: string;
	/** Base for a relative path target; default: the workspace. */
	cwd?: string;
}

/**
 * What the approver is shown. `target` is already resolved (absolute realpath-or-self path, canonical
 * host, or trimmed exec target).
 */
export interface SandboxAccessRequest extends Omit<SandboxAccessInput, "cwd"> {
	workspace: string;
	/** False when the backing list setting is locked (env/override/project), and always for `exec`: no "always" option. */
	canAlways: boolean;
	/** The consequence of a grant, written by omp (never the agent's text). */
	effect: string;
}

export type SandboxAccessAnswer =
	| { decision: "session" | "always" | "deny" }
	/** The user answered with instructions instead of a decision: nothing is granted. */
	| { decision: "instruct"; instructions: string };

export type SandboxAccessApprover = (
	request: SandboxAccessRequest,
	signal?: AbortSignal,
) => Promise<SandboxAccessAnswer>;

/**
 * Who answers access requests in this process: the TUI (`interactive`), or the RPC client (`rpc`,
 * declared at boot in rpc modes). Without one, `sandbox_request` is not offered. In `rpc` the tool is
 * offered before the client opts in with `set_sandbox_access_prompts`; until then a request is refused.
 */
export type SandboxAccessPromptHost = "interactive" | "rpc";

export type SandboxAccessOutcome =
	| { status: "granted"; scope: "session" | "always"; target: string }
	| { status: "already-allowed"; target: string }
	| { status: "denied"; target: string }
	| { status: "instructed"; target: string; instructions: string }
	/** Never shown to the user: invalid target, protected path, sandbox off/unavailable, read-only mode for a write, or nobody to ask. */
	| { status: "refused"; reason: string };

/**
 * Decides `input` (its `target` already resolved to absolute form) in the main realm, for the
 * runtime of `workspace` there. @internal
 */
export type SandboxAccessForwarder = (
	workspace: string,
	input: SandboxAccessInput,
	signal?: AbortSignal,
) => Promise<SandboxAccessOutcome>;
