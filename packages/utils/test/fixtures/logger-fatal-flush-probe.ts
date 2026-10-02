/**
 * Leaves buffered records in the batching file transport, then ends the
 * process through a postmortem exit path that bypasses a normal shutdown:
 * - `uncaught`: dies from an uncaught exception (fatal handler, exit code 1).
 * - `exit-process`: hard-exits through `exitProcess(3)`, as the signal
 *   handlers do, which skips the `exit` event.
 * Arguments mirror logger-contract-probe.ts.
 */
import * as logger from "../../src/logger";
import { exitProcess } from "../../src/postmortem";

const scenario = process.argv[2];
const primaryDir = process.argv[3];
if (!primaryDir) throw new Error("expected primary directory");

logger.setTransports({ console: false, file: primaryDir });
switch (scenario) {
	case "uncaught":
		logger.info("before-crash-info");
		logger.debug("before-crash-debug");
		setTimeout(() => {
			throw new Error("fixture crash");
		}, 0);
		break;
	case "exit-process":
		logger.info("before-exit-info");
		logger.debug("before-exit-debug");
		exitProcess(3);
		break;
	default:
		throw new Error(`unknown scenario: ${scenario}`);
}
