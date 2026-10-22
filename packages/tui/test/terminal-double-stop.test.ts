import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Two ProcessTerminals share the reference-counted output guard. When one
// instance is stopped twice — emergency cleanup followed by its owner's
// normal teardown — the second stop must not release the surviving
// instance's acquisition: fd 1/2 stay isolated until that instance stops,
// otherwise unmanaged output corrupts its live frame.

describe.skipIf(process.platform === "win32")("ProcessTerminal double stop", () => {
	for (const order of [
		"older",
		"newest",
		"emergency",
		"deferred",
		"older-deferred",
		"kitty",
		"modify",
		"kitty-private",
	] as const) {
		it(
			order === "emergency"
				? "restores every overlapping owner during emergency shutdown"
				: order === "kitty"
					? "balances negotiated Kitty frames when a deferred owner survives and later enables input"
					: order === "deferred"
						? "restores cooked input to a deferred survivor and its final shell after enabling input"
						: `preserves the survivor's modes, input and ordered control output when the ${order} owner stops twice`,
			async () => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-double-stop-"));
				const state = path.join(root, "state.txt");
				const chunks: Buffer[] = [];
				const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
				delete env.PI_TEST_RUNTIME;
				delete env.BUN_ENV;
				delete env.NODE_ENV;
				delete env.SSH_CONNECTION;
				delete env.SSH_CLIENT;
				delete env.SSH_TTY;
				const child = Bun.spawn(
					[
						process.execPath,
						path.resolve(import.meta.dir, "fixtures/terminal-double-stop-probe.ts"),
						state,
						order,
					],
					{
						env,
						terminal: {
							data(_terminal, data) {
								chunks.push(Buffer.from(data));
							},
						},
						timeout: 10_000,
					},
				);
				try {
					expect(await child.exited).toBe(0);
					const lines = Object.fromEntries(
						fs
							.readFileSync(state, "utf8")
							.split("\n")
							.filter(Boolean)
							.map(line => line.split("=") as [string, string]),
					);
					if (order === "emergency") {
						expect(lines["emergency-isolated"]).toBe("false");
						expect(lines["emergency-raw"]).toBe("false");
						expect(Buffer.concat(chunks).toString()).toContain("EMERGENCY_BOTH_RESTORED");
						return;
					}
					expect(lines["after-start"]).toBe("true");
					expect(lines["after-first-stop"]).toBe("true");
					expect(lines["after-double-stop"]).toBe("true");
					expect(lines["after-final-stop"]).toBe("false");
					const deferred =
						order === "deferred" ||
						order === "older-deferred" ||
						order === "kitty" ||
						order === "modify" ||
						order === "kitty-private";
					expect(lines["survivor-raw"]).toBe(deferred ? "false" : "true");
					expect(lines["final-raw"]).toBe("false");
					expect(lines["survivor-paused"]).toBe(deferred ? "true" : "false");
					if (deferred && order !== "modify") expect(lines["enabled-raw"]).toBe("true");
					const stream = Buffer.concat(chunks).toString();
					if (order === "modify") {
						expect(lines["newest-enhancement"]).toBe(JSON.stringify("\x1b[>4;2m"));
						const gracefulStop = stream.slice(0, stream.indexOf("MODIFY_OWNERS_STOPPED"));
						expect(gracefulStop.match(/\x1b\[>4;2m/g)?.length).toBe(1);
						expect(gracefulStop.match(/\x1b\[>4;0m/g)?.length).toBe(1);
					}
					if (order === "kitty" || order === "kitty-private") {
						expect(lines["newest-kitty"]).toBe("true");
						const stopped = stream.indexOf("KITTY_OWNERS_STOPPED");
						expect(stopped).toBeGreaterThan(0);
						const gracefulStop = stream.slice(0, stopped);
						expect(gracefulStop.match(/\x1b\[>5u/g)?.length).toBe(2);
						expect(gracefulStop.match(/\x1b\[<u/g)?.length).toBe(2);
					}
					const begin = stream.indexOf("\x1b]0;STOP_OWNER_BEGIN\x07");
					const end = stream.indexOf("\x1b]0;STOP_OWNER_END\x07");
					expect(begin).toBeGreaterThanOrEqual(0);
					expect(end).toBeGreaterThan(begin);
					const olderStop = stream.slice(begin, end);
					expect(olderStop).toContain("\x1b]0;SURVIVING_OWNER_SEQUENCE\x07");
					expect(olderStop).not.toContain("\x1b[?2004l");
					expect(olderStop).not.toContain("\x1b[?1006l");
					expect(olderStop).not.toContain("\x1b[?2031l");
				} finally {
					child.kill();
					fs.rmSync(root, { recursive: true, force: true });
				}
			},
		);
	}
});
