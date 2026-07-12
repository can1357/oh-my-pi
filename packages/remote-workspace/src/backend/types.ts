/**
 * ExecutionBackend abstraction — keeps execution placement independent of the agent.
 *
 * Each backend implementation handles exactly one placement strategy (MSI Docker,
 * Hetzner SSH, Codespaces, etc.). The orchestrator selects the backend based on
 * capability, policy, and health — never silently falling back to an incompatible one.
 */

export interface BackendCapabilities {
	readonly interactiveShell: boolean;
	readonly browserIDE: boolean;
	readonly persistentVolume: boolean;
	readonly fullPauseResume: boolean;
	readonly docker: boolean;
	readonly nestedVirtualization: boolean;
	readonly gpu: boolean;
	readonly longRunning: boolean;
	readonly publicPreviewPorts: boolean;
	readonly privateNetworking: boolean;
	readonly windows: boolean;
	readonly linux: boolean;
	readonly arm64: boolean;
	readonly maxWorkspaceBytes?: number;
}

export type BackendHealthStatus = "ready" | "degraded" | "unavailable";

export interface BackendReadiness {
	readonly backendId: string;
	readonly status: BackendHealthStatus;
	readonly checkedAt: string;
	readonly issues: readonly string[];
	readonly capabilities: BackendCapabilities;
}

export interface BackendEstimate {
	readonly backendId: string;
	readonly estimatedStartMs: number;
	readonly estimatedCostUsd?: number;
	readonly notes?: string;
}

export interface WorkspaceLaunchSpec {
	readonly jobId: string;
	readonly image: string;
	readonly repoUrl: string;
	readonly ref: string;
	readonly taskPrompt: string;
	readonly validationCommands: readonly string[];
	readonly timeoutMs: number;
	readonly labels: Readonly<Record<string, string>>;
	readonly env?: Readonly<Record<string, string>>;
	readonly networkEgress?: "none" | "restricted" | "full";
}

export interface RuntimeHandle {
	readonly backendId: string;
	readonly jobId: string;
	readonly workerId: string;
	readonly startedAt: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export type RuntimeStatus = "starting" | "running" | "validating" | "completing" | "stopped" | "failed" | "unknown";

export interface RuntimeStatusResult {
	readonly status: RuntimeStatus;
	readonly exitCode?: number;
	readonly checkedAt: string;
}

export interface ConnectionInfo {
	readonly url?: string;
	readonly sshCommand?: string;
	readonly notes?: string;
}

export interface RestoreResult {
	readonly ok: boolean;
	readonly contentDigest?: string;
	readonly notes?: string;
}

export interface VerificationResult {
	readonly ok: boolean;
	readonly contentDigestMatch: boolean;
	readonly gitStateMatch: boolean;
	readonly notes?: string;
}

export interface ExecutionControl {
	readonly signal?: AbortSignal;
}

export interface WorkspaceArtifacts {
	readonly logs: string;
	readonly patch?: string;
	/** Process-level exit code, used as a fallback when no phase code is available. */
	readonly exitCode: number;
	/** Exit code from the agent phase, when the backend can distinguish it. */
	readonly agentExitCode?: number;
	/** Exit code from validation, when the backend can distinguish it. */
	readonly validationExitCode?: number;
	readonly changedFiles: readonly string[];
	readonly tokenCount?: number;
	readonly durationMs: number;
}

/**
 * Core interface every execution backend must implement.
 * The orchestrator depends only on this interface — never on a concrete backend class.
 */
export interface ExecutionBackend {
	readonly id: string;
	readonly capabilities: BackendCapabilities;

	probe(): Promise<BackendReadiness>;
	estimate(spec: WorkspaceLaunchSpec): Promise<BackendEstimate>;
	launch(spec: WorkspaceLaunchSpec): Promise<RuntimeHandle>;
	collectArtifacts(runtime: RuntimeHandle, control?: ExecutionControl): Promise<WorkspaceArtifacts>;
	status(runtime: RuntimeHandle): Promise<RuntimeStatusResult>;
	connect(runtime: RuntimeHandle): Promise<ConnectionInfo>;
	terminate(runtime: RuntimeHandle): Promise<void>;
	cleanup(runtime: RuntimeHandle): Promise<CleanupResult>;
}

export interface CleanupResult {
	readonly containerGone: boolean;
	readonly volumeGone: boolean;
	readonly networkGone: boolean;
	readonly workspaceDirGone: boolean;
	readonly credentialRevoked: boolean;
	readonly errors: readonly string[];
}
