/**
 * Shared contracts for the Harbor-free Terminal-Bench 2.x runner.
 *
 * Each task's published OCI image runs as a hardware-isolated Vibemon microVM;
 * omp runs inside that guest over raw RPC stdio carried by the Vibemon SDK's
 * streaming exec transport.
 *
 * Module map:
 * - `dataset.ts` — task acquisition + `task.toml` parsing → {@link TbTask}
 * - `vmon.ts` — Vibemon SDK lifecycle and raw exec transport
 * - `agent.ts` — omp Linux binary build + guest install
 * - `trial.ts` — one trial: agent run → verifier → {@link TrialResult}
 * - `store.ts` — SQLite trial/epoch persistence
 * - `cli.ts` — scheduler, continuous epochs, report
 */

/** One parsed Terminal-Bench task (from `tasks/<name>/task.toml` + `instruction.md`). */
export interface TbTask {
	/** Task directory basename, e.g. `"adaptive-rejection-sampler"`. */
	name: string;
	/** Absolute path to the task directory (contains `tests/`, `environment/`). */
	dir: string;
	/** Full `instruction.md` text, sent verbatim as the agent prompt. */
	instruction: string;
	/** Published OCI image reference from `[environment].docker_image`. */
	image: string;
	/** CPU limit from `[environment].cpus` (0 = unlimited). */
	cpus: number;
	/** Memory limit in MiB from `[environment].memory_mb` (0 = unlimited). */
	memoryMb: number;
	/** Root disk size in MiB from `[environment].storage_mb`. */
	storageMb: number;
	/** Agent wall-clock budget from `[agent].timeout_sec`. */
	agentTimeoutSec: number;
	/** Verifier wall-clock budget from `[verifier].timeout_sec`. */
	verifierTimeoutSec: number;
	/** Extra env for the task microVM from `[environment.env]`. */
	environmentEnv: Record<string, string>;
	/** Extra env for the verifier exec from `[verifier.env]`. */
	verifierEnv: Record<string, string>;
	/** `[metadata].difficulty` (empty string when absent). */
	difficulty: string;
	/** `[metadata].category` (empty string when absent). */
	category: string;
}

/** Guest CPU architecture, normalized to omp binary naming. */
export type GuestArch = "x64" | "arm64";

/** Remote vmond connection and guest architecture configuration. */
export interface VmonConfig {
	/** vmond gateway URL. */
	url: string;
	/** Bearer token; empty for an unauthenticated local daemon. */
	token: string;
	/** Architecture of guests created on this host. */
	arch: GuestArch;
}

/** Token/cost accounting for one trial's agent run. */
export interface TrialUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	/** Assistant turns taken. */
	turns: number;
}

/** Terminal outcome of a trial. `error` = harness/infra failure, not a task failure. */
export type TrialStatus = "pass" | "fail" | "error";

/** Result of one (task, model) trial. */
export interface TrialResult {
	status: TrialStatus;
	/** Parsed `/logs/verifier/reward.txt` (0..1); null when the verifier produced none. */
	reward: number | null;
	/** Agent hit `[agent].timeout_sec` and was aborted (verifier still ran). */
	agentTimedOut: boolean;
	usage: TrialUsage;
	/** Last assistant message text (may be empty). */
	finalMessage: string;
	agentMs: number;
	verifierMs: number;
	wallMs: number;
	/** Failure detail when status is `"error"`. */
	error?: string;
}

/** OpenRouter request-routing suffix applied by omp. */
export type OpenRouterVariant = "default" | "nitro" | "floor" | "online" | "exacto";

/** Host auth-gateway routing written into each guest's models.yml. */
export interface GatewayConfig {
	/** Local gateway URL; each trial rewrites it to its guest-visible tunnel endpoint. */
	url: string;
	/** Gateway bearer (`omp auth-gateway token`); `"no-auth"` when the gateway runs open. */
	token: string;
	/** Provider ids routed through the gateway (derived from the model pool). */
	providers: string[];
	/** OpenRouter vendor-routing policy; benchmarks default to cheapest-provider `floor`. */
	openrouterVariant: OpenRouterVariant;
}

/** Host paths of self-contained omp Linux binaries, keyed by guest architecture. */
export interface AgentBinaries {
	x64?: string;
	arm64?: string;
	/** omp package version the binaries were built from (for run provenance). */
	version: string;
}

/** One row persisted per trial. */
export interface TrialRow {
	epoch: number;
	/** Full `provider/model` string. */
	model: string;
	task: string;
	attempt: number;
	status: TrialStatus;
	reward: number | null;
	agentTimedOut: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	turns: number;
	agentMs: number;
	verifierMs: number;
	wallMs: number;
	error: string | null;
	/** Trial artifact directory (transcript, verifier logs), relative to the jobs dir. */
	trialDir: string;
	startedAt: number;
	finishedAt: number;
}
