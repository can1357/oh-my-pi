import { resolveBinjaRuntime } from "../binja/runtime";
import { ghidraInstallStatus } from "../ghidra/install";
import { resolveGhidraRuntime } from "../ghidra/runtime";
import { resolveIdaRuntime } from "../ida/runtime";
import { radare2InstallStatus } from "../radare2/install";
import { resolveRadare2Runtime } from "../radare2/runtime";
import type { ToolSession } from "../tools";
import type { DisasmBackendId, WorkerRuntime } from "./backend";

/** Resolve a backend's worker interpreter and environment, provisioning Ghidra on first use. */
export function resolveWorkerRuntime(session: ToolSession, backend: DisasmBackendId): Promise<WorkerRuntime> {
	switch (backend) {
		case "ida":
			return resolveIdaRuntime(session);
		case "ghidra":
			return resolveGhidraRuntime(session);
		case "binja":
			return resolveBinjaRuntime(session);
		case "radare2":
			return resolveRadare2Runtime(session);
	}
}

/** Human-readable progress while this process is installing the selected backend. */
export function installStatus(backend: DisasmBackendId): string | undefined {
	switch (backend) {
		case "ghidra":
			return ghidraInstallStatus();
		case "radare2":
			return radare2InstallStatus();
		case "ida":
		case "binja":
			// Discovered only; nothing is installed on demand.
			return undefined;
	}
}
