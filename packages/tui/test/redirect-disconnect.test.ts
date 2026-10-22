import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A redirected-log write failure (ENOSPC/EIO on the process log) is not a
// terminal failure: the TUI's stdout error handler must not tear the UI down
// and SIGHUP the process when the guard reports a storage error. Only a
// failure of the terminal stream itself is a disconnect.

describe.skipIf(process.platform !== "linux")("redirected write errors vs terminal disconnect", () => {
	it("keeps the terminal alive when the log target rejects writes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "redirect-disconnect-"));
		const state = path.join(root, "state.txt");
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "fixtures/redirect-disconnect-probe.ts"), state],
			{
				env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
				terminal: {},
				timeout: 10_000,
			},
		);
		try {
			const exitCode = await child.exited;
			expect(exitCode).toBe(0);
			const body = fs.existsSync(state) ? fs.readFileSync(state, "utf8") : "(no state)";
			const lines = Object.fromEntries(
				body
					.split("\n")
					.filter(Boolean)
					.map(line => line.split("=") as [string, string]),
			);
			expect(lines["suppressed-start"]).toBe("true");
			expect(lines["write-returned"]).toBe("false");
			expect(lines["suppressed-after"]).toBe("true");
			expect(lines["stopped-cleanly"]).toBe("true");
		} finally {
			child.kill();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the UI alive when the redirected log target rejects stderr writes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "redirect-stderr-crash-"));
		const state = path.join(root, "state.txt");
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "fixtures/redirect-stderr-crash-probe.ts"), state],
			{
				env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
				terminal: {},
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
			expect(lines["suppressed-start"]).toBe("true");
			expect(lines["write-returned"]).toBe("false");
			expect(lines["suppressed-after"]).toBe("true");
			expect(lines["stopped-cleanly"]).toBe("true");
		} finally {
			child.kill();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("installs stream error handlers before a deferred start returns", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-start-redirect-"));
		const state = path.join(root, "state.txt");
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "fixtures/deferred-start-redirect-probe.ts"), state],
			{
				env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
				terminal: {},
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
			expect(lines["suppressed-start"]).toBe("true");
			expect(lines["write-returned"]).toBe("false");
			expect(lines["suppressed-after"]).toBe("true");
			expect(lines["stopped-cleanly"]).toBe("true");
		} finally {
			child.kill();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
