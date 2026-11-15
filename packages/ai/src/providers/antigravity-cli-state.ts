/**
 * Process-wide Antigravity CLI transport settings and subagent worker bridge.
 *
 * Kept free of runtime provider imports so settings registration and worker
 * bootstrap can configure defaults without loading the ACP transport eagerly.
 */
import { $flag } from "@oh-my-pi/pi-utils";
import type { SessionNotification } from "@oh-my-pi/pi-utils/acp";
import type { AgyConnection } from "./antigravity-cli/host";
import type { McpCallHandler, McpToolDefinition } from "./antigravity-cli/mcp-bridge";

/** Parameters required to acquire one shared ACP session lease. */
export interface SharedAgyBridgeRequest {
	geminiDir: string;
	credentialVersion?: string;
	tools: readonly McpToolDefinition[];
	signal: AbortSignal;
	onCall: McpCallHandler;
	onUpdate: (notification: SessionNotification) => void;
}

/** One active session lease backed by a shared `agy acp` subprocess. */
export interface SharedAgyBridgeLease {
	connection: AgyConnection;
	exited: Promise<number>;
	close(): void;
}

/** Optional cross-thread bridge installed inside subagent worker realms. */
export type SharedAgyWorkerBridge = (options: SharedAgyBridgeRequest) => Promise<SharedAgyBridgeLease>;

let configuredShareProcess = true;
let configuredIsolateWorkspace = true;
let workerBridge: SharedAgyWorkerBridge | undefined;

/**
 * Set the process-wide default for sharing `agy acp` processes across compatible sessions.
 * Covers direct `streamSimple`/`completeSimple` callers without session settings.
 */
export function configureAntigravityCliShareProcess(enabled: boolean | undefined): void {
	configuredShareProcess = enabled ?? true;
}

/**
 * Set the process-wide default for passing an empty workspace directory to `agy`.
 * Covers direct `streamSimple`/`completeSimple` callers without session settings.
 */
export function configureAntigravityCliIsolateWorkspace(enabled: boolean | undefined): void {
	configuredIsolateWorkspace = enabled ?? true;
}

/** Effective process-sharing mode: explicit request option, then `PI_AGY_SHARE_PROCESS`, then host default (`true`). */
export function resolveAntigravityCliShareProcess(option?: boolean): boolean {
	return option ?? $flag("PI_AGY_SHARE_PROCESS", configuredShareProcess);
}

/** Effective workspace-isolation mode: explicit request option, then `PI_AGY_ISOLATE_WORKSPACE`, then host default (`true`). */
export function resolveAntigravityCliIsolateWorkspace(option?: boolean): boolean {
	return option ?? $flag("PI_AGY_ISOLATE_WORKSPACE", configuredIsolateWorkspace);
}

/** Register or clear the worker-thread bridge that routes shared leases to the main thread. */
export function setSharedAgyWorkerBridge(bridge: SharedAgyWorkerBridge | undefined): void {
	workerBridge = bridge;
}

/** Active worker-thread bridge, if running inside a bridged subagent worker. */
export function getSharedAgyWorkerBridge(): SharedAgyWorkerBridge | undefined {
	return workerBridge;
}
