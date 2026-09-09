import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Regression: `setTransports({ file: false, console: false })` left the shared
 * winston singleton with zero transports but not marked `silent`, so the next
 * emit hit winston's internal guard and `console.error`'d
 * "[winston] Attempt to write logs with no transports, which can increase
 * memory usage: …". Because the logger is a process-wide singleton, a single
 * test file that disabled transports poisoned every later file's log emits with
 * that warning. Disabling all transports must instead be a clean no-op.
 */

let tempDir: string;
let prevAgentDir: string | undefined;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-logger-no-transports-"));
	prevAgentDir = process.env.OMP_AGENT_DIR;
	process.env.OMP_AGENT_DIR = tempDir;
});

afterAll(() => {
	if (prevAgentDir === undefined) {
		delete process.env.OMP_AGENT_DIR;
	} else {
		process.env.OMP_AGENT_DIR = prevAgentDir;
	}
	// Detach the file transport before deleting tempDir so no live handle points
	// at a removed dir. With the silent fix this is a harmless no-op, not a leak.
	logger.setTransports({ file: false, console: false });
	fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("logger with no transports", () => {
	it("does not warn on emit when every transport is disabled", () => {
		// Ensure the singleton exists, then drop all transports at runtime.
		logger.setTransports({ file: tempDir, console: false });
		logger.info("no-transports-warmup");
		logger.setTransports({ file: false, console: false });

		const errorSpy = spyOn(console, "error");
		try {
			logger.warn("OAuth token refresh failed", {
				provider: "unit-oauth-select",
				index: 1,
				error: "Error: invalid_grant",
				isDefinitiveFailure: true,
			});
		} finally {
			errorSpy.mockRestore();
		}

		const noTransportWarnings = errorSpy.mock.calls.filter(args =>
			args.some(a => typeof a === "string" && a.includes("Attempt to write logs with no transports")),
		);
		expect(noTransportWarnings).toEqual([]);
	});

	it("resumes writing once a transport is re-enabled", async () => {
		logger.setTransports({ file: false, console: false });
		// Re-attaching a transport must clear the silent flag set above.
		logger.setTransports({ file: tempDir, console: false });
		logger.warn("no-transports-resume-fixture");

		let found = false;
		for (let i = 0; i < 40 && !found; i++) {
			for (const f of fs.readdirSync(tempDir).filter(n => n.startsWith("omp.") && n.endsWith(".log"))) {
				if (fs.readFileSync(path.join(tempDir, f), "utf8").includes("no-transports-resume-fixture")) {
					found = true;
					break;
				}
			}
			if (!found) await Bun.sleep(25);
		}
		expect(found).toBe(true);
	});
});
