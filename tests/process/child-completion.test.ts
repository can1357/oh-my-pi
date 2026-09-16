import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Shell } from "../../packages/natives/native/index.js";

// A host signal listener and the native shell share one process. Keep the
// real signal registration in a child so other tests retain their handlers.
test.skipIf(process.platform !== "darwin")(
	"native shell collects child exits alongside the Bun host",
	async () => {
		if (process.env.OMP_CHILD_COMPLETION_PROBE !== "1") {
			const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
				env: { ...process.env, OMP_CHILD_COMPLETION_PROBE: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [status, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(status, stdout + stderr).toBe(0);
			return;
		}
		const cwd = fileURLToPath(new URL("../../", import.meta.url));
		const shell = new Shell();
		const warmup = await shell.run({ command: "/usr/bin/true", cwd, timeoutMs: 2_000 });
		expect(warmup.exitCode).toBe(0);
		const host = Bun.spawn([process.execPath, "--version"], { stdout: "pipe", stderr: "pipe" });
		expect(await host.exited).toBe(0);
		process.on("SIGCHLD", () => {});
		const waited = await shell.run({ command: "/bin/sleep 0.1", cwd, timeoutMs: 2_000 });
		expect(waited.exitCode).toBe(0);
		let output = "";
		const success = await shell.run(
			{ command: "/bin/echo child-completed", cwd, timeoutMs: 2_000 },
			(error, chunk) => {
				if (error) throw error;
				output += chunk;
			},
		);
		expect(success.exitCode).toBe(0);
		expect(output.trim()).toBe("child-completed");
		const failure = await shell.run({ command: "/usr/bin/false", cwd, timeoutMs: 2_000 });
		expect(failure.exitCode).toBe(1);
	},
	10_000,
);
