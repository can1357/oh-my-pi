import * as fs from "node:fs";
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

function isExecutableFile(p: string): boolean {
	try {
		if (!fs.statSync(p).isFile()) return false;
		if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Whether a configured binary or one on PATH can serve the backend. */
export function radare2Available(configuredPath?: string): boolean {
	const configured = configuredPath?.trim();
	return configured ? isExecutableFile(path.resolve(configured)) : $which("radare2") !== undefined;
}

/** Resolve a validated configured or PATH-discovered radare2 binary; undefined when absent. */
export function resolveRadare2Binary(configuredPath?: string): string | undefined {
	const configured = configuredPath?.trim();
	if (configured) {
		const resolved = path.resolve(configured);
		return isExecutableFile(resolved) ? resolved : undefined;
	}
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
