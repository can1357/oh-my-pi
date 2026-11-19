import { expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const noticeOwners = ["coding-agent", "natives"];

it("prints the OMP license with the CLI and native addon notices on the exact top-level flag path", async () => {
	const proc = Bun.spawn([process.execPath, cliEntry, "--license"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr, license, ...notices] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		Bun.file(path.join(repoRoot, "packages/coding-agent/LICENSE")).text(),
		...noticeOwners.map(dir => Bun.file(path.join(repoRoot, "packages", dir, "THIRD-PARTY-NOTICES.txt")).text()),
	]);

	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	const sections = [license, ...notices].map(text => text.trimEnd());
	expect(stdout).toBe(`OMP License and Third-Party Notices\n\n${sections.join("\n\n")}\n`);
});
