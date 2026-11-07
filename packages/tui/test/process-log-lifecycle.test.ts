import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("ProcessTerminal canonical diagnostic lifecycle", () => {
	it.skipIf(process.platform !== "linux").each([
		["default", "rotates the default log without structured records"],
		["cold", "rotates a cold custom log and follows configuration replacement without records"],
		["warm", "shares a warm custom structured log"],
		["rejected", "keeps canonical rotation after a rejected explicit redirect"],
		["recovery", "rolls back rejected handoffs and recovers from a failed old log destination"],
		["retired", "preserves buffered records across a blocked-rollover handoff"],
		["guard-retry", "keeps raw and structured writers together across a failed guard handoff and retries rotation"],
		["disabled", "bounds raw diagnostics with structured files disabled"],
	])(
		"%s: %s, including nested stop and restart",
		async (mode, _description) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-log-lifecycle-"));
			const chunks: Buffer[] = [];
			const child = Bun.spawn(
				[process.execPath, path.resolve(import.meta.dir, "fixtures/process-log-lifecycle-probe.ts"), root, mode],
				{
					cwd: root,
					env: {
						HOME: root,
						TMPDIR: root,
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						TERM: "xterm-256color",
						PI_TEST_RUNTIME: "1",
						BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
					},
					terminal: {
						data(_terminal, data) {
							chunks.push(Buffer.from(data));
						},
					},
					timeout: 20_000,
				},
			);
			try {
				expect(await child.exited, Buffer.concat(chunks).toString("utf8")).toBe(0);
				expect(fs.readFileSync(path.join(root, "result.txt"), "utf8")).toBe("passed\n");
			} finally {
				child.terminal?.close();
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
		25_000,
	);
});
