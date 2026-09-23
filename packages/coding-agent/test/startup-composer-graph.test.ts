import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const pkgRoot = path.resolve(import.meta.dir, "..");

async function importedModules(entry: string): Promise<string[]> {
	const probe = `await import(${JSON.stringify(path.join(pkgRoot, entry))});
		const reg = typeof Loader !== "undefined" && Loader.registry ? [...Loader.registry.keys()] : Object.keys(require.cache);
		console.log(JSON.stringify(reg));`;
	const proc = Bun.spawn([process.execPath, "-e", probe], { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, err).toBe(0);
	return JSON.parse(out.trim().split("\n").at(-1)!);
}

function expectGraphExcludes(modules: string[], forbidden: RegExp[]): void {
	const violations = modules.filter(module => forbidden.some(pattern => pattern.test(module)));
	expect(violations).toEqual([]);
}

describe("startup composer prepaint graph", () => {
	it("keeps CLI bootstrap isolated from command, worker, provider, and failure-runtime graphs", async () => {
		const modules = await importedModules("src/cli.ts");

		// Positive controls: the entry and its bootstrap-only selector table were evaluated.
		expect(modules.some(module => module.endsWith("/src/cli.ts"))).toBe(true);
		expect(modules.some(module => module.includes("/cli/worker-selectors"))).toBe(true);
		expectGraphExcludes(modules, [
			/commands\/launch/,
			/eval\/js\/worker-core/,
			/eval\/js\/shared\/runtime/,
			/eval\/preludes/,
			/tools\/browser\/aria/,
			/provider-models/,
			/providers\/.*auth/,
			/modes\/interactive-mode/,
			/postmortem/,
			/node:inspector/,
			/node:readline/,
			/node:worker_threads/,
			/omptype/,
		]);
	});
});
