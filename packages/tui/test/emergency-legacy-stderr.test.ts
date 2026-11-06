import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A consumer that suppressed stderr through the released legacy guard before
// any TUI started leaves fd 2 owned by that guard. `emergencyTerminalRestore()`
// is the crash/signal cleanup path: diagnostics written after it must reach
// the terminal, so it must release the legacy guard too, not only the unified
// one.

describe.skipIf(process.platform === "win32")("emergencyTerminalRestore legacy stderr", () => {
	it("releases a legacy stderr guard so post-crash diagnostics reach the terminal", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "emergency-legacy-stderr-"));
		const chunks: Buffer[] = [];
		const terminalExited = Promise.withResolvers<void>();
		const child = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "fixtures/emergency-legacy-stderr-probe.ts"),
				root,
				path.join(root, "state.txt"),
			],
			{
				env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
				terminal: {
					data(_terminal, data) {
						chunks.push(Buffer.from(data));
					},
					exit() {
						terminalExited.resolve();
					},
				},
				timeout: 10_000,
			},
		);
		try {
			expect(await child.exited).toBe(0);
			await terminalExited.promise;
			expect(fs.readFileSync(path.join(root, "state.txt"), "utf8")).toContain("legacy=true");
			const output = Buffer.concat(chunks).toString("utf8");
			expect(output).toContain("emergency-marker");
			expect(output).not.toContain("suppressed-marker");
			const redirected = fs.readFileSync(path.join(root, "legacy-stderr.log"), "utf8");
			expect(redirected).toContain("suppressed-marker");
			expect(redirected).not.toContain("emergency-marker");
		} finally {
			child.kill();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
