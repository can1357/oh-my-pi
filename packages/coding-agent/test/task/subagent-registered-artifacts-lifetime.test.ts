import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

for (const mode of ["agent", "pool"] as const) {
	it(`${mode} output and cold revival survive job eviction until the worker is unregistered`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-registered-lifetime-"));
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "../fixtures/registered-artifacts-host.ts"), mode],
			{
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
			},
		);
		// Kill switch for a separate process; fake timers cannot terminate it.
		const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		} finally {
			clearTimeout(deadline);
			child.kill("SIGKILL");
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 60_000);
}
