import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import ghidraWorker from "../ghidra/worker.py" with { type: "text" };
import idaWorker from "../ida/worker.py" with { type: "text" };

/** Backend identity used by settings, host daemons, and executable views. */
export type DisasmBackendId = "ida" | "ghidra";

/** Interpreter and environment used to spawn a backend's Python worker. */
export interface WorkerRuntime {
	pythonPath: string;
	env: Record<string, string>;
}

/** The selected backend cannot run because its installation or interpreter is unavailable. */
export class DisasmUnavailableError extends ToolError {
	override name = "DisasmUnavailableError";
}

/** Static backend contract shared by the client, host, store, and supervisor. */
export interface DisasmBackend {
	id: DisasmBackendId;
	label: string;
	storeDir: string;
	databaseExt: string;
	databaseName(stagedName: string): string;
	isDatabasePath(p: string): boolean;
	workerScript: string;
	workerStageDir: string;
	interrupt: "signal" | "frame";
	/** Ghidra rejects hidden path elements; use a temporary symlink/junction to its store directory. */
	projectAlias: boolean;
}

/** Backend-specific paths, worker sources, and interruption mechanisms; no settings dependencies. */
export const DISASM_BACKENDS: Record<DisasmBackendId, DisasmBackend> = {
	ida: {
		id: "ida",
		label: "IDA",
		storeDir: "idbs",
		databaseExt: ".i64",
		databaseName: name => `${name}.i64`,
		isDatabasePath: p => {
			const ext = path.extname(p).toLowerCase();
			return ext === ".i64" || ext === ".idb";
		},
		workerScript: idaWorker,
		workerStageDir: "omp-ida-worker",
		interrupt: "signal",
		projectAlias: false,
	},
	ghidra: {
		id: "ghidra",
		label: "Ghidra",
		storeDir: "ghidra-projects",
		databaseExt: ".gpr",
		databaseName: () => "omp.gpr",
		isDatabasePath: () => false,
		workerScript: ghidraWorker,
		workerStageDir: "omp-ghidra-worker",
		interrupt: "frame",
		projectAlias: true,
	},
};
