import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findEnvrc, loadDirenvEnv } from "../../src/exec/direnv";
import { measure, type Samples } from "./sampling";

/** Only the generated fixtures are allowed, under the launcher's isolated XDG directories. */
export async function measureDirenv(fixture: string, runs: number, warmups: number) {
	const bin = Bun.which("direnv");
	if (!bin) throw new Error("The selected direnv binary is not available");
	async function command(args: string[], cwd: string): Promise<string> {
		const child = Bun.spawn([bin!, ...args], {
			cwd,
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`direnv ${args[0]} failed: ${stderr.trim()}`);
		return stdout.trim();
	}
	const version = await command(["version"], fixture);
	const rows: Array<Samples & { name: string }> = [];
	async function scenario(name: string, source?: string, allow = false) {
		const cwd = path.join(fixture, name);
		await fs.mkdir(cwd);
		if (source !== undefined) await Bun.write(path.join(cwd, ".envrc"), source);
		if (allow) await command(["allow", "."], cwd);
		return cwd;
	}
	const empty = await scenario("no-envrc");
	if ((await findEnvrc(empty)) !== null) throw new Error("Unexpected ancestor .envrc outside the benchmark fixture");
	const blocked = await scenario("blocked", "echo unsafe > ran\nexport OMP_LATENCY_VALUE=blocked\n");
	const simple = await scenario("allowed-simple", "export OMP_LATENCY_VALUE=ready\n", true);
	const watched = await scenario(
		"allowed-watched",
		'watch_file value.txt\nexport OMP_LATENCY_VALUE="$(cat value.txt)"\necho evaluated >> evaluations\n',
		true,
	);
	await Bun.write(path.join(watched, "value.txt"), "initial");
	for (const [name, cwd, expected] of [
		["no-envrc", empty, null],
		["blocked", blocked, null],
		["allowed-simple", simple, "ready"],
		["allowed-watched", watched, "initial"],
	] as const) {
		const samples = await measure(
			async () => {
				const result = await loadDirenvEnv(cwd);
				if (expected === null ? result !== null : result?.set.OMP_LATENCY_VALUE !== expected)
					throw new Error(`Unexpected export for ${name}`);
			},
			runs,
			warmups,
		);
		rows.push({ name, ...samples });
	}
	const unchangedEvaluations = (await Bun.file(path.join(watched, "evaluations")).text()).trim().split("\n").length;
	// Semantic checks are outside the timing windows: a stale cache would fail these.
	await Bun.write(path.join(watched, "value.txt"), "changed");
	const refreshed = await loadDirenvEnv(watched);
	if (refreshed?.set.OMP_LATENCY_VALUE !== "changed")
		throw new Error("Watched-file change was not reflected in the export");
	await command(["deny", "."], watched);
	const revoked = await loadDirenvEnv(watched);
	if (revoked?.set.OMP_LATENCY_VALUE !== undefined) throw new Error("Revoked .envrc approval was not respected");
	await Bun.write(path.join(simple, ".envrc"), "export OMP_LATENCY_VALUE=unapproved-change\n");
	if ((await loadDirenvEnv(simple)) !== null) throw new Error("Changed .envrc executed without renewed approval");
	if (await Bun.file(path.join(blocked, "ran")).exists()) throw new Error("Blocked fixture was executed");
	return {
		version,
		rows,
		unchangedEvaluations,
		watchedFileRefreshVerified: true,
		revokedApprovalBlockedVerified: true,
		changedEnvrcBlockedVerified: true,
		blockedFixtureNotExecuted: true,
	};
}
