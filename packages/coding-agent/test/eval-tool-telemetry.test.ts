import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

it.each(["direct", "kernels"])(
	"records eval tool telemetry through %s execution",
	async mode => {
		const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eval-spans-"));
		try {
			const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "eval-tool-telemetry-probe.ts"), mode], {
				cwd: fixture,
				env: {
					PATH: process.env.PATH ?? "",
					SystemRoot: process.env.SystemRoot,
					PI_CODING_AGENT_DIR: path.join(fixture, "agent"),
				},
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr, stdout }).toEqual({
				exitCode: 0,
				stderr: "",
				stdout: expect.stringContaining(`${mode}:`),
			});
		} finally {
			await fs.rm(fixture, { recursive: true, force: true });
		}
	},
	35_000,
);
