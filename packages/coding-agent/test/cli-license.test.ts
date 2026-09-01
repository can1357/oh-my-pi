import { expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");

it("prints the embedded OMP license and aggregate notices on the exact top-level flag path", async () => {
	const proc = Bun.spawn([process.execPath, cliEntry, "--license"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr, license, notices] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		Bun.file(path.join(repoRoot, "LICENSE")).text(),
		Bun.file(path.join(repoRoot, "THIRD-PARTY-NOTICES.txt")).text(),
	]);

	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(stdout).toBe(`OMP License and Third-Party Notices\n\n${license.trimEnd()}\n\n${notices.trimEnd()}\n`);
});
