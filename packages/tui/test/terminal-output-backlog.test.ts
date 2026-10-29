/**
 * `ProcessTerminal.pendingOutputBytes` over the live `TtyWriter`.
 *
 * The count an enqueue leaves behind goes stale the moment the pump thread
 * drains it, and after the last frame nothing writes again to refresh it. A
 * caller that waits for the terminal to have the frame —
 * `TUI.renderNowAccepted`, which `/pause` uses before opening the agent gate —
 * must see the backlog reach zero. The pump exists only on a unix TTY and is
 * skipped under `bun test`, so the probe runs in a child under a real pty.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";

const PROBE = path.join(import.meta.dir, "fixtures/tty-backlog-probe.ts");

describe.skipIf(process.platform === "win32")("ProcessTerminal output backlog over a live pump", () => {
	it("reports no backlog once the pump thread has written the frame", async () => {
		const session = new PtySession();
		let output = "";
		const result = await session.startArgv(
			{
				application: process.execPath,
				args: [PROBE],
				cwd: import.meta.dir,
				// The probe must not look like a test child, or the pump it
				// measures is never built (`isBunTestRuntime`).
				env: { ...process.env, PI_TEST_RUNTIME: "0", NODE_ENV: "", BUN_ENV: "" },
				cols: 100,
				rows: 30,
			},
			(error, chunk) => {
				if (!error) output += chunk;
			},
		);

		expect(result.exitCode).toBe(0);
		const probe = output.match(/PROBE enqueued=(\d+) pending=(\d+) ms=(\d+)/);
		if (!probe) throw new Error(`probe reported nothing: ${JSON.stringify(output.slice(-200))}`);
		// The writer really held the frame, below the level the old read
		// threshold refreshed at, and the backlog cleared from there.
		expect(Number(probe[1])).toBeGreaterThan(0);
		expect(Number(probe[1])).toBeLessThanOrEqual(256 * 1024);
		expect(Number(probe[2])).toBe(0);
	});
});
