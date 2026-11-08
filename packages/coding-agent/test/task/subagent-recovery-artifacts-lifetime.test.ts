import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOST = path.resolve(import.meta.dir, "../fixtures/recovery-artifacts-host.ts");

for (const mode of ["exit", "owner"] as const) {
	it(`keeps unapplied isolated work readable after ${mode === "exit" ? "host exit" : "owner disposal and host exit"}`, async () => {
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
			const result = JSON.parse(line!.slice(7)) as { patchPath: string; patch: string };
			// A second process must still be able to recover the unapplied work.
			expect(await Bun.file(result.patchPath).text()).toBe(result.patch);
			expect(await Bun.file(path.join(root, "project/file.txt")).text()).toBe("original\n");
		} finally {
			clearTimeout(deadline);
			child.kill("SIGKILL");
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 60_000);
}
