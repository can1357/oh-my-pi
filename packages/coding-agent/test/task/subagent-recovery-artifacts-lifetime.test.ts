import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOST = path.resolve(import.meta.dir, "../fixtures/recovery-artifacts-host.ts");

for (const mode of [
	"exit",
	"owner",
	"applied",
	"applied-exit",
	"applied-live",
	"nested-exit",
	"nested-owner",
	"nested-mixed",
	"empty",
] as const) {
	it(`releases applied or empty leases and keeps unapplied recovery: ${mode}`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recovery-lifetime-"));
		const child = Bun.spawn([process.execPath, HOST, mode], {
			cwd: path.resolve(import.meta.dir, "../../../.."),
			env: {
				...process.env,
				PROBE_ROOT: root,
				TMPDIR: root,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				HOME: path.join(root, "home"),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Kill switch for a separate process; fake timers cannot terminate it.
		const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const line = stdout.split("\n").find(entry => entry.startsWith("RESULT "));
			expect(line, stdout).toBeDefined();
			const result = JSON.parse(line!.slice(7)) as {
				artifactsDir: string;
				patchPath: string;
				patch: string;
				afterOwnerExists: boolean;
			};
			const disposable = mode.startsWith("applied") || mode === "empty";
			if (disposable) {
				if (mode !== "applied-exit") expect(result.afterOwnerExists).toBe(false);
				expect(
					await fs.stat(result.artifactsDir).then(
						() => true,
						() => false,
					),
				).toBe(false);
			} else {
				// Read from outside the exited host, after every registered owner left.
				expect(await Bun.file(result.patchPath).text()).toBe(result.patch);
			}
			expect(await Bun.file(path.join(root, "project/file.txt")).text()).toBe(
				mode.startsWith("applied") || mode === "nested-mixed" ? "recovered unique work\n" : "original\n",
			);
		} finally {
			clearTimeout(deadline);
			child.kill("SIGKILL");
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 60_000);
}
