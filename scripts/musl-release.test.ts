import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

async function run(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("musl release artifacts", () => {
	test("builds the requested x64 and arm64 musl asset names with Bun's musl targets", async () => {
		const result = await run([
			"bun",
			"scripts/ci-release-build-binaries.ts",
			"--dry-run",
			"--targets",
			"linux-musl-x64,linux-musl-arm64",
		]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-x64-musl-baseline outfile=packages/coding-agent/binaries/omp-linux-musl-x64",
		);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-arm64-musl outfile=packages/coding-agent/binaries/omp-linux-musl-arm64",
		);
	});
});
