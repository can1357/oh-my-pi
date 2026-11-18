import { ghidraInstallStatus } from "../ghidra/install";
import { resolveGhidraRuntime } from "../ghidra/runtime";
import { resolveIdaRuntime } from "../ida/runtime";
import type { ToolSession } from "../tools";
import type { DisasmBackendId, WorkerRuntime } from "./backend";

/** Resolve a backend's worker interpreter and environment, provisioning Ghidra on first use. */
export function resolveWorkerRuntime(session: ToolSession, backend: DisasmBackendId): Promise<WorkerRuntime> {
	return backend === "ida" ? resolveIdaRuntime(session) : resolveGhidraRuntime(session);
}

/** Human-readable progress while this process is installing the selected backend. */
export function installStatus(backend: DisasmBackendId): string | undefined {
	return backend === "ghidra" ? ghidraInstallStatus() : undefined;
}
