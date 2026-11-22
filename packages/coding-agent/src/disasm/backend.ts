import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import binjaWorker from "../binja/worker.py" with { type: "text" };
import ghidraWorker from "../ghidra/worker.py" with { type: "text" };
import idaWorker from "../ida/worker.py" with { type: "text" };

/** Every backend id; handle hosts, unit params and eval arguments validate against this list. */
export const DISASM_BACKEND_IDS = ["ida", "ghidra", "binja"] as const;

/** Backend identity used by settings, host daemons, and executable views. */
export type DisasmBackendId = (typeof DISASM_BACKEND_IDS)[number];

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
	/**
	 * Extension of the file the backend's own application unpacks beside a database while it has
	 * it open; an in-place open is refused while that file exists.
	 */
	unpackedExt?: string;
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
		unpackedExt: ".id0",
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
	binja: {
		id: "binja",
		label: "Binary Ninja",
		storeDir: "bndbs",
		databaseExt: ".bndb",
		databaseName: name => `${name}.bndb`,
		isDatabasePath: p => path.extname(p).toLowerCase() === ".bndb",
		workerScript: binjaWorker,
		workerStageDir: "omp-binja-worker",
		interrupt: "signal",
		projectAlias: false,
	},
};

/** Backend whose database format `p` names, whichever backend is active; undefined for anything else. */
export function databaseOwner(p: string): DisasmBackend | undefined {
	return DISASM_BACKEND_IDS.map(id => DISASM_BACKENDS[id]).find(backend => backend.isDatabasePath(p));
}
