/**
 * Boot-graph child for the telemetry lazy-boundary test.
 *
 * The recorder (`--preload boot-module-load-recorder.ts`) only observes module
 * loads, so the child has to drive the real launch itself: importing
 * `main.ts` without calling anything evaluates the module graph but never runs
 * the launch path, which made the "the OTLP exporter is not in the boot graph"
 * assertion vacuous.
 *
 * This child calls the exported entry point (`runRootCommand`) with print-mode
 * arguments, so the launch runs far enough to reach the telemetry
 * initialization inside `runRootCommand`, and then stops before the agent
 * session exists:
 *
 * - `createAgentSession` is stubbed, so no model call, no network, and no
 *   interactive TTY are involved.
 * - The session-creation boundary sits AFTER the telemetry initialization in
 *   `runRootCommand`, so the recorded graph is the graph a real launch builds
 *   up to that point.
 * - The stop is a thrown sentinel: an unexpected failure exits non-zero so the
 *   test notices instead of reading a truncated report.
 */
import { parseArgs } from "../../src/cli/args";
import { runRootCommand } from "../../src/main";
import { writeBootModuleReport } from "./boot-module-load-recorder";

/** Marker for the intentional stop at the session-creation boundary. */
const STOP_SENTINEL = "telemetry-boot-graph-child-stop";

const ARGS = ["--print", "boot-graph-probe", "--no-session"];

async function main(): Promise<void> {
	try {
		await runRootCommand(parseArgs(ARGS), ARGS, {
			createAgentSession: () => {
				throw new Error(STOP_SENTINEL);
			},
		});
	} catch (error) {
		if (error instanceof Error && error.message === STOP_SENTINEL) {
			// Expected stop: report the graph and leave with a clean exit code.
			writeBootModuleReport();
			process.exit(0);
		}
		process.stderr.write(
			`boot-graph child failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		writeBootModuleReport();
		process.exit(1);
	}
	// The launch must have reached the session-creation boundary; returning
	// without the sentinel means the stop point moved and the graph the test
	// reads no longer covers the telemetry initialization.
	process.stderr.write("boot-graph child finished without reaching the session-creation stop point\n");
	writeBootModuleReport();
	process.exit(1);
}

await main();
