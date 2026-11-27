import type { ProcSpec, UnitSnapshot } from "../../../daemon/daemon-types";
import { type PsBoard, type PsTarget } from "../../../cli/ps-model";

/** Unit detail shown by the info view. */
export interface PsUnitInfo {
	unit: UnitSnapshot;
	proc?: ProcSpec;
}

/** Unit log window shown by the logs view. */
export interface PsUnitLogs {
	text: string;
	/** PTY output replayed into terminal rows; empty for non-PTY units. */
	terminalOutput: string;
	state: string;
}

/** Daemon capabilities supplied by the process command. */
export interface PsTopHost {
	/** The board for the selection; never starts the daemon. */
	collectBoard(all: boolean, target: PsTarget): Promise<PsBoard>;
	/** Calls `onChange` on every unit transition while a daemon answers; returns the unsubscribe. */
	watch(onChange: () => void): () => void;
	act(unit: UnitSnapshot, verb: "stop" | "kill" | "restart"): Promise<UnitSnapshot>;
	describe(unit: UnitSnapshot): Promise<PsUnitInfo>;
	logs(unit: UnitSnapshot, lines: number): Promise<PsUnitLogs>;
	close(): void;
}
