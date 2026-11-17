import * as path from "node:path";
import { $which, getAgentDir } from "@oh-my-pi/pi-utils";
import { DisasmUnavailableError } from "../disasm/backend";
import { ensureManagedVenv } from "../eval/py/venv";

const READY_MARKER = ".omp-ready";
let status: string | undefined;

/** Current first-use provisioning phase for r2pipe. */
export function radare2InstallStatus(): string | undefined {
	return status;
}

/**
 * Whether a configured radare2 binary or one on PATH can serve the backend.
 * `configuredPath` is the radare2.r2Path value; omitting it checks PATH only.
 */
export function radare2Available(configuredPath?: string): boolean {
	return !!configuredPath?.trim() || $which("radare2") !== undefined;
}

/** Resolve the configured or PATH-discovered radare2 binary; undefined when absent. */
export function resolveRadare2Binary(configuredPath?: string): string | undefined {
	const configured = configuredPath?.trim();
	if (configured) return path.resolve(configured);
	return $which("radare2") ?? undefined;
}

/** Provision r2pipe in an omp-managed venv, locked across processes by the venv helper. */
export async function ensureR2PipeVenv(): Promise<string> {
	status = "installing r2pipe";
	try {
		return await ensureManagedVenv({
			dir: path.join(getAgentDir(), "r2pipe"),
			marker: READY_MARKER,
			key: "r2pipe\n1",
			python: { min: "3.10", below: "3.14" },
			install: ["r2pipe"],
			label: "r2pipe",
		});
	} catch (error) {
		if (error instanceof DisasmUnavailableError) throw error;
		throw new DisasmUnavailableError(
			`radare2 unavailable: r2pipe install failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		status = undefined;
	}
}
