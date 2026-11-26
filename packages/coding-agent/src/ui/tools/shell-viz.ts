/**
 * Shell visualization presentations: the native shell engine's semantic
 * reading of a command (rows of segments, pseudo view by default), shared
 * by Tern's `shell` node and the terminal look.
 *
 * The engine parses and presents; this module asks it for a presentation of
 * a command (untraced, or with the run's trace: what runs now, loop
 * iterations, the values it bound) and threads the run's output in.
 */
import { RunTrace } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { ShellTrace, ShellVizPreferences, ShellVizPresentation } from "@oh-my-pi/pi-wire";
import {
	defaultShellVizPreferences,
	readShellPresentation,
	type ShellVisualizationSource,
	shellVisualization,
} from "../../tools/shell-viz";

interface PresentOptions {
	/** The command's args are still arriving: its unfinished end draws as it will continue. */
	readonly streaming?: boolean;
	/** The result text, replacing the engine's own capture. */
	readonly output?: string;
	readonly preferences?: ShellVizPreferences;
}

function present(
	source: () => ShellVisualizationSource | undefined,
	snapshot: ShellTrace | undefined,
	options: PresentOptions,
): ShellVizPresentation | undefined {
	try {
		const visualization = source();
		if (!visualization) return undefined;
		const preferences = options.preferences ?? defaultShellVizPreferences();
		return readShellPresentation(visualization, preferences, snapshot, options.output, options.streaming);
	} catch (error) {
		logger.warn("Shell visualization unavailable; showing the plain command", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** The engine's presentation of `script` before it has a trace. Undefined when the engine refuses it. */
export function presentShellScript(script: string, options: PresentOptions): ShellVizPresentation | undefined {
	return present(() => new RunTrace(script), undefined, options);
}

/**
 * The engine's presentation of a traced run: the live run a snapshot is bound
 * to, else the restored snapshot. Undefined when the engine rejects the
 * snapshot; the card then shows the plain command, as with visualization off.
 */
export function presentShellTrace(trace: ShellTrace, options: PresentOptions): ShellVizPresentation | undefined {
	return present(() => shellVisualization(trace), trace, options);
}
