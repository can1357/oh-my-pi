import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOST = path.resolve(import.meta.dir, "../fixtures/overlapping-recovery-host.ts");
for (const mode of ["root-before", "nested-before", "root-after", "nested-after", "unchanged-before", "unchanged-after"]) {
	it(`settles only the applied capture, independently of release: ${mode}`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-overlapping-recovery-"));
		const child = Bun.spawn([process.execPath, HOST, mode], {
			cwd: path.resolve(import.meta.dir, "../../../.."),
			env: { ...process.env, PROBE_ROOT: root, TMPDIR: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), HOME: path.join(root, "home") },
			stdin: "ignore", stdout: "pipe", stderr: "pipe",
		});
		// Separate-process kill switch; fake timers cannot terminate a stuck host.
		const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect(exitCode, stderr).toBe(0);
			const line = stdout.split("\n").find(entry => entry.startsWith("RESULT "));
			expect(line, stdout).toBeDefined();
			const result = JSON.parse(line!.slice(7)) as { artifactsDir: string; patchPath: string; patch: string; changed: boolean };
			if (result.changed) {
				// The child and isolated tree are gone: the bytes must survive normal exit.
				expect(await Bun.file(result.patchPath).text()).toBe(result.patch);
				expect(result.patch).toContain(mode.startsWith("nested") ? "+late unique nested recovery" : "+late unique recovery");
			} else {
				expect(await fs.stat(result.artifactsDir).then(() => true, () => false)).toBe(false);
			}
		} finally {
			clearTimeout(deadline);
			child.kill("SIGKILL");
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 60_000);
}
