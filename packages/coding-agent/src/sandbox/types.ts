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
