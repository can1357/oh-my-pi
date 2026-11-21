import { expect, it } from "bun:test";
import * as path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");

async function runTypechecker(...options: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(
		[process.execPath, "check", "--no-script", "--no-pretty", "-p", "tsconfig.json", ...options],
		{
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

it("includes published examples in the package typecheck without their private dependencies", async () => {
	const result = await runTypechecker("--listFilesOnly");
	expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

	const files = result.stdout.split("\n");
	expect(files).toContain(path.join(packageRoot, "examples/sdk/02-custom-model.ts"));
	expect(files).not.toContain(path.join(packageRoot, "examples/extensions/with-deps/index.ts"));
}, 30000);
